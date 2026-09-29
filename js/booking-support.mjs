// Pure, DOM-free helpers for js/booking.mjs — kept in their own module (no
// top-level `document` access) so they're directly unit-testable in Node
// (see tests/booking-support.test.mjs), unlike booking.mjs itself which
// wires up the live page at import time.

// Resolves/rejects like `promise`, but rejects early with a timeout Error if
// `promise` hasn't settled within `ms`. Always observes the original
// promise's eventual settlement (via .then), so a late resolve/reject after
// the timeout never becomes an unhandled rejection.
export function withTimeout(promise, ms, message = 'timed out') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Whether a background availability refresh may overwrite the booking
// status line's current text with one of its own messages (e.g. "Checking
// availability…", "No openings…"). The line may already
// hold a submit-outcome message (success/taken/too-many/error) set directly
// by a form submission or a deliberate user interaction — a background
// refresh (triggered by a realtime broadcast, or the one that follows a
// submission) must never silently erase that.
export function canOverwriteStatus(current, ownMessages) {
  return current === '' || ownMessages.includes(current);
}

// A per-key async cache safe against invalidation racing an in-flight fetch:
// if `invalidate(key)` runs while a fetch for that key is still pending, the
// stale fetch's eventual result is (a) never written to the cache and (b)
// never handed to a caller that asks for `key` after the invalidation — that
// caller gets a fresh fetch instead. Without this, a slow fetch started
// before a change (a booking, a realtime broadcast) can resolve after the
// change and silently overwrite the cache with pre-change data.
//
// `fetcher(key)` is called at most once per (key, generation) pair; callers
// asking for the same (key, generation) while a fetch is already in flight
// share its promise instead of triggering a duplicate call.
export function createGenerationalCache(fetcher) {
  const cache = new Map(); // key -> value
  const generations = new Map(); // key -> generation number, bumped by invalidate()
  const inFlight = new Map(); // key -> { generation, promise }

  function generationOf(key) {
    return generations.get(key) || 0;
  }

  async function get(key) {
    if (cache.has(key)) return cache.get(key);

    const generation = generationOf(key);
    const existing = inFlight.get(key);
    if (existing && existing.generation === generation) return existing.promise;

    const promise = (async () => {
      const value = await fetcher(key);
      // Only cache the result if nothing invalidated this key while we waited.
      if (generationOf(key) === generation) cache.set(key, value);
      return value;
    })();
    inFlight.set(key, { generation, promise });
    try {
      return await promise;
    } finally {
      // Only clear our own in-flight entry — a newer fetch (started after an
      // invalidation bumped the generation) may already have replaced it.
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    }
  }

  function invalidate(key) {
    cache.delete(key);
    generations.set(key, generationOf(key) + 1);
    // The in-flight entry (if any) is left running — it can't be cancelled —
    // but its generation is now stale, so get() won't reuse it and its
    // eventual result won't be cached (both checked above).
  }

  function clear() {
    cache.clear();
    generations.clear();
    inFlight.clear();
  }

  // Seeds the cache directly with an already-fetched value (e.g. a result
  // obtained for another purpose, like a connectivity check) without going
  // through fetcher().
  function set(key, value) {
    cache.set(key, value);
  }

  return { get, invalidate, clear, set };
}

// Whether a "the customer came back to the page" refresh (window focus /
// tab visible again) should refetch availability: only if the last applied
// refresh is at least `minGapMs` old (or there never was one), so rapid
// focus/blur churn doesn't make the time list flicker.
export function resumeRefreshDue(lastRefreshAt, now, minGapMs) {
  if (!lastRefreshAt) return true;
  return now - lastRefreshAt >= minGapMs;
}

// True when the page is served from this computer or the home/salon network
// (localhost, 127.x, 10.x, 172.16–31.x, 192.168.x) — i.e. someone testing,
// not a customer on the real site. js/booking.mjs skips Web3Forms there so
// test requests don't use up the monthly email quota.
export function isTestHost(hostname) {
  if (hostname === 'localhost') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Same rule request_appointment enforces (at least 10 digits, ignoring
// spaces/dashes/brackets/+), checked before submit so a short number gets a
// message on the Phone box instead of a generic "couldn't send" error.
export function phoneLooksValid(phone) {
  return phone.replace(/\D/g, '').length >= 10;
}
