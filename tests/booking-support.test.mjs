import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, canOverwriteStatus, createGenerationalCache, resumeRefreshDue, isTestHost, phoneLooksValid } from '../js/booking-support.mjs';

// A promise plus its resolve/reject, for sequencing concurrent fetches deterministically.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- withTimeout ------------------------------------------------------------

test('withTimeout resolves with the value when the promise settles first', async () => {
  const result = await withTimeout(Promise.resolve(42), 50);
  assert.equal(result, 42);
});

test('withTimeout propagates the original rejection when it settles first', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 50),
    /boom/
  );
});

test('withTimeout rejects with a timeout error when the promise never settles', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 15, 'took too long'),
    /took too long/
  );
});

test('withTimeout does not fire after an early resolve (no dangling rejection)', async () => {
  const slowButUnderBudget = new Promise((resolve) => setTimeout(() => resolve('ok'), 5));
  const result = await withTimeout(slowButUnderBudget, 50);
  assert.equal(result, 'ok');
  // give any (incorrectly) still-pending timer a chance to fire and blow up the process
  await new Promise((resolve) => setTimeout(resolve, 60));
});

// --- canOverwriteStatus -------------------------------------------------------

const OWN = ['Checking availability…', 'Nobody offers all of those together — choose fewer services or call (718) 392-8899.', 'No openings that day — try another date or call (718) 392-8899.'];

test('canOverwriteStatus allows overwriting an empty status', () => {
  assert.equal(canOverwriteStatus('', OWN), true);
});

test('canOverwriteStatus allows overwriting one of its own messages', () => {
  assert.equal(canOverwriteStatus('Checking availability…', OWN), true);
});

test('canOverwriteStatus refuses to overwrite a submit-outcome message', () => {
  assert.equal(canOverwriteStatus("Request received — this time is held for you. We'll call or text to confirm.", OWN), false);
  assert.equal(canOverwriteStatus('That time was just taken — here are the open times.', OWN), false);
  assert.equal(canOverwriteStatus('Sending your request…', OWN), false);
});

// --- createGenerationalCache --------------------------------------------------

test('caches a fetched value; a second get() does not call the fetcher again', async () => {
  let calls = 0;
  const cache = createGenerationalCache(async (key) => { calls += 1; return `value-${key}`; });
  assert.equal(await cache.get('a'), 'value-a');
  assert.equal(await cache.get('a'), 'value-a');
  assert.equal(calls, 1);
});

test('concurrent get() calls for the same key share one in-flight fetch', async () => {
  let calls = 0;
  const d = deferred();
  const cache = createGenerationalCache(async (key) => { calls += 1; return d.promise; });
  const p1 = cache.get('a');
  const p2 = cache.get('a');
  d.resolve('value-a');
  assert.deepEqual(await Promise.all([p1, p2]), ['value-a', 'value-a']);
  assert.equal(calls, 1);
});

test('different keys fetch independently', async () => {
  let calls = 0;
  const cache = createGenerationalCache(async (key) => { calls += 1; return `value-${key}`; });
  assert.equal(await cache.get('a'), 'value-a');
  assert.equal(await cache.get('b'), 'value-b');
  assert.equal(calls, 2);
});

test('invalidate() during an in-flight fetch: a late-arriving stale result is neither cached nor reused', async () => {
  // Fetch #1 for 'a' starts and hangs. While it's in flight, the key is
  // invalidated (as booking.mjs does after its own successful booking or a
  // realtime broadcast). A new get('a') call must not reuse fetch #1 — it
  // starts its own fetch #2. When fetch #1 finally resolves (stale), its
  // value must not overwrite the cache; fetch #2's (fresh) value must win.
  const first = deferred();
  const second = deferred();
  const fetches = [first, second];
  let calls = 0;
  const cache = createGenerationalCache(async () => {
    const d = fetches[calls];
    calls += 1;
    return d.promise;
  });

  const p1 = cache.get('a'); // fetch #1 starts, hangs on `first`
  await Promise.resolve(); // let the fetcher call happen
  cache.invalidate('a'); // bumps the generation while fetch #1 is still pending
  const p2 = cache.get('a'); // must start a fresh fetch #2, not reuse fetch #1

  assert.equal(calls, 2, 'invalidation must force a fresh fetch rather than reusing the stale in-flight one');

  second.resolve('fresh');
  assert.equal(await p2, 'fresh');

  first.resolve('stale'); // fetch #1 resolves late, after the invalidation
  assert.equal(await p1, 'stale', 'a caller already attached to the stale fetch still gets its own result');

  // The stale result must not have clobbered the cache: a subsequent get()
  // returns the fresh cached value without firing another fetch.
  assert.equal(await cache.get('a'), 'fresh');
  assert.equal(calls, 2);
});

test('invalidate() on an untouched key is a safe no-op', async () => {
  const cache = createGenerationalCache(async (key) => `value-${key}`);
  assert.doesNotThrow(() => cache.invalidate('never-fetched'));
  assert.equal(await cache.get('never-fetched'), 'value-never-fetched');
});

test('set() seeds the cache without calling the fetcher', async () => {
  let calls = 0;
  const cache = createGenerationalCache(async (key) => { calls += 1; return `value-${key}`; });
  cache.set('a', 'seeded');
  assert.equal(await cache.get('a'), 'seeded');
  assert.equal(calls, 0);
});

test('clear() forces every key to be re-fetched', async () => {
  let calls = 0;
  const cache = createGenerationalCache(async (key) => { calls += 1; return `value-${key}`; });
  await cache.get('a');
  cache.clear();
  await cache.get('a');
  assert.equal(calls, 2);
});

// --- resumeRefreshDue -------------------------------------------------------

test('resumeRefreshDue: due once the gap has passed, or if never refreshed', () => {
  assert.equal(resumeRefreshDue(0, 1000, 60000), true);
  assert.equal(resumeRefreshDue(null, 1000, 60000), true);
  assert.equal(resumeRefreshDue(100000, 130000, 60000), false);
  assert.equal(resumeRefreshDue(100000, 160000, 60000), true);
});

test('isTestHost: this computer and the home network are test hosts, the real site is not', () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.0.145', '10.0.0.5', '172.16.4.2', '172.31.255.1']) {
    assert.equal(isTestHost(h), true, h);
  }
  for (const h of ['nailclubspany.github.io', '172.32.0.1', '8.8.8.8', '192.169.0.1', '']) {
    assert.equal(isTestHost(h), false, h);
  }
});

test('phoneLooksValid needs at least 10 digits, like request_appointment', () => {
  for (const p of ['718-555-0100', '(718) 555 0100', '+1 718 555 0100', '7185550100']) {
    assert.equal(phoneLooksValid(p), true, p);
  }
  for (const p of ['1324', '555-0100', '', '   ']) {
    assert.equal(phoneLooksValid(p), false, p);
  }
});
