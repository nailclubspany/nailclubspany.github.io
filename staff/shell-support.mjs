// Pure helpers for the staff app shell (staff/app.mjs). No DOM, no network,
// no CDN import — so node tests can import them directly.

// A tiny listener registry. `add(cb)` returns an idempotent unsubscribe;
// `emit(...args)` calls every listener registered at that moment (a
// listener removed mid-emit is skipped), and one listener throwing never
// stops the rest.
export function createListenerSet() {
  const listeners = new Set();
  return {
    add(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(...args) {
      for (const cb of [...listeners]) {
        if (!listeners.has(cb)) continue;
        try {
          cb(...args);
        } catch (err) {
          console.error(err);
        }
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

// What the shell should do for an auth state change, given the user id it
// last rendered for (`undefined` before the first callback, `null` while
// signed out) and the callback's session:
//   'shell'  - signed in (or a different user signed in): render the app
//   'signin' - signed out: render the sign-in form
//   'none'   - nothing changed for us (TOKEN_REFRESHED, or the SIGNED_IN
//              auth-js emits for the same user when a hidden tab becomes
//              visible) — leave the screen alone so an open editor or
//              confirm form isn't wiped.
export function authAction(prevUserId, session) {
  const userId = session?.user?.id ?? null;
  if (userId === prevUserId) return 'none';
  return userId ? 'shell' : 'signin';
}
