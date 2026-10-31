// Client-side wrapper for calling a server action from a form.
//
// Server actions return `{ error }` for every failure they anticipate, but the
// call itself can still throw: the network drops, the proxy answers 502/504, or
// a redeploy retired the action id the open tab was built against ("Failed to
// find Server Action"). Unwrapped, that rejection skipped every form's
// `setLoading(false)` and left the button spinning forever with no message.

export const ACTION_FAILED = 'Something went wrong. Reload the page and try again.';

/**
 * Calls `action`, folding a thrown error into the same `{ error }` shape.
 *
 * Every action this wraps already has `{ error: string }` as one of its return
 * shapes, which is what makes the cast below honest.
 */
export async function runAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    console.error('[action] call failed:', err);
    return { error: ACTION_FAILED } as unknown as T;
  }
}
