'use client';

import { createContext, useContext, useRef, useEffect, useCallback } from 'react';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { usePlayerStore } from '@/store/player.store';
import { useAuth } from '@/components/providers/auth-provider';
import { BRAND } from '@/lib/brand';
import type { Track } from '@mindset/types';

// Signed-OUT listeners get a 1-minute preview of every episode; signing in
// unlocks full playback. Enforced in the timeupdate handler and in resume().
const PREVIEW_SECONDS = 60;

interface AudioPlayerContextValue {
  play: (track: Track, queue?: Track[]) => void;
  pause: () => void;
  resume: () => void;
  skipNext: () => void;
  skipPrev: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  toggleMute: () => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  setSleepTimer: (minutes: number | null) => void;
  addToQueue: (track: Track) => void;
  /** Stop playback and dismiss the player entirely. */
  close: () => void;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

/**
 * Stable per-browser id so anonymous listeners can be told apart in analytics
 * without any tracking cookie. Lives in localStorage; regenerating it just
 * counts that browser as a new listener.
 *
 * Storage can throw (site data blocked, some private modes). That used to land
 * in play()'s catch, so nothing played and nothing said why. A per-tab id is
 * the fallback — playback must never depend on analytics.
 */
let memoryListenerId: string | null = null;
function listenerSessionId(): string {
  if (typeof window === 'undefined') return '';
  const KEY = 'mm-listener-session';
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    memoryListenerId ??= crypto.randomUUID();
    return memoryListenerId;
  }
}

/**
 * Where this visit came from: document.referrer as it was on the first page of
 * the tab's session. The player's own requests always carry this site as their
 * Referer, so the stream route cannot see the real source itself. Kept for the
 * session because client-side navigation does not update document.referrer.
 */
function landingReferrer(): string {
  if (typeof window === 'undefined') return '';
  const KEY = 'mm-landing-ref';
  try {
    let ref = window.sessionStorage.getItem(KEY);
    if (ref === null) {
      ref = document.referrer || '';
      window.sessionStorage.setItem(KEY, ref);
    }
    return ref;
  } catch {
    return document.referrer || '';
  }
}

/** Live store state. Handlers registered once must read this, not a render's snapshot. */
const live = () => usePlayerStore.getState();

export function AudioPlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Only what the provider itself renders; everything else is read live.
  const previewEnded = usePlayerStore((s) => s.previewEnded);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const { user } = useAuth();
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // The timeupdate listener is registered once, so it would close over a stale
  // `user`. A ref keeps the signed-in state current inside that callback.
  const isSignedInRef = useRef(false);
  // Analytics for the episode currently playing.
  const playEventRef = useRef<string | null>(null);
  const reportedRef = useRef(0);
  // Seconds of the current episode actually played, and where the playhead was
  // on the last timeupdate. Progress used to report the playhead position, so
  // seeking to the end counted as a full listen and pressing "previous" wiped
  // twenty heard minutes back to zero.
  const heardRef = useRef(0);
  const lastPosRef = useRef(0);
  // Each play() call takes a ticket; a slower, older call that resolves after a
  // newer one must not take over the player.
  const playTicketRef = useRef(0);
  // Handlers registered once (audio 'ended', lock-screen controls) call these
  // through refs so they always run the current implementation.
  const skipNextRef = useRef<() => void>(() => {});
  const skipPrevRef = useRef<() => void>(() => {});
  const recoverRef = useRef<() => void>(() => {});
  // When the URL was last replaced after an error, so a file that is genuinely
  // broken fails once instead of re-requesting a URL in a loop.
  const recoveredAtRef = useRef(0);
  const pathname = usePathname();

  useEffect(() => {
    isSignedInRef.current = !!user;
  }, [user]);

  // Read on first load, before client-side navigation can matter.
  useEffect(() => {
    landingReferrer();
  }, []);

  /** Sends how much the listener has heard. Throttled to once per 15s of playback. */
  const reportProgress = useCallback((force = false) => {
    const eventId = playEventRef.current;
    if (!eventId) return;
    const whole = Math.floor(heardRef.current);
    if (!force && whole - reportedRef.current < 15) return;
    reportedRef.current = whole;

    const payload = JSON.stringify({ eventId, listenedSeconds: whole });
    // sendBeacon survives the page being closed mid-episode.
    if (force && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/play-progress', new Blob([payload], { type: 'application/json' }));
      return;
    }
    void fetch('/api/play-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* analytics must never break playback */
    });
  }, []);

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    lock?.release().catch(() => {});
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    // One lock at a time: every resume used to take a new one and none were
    // ever released, so the screen stayed on after pausing.
    releaseWakeLock();
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
    } catch {
      // Wake lock not supported or permission denied
    }
  }, [releaseWakeLock]);

  // Initialize audio element
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const audio = new Audio();
    audio.preload = 'metadata';
    // The saved volume and mute were shown in the UI but never applied, so a
    // listener who had turned it down got full volume after every reload.
    audio.volume = live().volume;
    audio.muted = live().isMuted;
    audioRef.current = audio;

    const unsubscribe = usePlayerStore.subscribe((s) => {
      if (audio.volume !== s.volume) audio.volume = s.volume;
      if (audio.muted !== s.isMuted) audio.muted = s.isMuted;
    });

    audio.addEventListener('timeupdate', () => {
      live().setCurrentTime(audio.currentTime);
      // Only small forward steps are listening; a jump is a seek.
      const step = audio.currentTime - lastPosRef.current;
      if (step > 0 && step < 5) heardRef.current += step;
      lastPosRef.current = audio.currentTime;
      reportProgress();
      // Preview limit is for signed-OUT listeners only.
      if (!isSignedInRef.current && audio.currentTime >= PREVIEW_SECONDS) {
        audio.pause();
        reportProgress(true);
        const s = live();
        s.setIsPlaying(false);
        if (!s.previewEnded) s.setPreviewEnded(true);
      }
    });

    audio.addEventListener('seeked', () => {
      lastPosRef.current = audio.currentTime;
    });

    audio.addEventListener('pause', () => reportProgress(true));

    // Catch listeners who close the tab mid-episode.
    const flush = () => reportProgress(true);
    window.addEventListener('pagehide', flush);

    audio.addEventListener('loadedmetadata', () => {
      live().setDuration(audio.duration);
    });

    // Read live: this listener is registered once, and the render-time store it
    // used to close over always had an empty queue and the page-load repeat
    // setting — so episodes never auto-advanced and the repeat toggle did nothing.
    audio.addEventListener('ended', () => {
      if (live().isRepeat) {
        audio.currentTime = 0;
        audio.play().catch(() => live().setIsPlaying(false));
      } else {
        skipNextRef.current();
      }
    });

    // The signed URL has a lifetime, and the browser keeps making range
    // requests against it as it plays and seeks. Past expiry (a long episode,
    // or one paused for hours) those are refused and the element errors out.
    audio.addEventListener('error', () => recoverRef.current());

    audio.addEventListener('waiting', () => live().setIsLoading(true));
    audio.addEventListener('canplay', () => live().setIsLoading(false));

    // Media Session API (lock screen, headphones, car controls)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        audio
          .play()
          .then(() => live().setIsPlaying(true))
          .catch(() => {});
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audio.pause();
        live().setIsPlaying(false);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => skipNextRef.current());
      navigator.mediaSession.setActionHandler('previoustrack', () => skipPrevRef.current());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          audio.currentTime = details.seekTime;
          live().setCurrentTime(details.seekTime);
        }
      });
    }

    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      audio.pause();
      audio.src = '';
    };
  }, [reportProgress]);

  const play = useCallback(
    async (track: Track, queue: Track[] = []) => {
      const audio = audioRef.current;
      if (!audio) return;
      const ticket = ++playTicketRef.current;

      try {
        // Flush the outgoing episode's progress before switching.
        reportProgress(true);

        // Queue and position first, so Next/Previous and "Up next" follow the
        // list the listener actually started from. queueIndex used to stay at
        // whatever it was, so playing the 5th of a playlist made Next play the 2nd.
        const s = live();
        if (queue.length) {
          const at = queue.findIndex((t) => t.id === track.id);
          s.setQueue(at === -1 ? [track, ...queue] : queue);
          s.setQueueIndex(at === -1 ? 0 : at);
        } else {
          const at = s.queue.findIndex((t) => t.id === track.id);
          if (at === -1) {
            s.setQueue([track]);
            s.setQueueIndex(0);
          } else {
            s.setQueueIndex(at);
          }
        }

        const response = await fetch(
          `/api/stream/${track.id}?sid=${encodeURIComponent(listenerSessionId())}&ref=${encodeURIComponent(landingReferrer())}`,
        );
        const { url, eventId } = await response.json().catch(() => ({}));
        if (ticket !== playTicketRef.current) return; // a newer play() won
        if (!url) {
          live().setIsLoading(false);
          live().setIsPlaying(false);
          toast.error(
            response.status === 404
              ? 'This episode is no longer available.'
              : 'Could not load this episode. Please try again.',
          );
          return;
        }
        recoveredAtRef.current = 0;

        playEventRef.current = eventId ?? null;
        reportedRef.current = 0;
        heardRef.current = 0;
        lastPosRef.current = 0;

        audio.src = url;
        audio.playbackRate = live().playbackSpeed;

        live().setCurrentTrack(track); // also resets previewEnded
        live().setIsLoading(true);

        await audio.play();
        if (ticket !== playTicketRef.current) return;
        // Only now: if the browser refused to play (autoplay policy), the UI
        // used to say "playing" over silence.
        live().setIsPlaying(true);
        await requestWakeLock();

        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.instructor_name ?? BRAND.shortName,
            album: BRAND.name,
            artwork: track.thumbnail_url
              ? [{ src: track.thumbnail_url, sizes: '512x512', type: 'image/jpeg' }]
              : [],
          });
          navigator.mediaSession.playbackState = 'playing';
        }
      } catch {
        if (ticket !== playTicketRef.current) return;
        live().setIsPlaying(false);
        live().setIsLoading(false);
      }
    },
    [reportProgress, requestWakeLock],
  );

  /**
   * Swaps in a fresh URL for the current episode after the element errored,
   * and carries on from the same position. ?refresh=1 keeps it the same play
   * in analytics.
   */
  const recover = useCallback(async () => {
    const audio = audioRef.current;
    const { currentTrack, currentTime, isPlaying } = live();
    // Errors after close() (src removed) or with nothing loaded are not failures.
    if (!audio || !currentTrack || !audio.getAttribute('src')) return;
    const ticket = playTicketRef.current;

    if (Date.now() - recoveredAtRef.current < 30_000) {
      live().setIsPlaying(false);
      live().setIsLoading(false);
      toast.error('This episode could not be played. Please try again later.');
      return;
    }
    recoveredAtRef.current = Date.now();

    try {
      const response = await fetch(
        `/api/stream/${currentTrack.id}?refresh=1&sid=${encodeURIComponent(listenerSessionId())}`,
      );
      const { url } = await response.json();
      if (!url || ticket !== playTicketRef.current) throw new Error('no url');
      audio.src = url;
      audio.playbackRate = live().playbackSpeed;
      audio.currentTime = currentTime;
      if (isPlaying) await audio.play();
    } catch {
      if (ticket !== playTicketRef.current) return;
      live().setIsPlaying(false);
      live().setIsLoading(false);
    }
  }, []);
  recoverRef.current = () => void recover();

  const pause = useCallback(() => {
    audioRef.current?.pause();
    live().setIsPlaying(false);
    releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }, [releaseWakeLock]);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    // Signed-out listeners cannot resume past the preview limit.
    if (!isSignedInRef.current && audio.currentTime >= PREVIEW_SECONDS) {
      live().setPreviewEnded(true);
      return;
    }
    try {
      await audio.play();
    } catch {
      live().setIsPlaying(false);
      return;
    }
    live().setIsPlaying(true);
    await requestWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }, [requestWakeLock]);

  const skipNext = useCallback(() => {
    const { queue, queueIndex, isShuffle } = live();
    let nextIndex = queueIndex + 1;
    if (isShuffle && queue.length > 1) {
      // A different episode, never a replay of the current one.
      nextIndex = Math.floor(Math.random() * (queue.length - 1));
      if (nextIndex >= queueIndex) nextIndex += 1;
    }

    if (nextIndex < queue.length) {
      live().setQueueIndex(nextIndex);
      void play(queue[nextIndex]);
    } else {
      live().setIsPlaying(false);
      releaseWakeLock();
    }
  }, [play, releaseWakeLock]);

  const skipPrev = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }

    const { queue, queueIndex } = live();
    const prevIndex = queueIndex - 1;
    if (prevIndex >= 0) {
      live().setQueueIndex(prevIndex);
      void play(queue[prevIndex]);
    }
  }, [play]);

  skipNextRef.current = skipNext;
  skipPrevRef.current = skipPrev;

  const seek = useCallback((seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    live().setCurrentTime(seconds);
  }, []);

  // The element follows the store through the subscription above.
  const setVolume = useCallback((volume: number) => live().setVolume(volume), []);
  const toggleMute = useCallback(() => live().setIsMuted(!live().isMuted), []);

  const setPlaybackSpeed = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
    live().setPlaybackSpeed(speed);
  }, []);

  const toggleRepeat = useCallback(() => live().setIsRepeat(!live().isRepeat), []);
  const toggleShuffle = useCallback(() => live().setIsShuffle(!live().isShuffle), []);
  const setSleepTimer = useCallback((minutes: number | null) => {
    live().setSleepTimer(minutes);
    live().setSleepTimerEndsAt(minutes ? Date.now() + minutes * 60 * 1000 : null);
  }, []);

  const addToQueue = useCallback((track: Track) => {
    const { queue } = live();
    if (!queue.some((t) => t.id === track.id)) live().setQueue([...queue, track]);
  }, []);

  const close = useCallback(() => {
    playTicketRef.current++; // abandon any play() still in flight
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // Reporting before the src is dropped, so the final position is recorded.
      reportProgress(true);
      audio.removeAttribute('src');
      audio.load();
    }
    live().setIsPlaying(false);
    live().clearQueue(); // also clears currentTrack, which hides the player
    releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }, [reportProgress, releaseWakeLock]);

  // Sleep timer effect
  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const remaining = sleepTimerEndsAt - Date.now();
    if (remaining <= 0) {
      pause();
      live().setSleepTimerEndsAt(null);
      return;
    }
    const timer = setTimeout(() => {
      pause();
      live().setSleepTimerEndsAt(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [sleepTimerEndsAt, pause]);

  return (
    <AudioPlayerContext.Provider
      value={{
        play,
        pause,
        resume,
        skipNext,
        skipPrev,
        seek,
        setVolume,
        setPlaybackSpeed,
        toggleMute,
        toggleRepeat,
        toggleShuffle,
        setSleepTimer,
        addToQueue,
        close,
      }}
    >
      {children}

      {previewEnded && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card rounded-3xl p-8 max-w-sm text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-primary/15 text-primary flex items-center justify-center mb-4">
              <Lock className="w-7 h-7" />
            </div>
            <h3 className="text-xl font-black text-foreground mb-2">Enjoying the preview?</h3>
            <p className="text-muted-foreground mb-6 text-sm">
              Sign in or create a free account to listen to the full episode.
            </p>
            <div className="flex flex-col gap-2">
              <Link
                href={`/auth/login?redirect=${encodeURIComponent(pathname || '/')}`}
                onClick={() => live().setPreviewEnded(false)}
                className="px-6 py-2.5 bg-primary text-white rounded-full font-semibold glow-primary"
              >
                Sign in
              </Link>
              <Link
                href="/auth/register"
                onClick={() => live().setPreviewEnded(false)}
                className="px-6 py-2.5 glass-card rounded-full font-semibold"
              >
                Create a free account
              </Link>
              <button
                type="button"
                onClick={() => live().setPreviewEnded(false)}
                className="px-6 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </AudioPlayerContext.Provider>
  );
}

export function useAudioPlayer() {
  const ctx = useContext(AudioPlayerContext);
  if (!ctx) throw new Error('useAudioPlayer must be used within AudioPlayerProvider');
  return ctx;
}
