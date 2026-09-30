import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { formatPhone, requestNotes, confirmPatch, formatDay, overlapMessage, confirmProviderOptions, createDeferredReload } from '../staff/requests.mjs';
import { layoutDay, columnClass, weekdayOf, clipToDay, parseTimeMinutes, createLoadSequencer, createForgetfulCache, tapMinute } from '../staff/calendar.mjs';
import { createListenerSet, authAction } from '../staff/shell-support.mjs';
import { apptPayload } from '../staff/booking-editor.mjs';
import { validateShifts, timeOptions, DEFAULT_SHIFT } from '../staff/schedules.mjs';
import { reorder } from '../staff/team.mjs';
import { t, lookup, STRINGS, getLang, setLang } from '../staff/i18n.mjs';

const html = readFileSync(new URL('../staff/index.html', import.meta.url), 'utf8');

test('staff page is noindex and loads app.mjs', () => {
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<script type="module" src="app\.mjs"><\/script>/);
  assert.ok(existsSync(new URL('../staff/app.mjs', import.meta.url)), 'staff/app.mjs must exist');
  assert.ok(existsSync(new URL('../staff/requests.mjs', import.meta.url)), 'staff/requests.mjs must exist');
  assert.ok(existsSync(new URL('../staff/calendar.mjs', import.meta.url)), 'staff/calendar.mjs must exist');
  assert.ok(existsSync(new URL('../staff/booking-editor.mjs', import.meta.url)), 'staff/booking-editor.mjs must exist');
  assert.ok(existsSync(new URL('../staff/schedules.mjs', import.meta.url)), 'staff/schedules.mjs must exist');
  assert.ok(existsSync(new URL('../staff/team.mjs', import.meta.url)), 'staff/team.mjs must exist');
});

test('formatPhone shows a US number as (718) 555-0100, anything else as typed', () => {
  assert.equal(formatPhone('7185550100'), '(718) 555-0100');
  assert.equal(formatPhone('+1 718-555-0100'), '(718) 555-0100');
  assert.equal(formatPhone('+44 20 7946 0958'), '+44 20 7946 0958');
  assert.equal(formatPhone(null), '');
});

test('confirmPatch adds length to starts_at, DST-safe via ISO ms math', () => {
  // 2026-11-01 is the DST fall-back day in America/New_York.
  const appt = { starts_at: '2026-11-01T14:00:00.000Z' };
  assert.deepEqual(confirmPatch(appt, 90, 3), {
    status: 'confirmed',
    staff_id: 3,
    ends_at: '2026-11-01T15:30:00.000Z',
  });
});

test('confirmPatch defaults nothing — caller supplies length and staff explicitly', () => {
  const appt = { starts_at: '2026-06-15T18:00:00.000Z' };
  assert.deepEqual(confirmPatch(appt, 60, 7), {
    status: 'confirmed',
    staff_id: 7,
    ends_at: '2026-06-15T19:00:00.000Z',
  });
});

test('formatDay reads the salon calendar date, not UTC', () => {
  assert.equal(formatDay('2026-11-01'), 'Sun, Nov 1');
});

test('overlapMessage matches the Task 5 wording exactly', () => {
  assert.equal(overlapMessage('Ann').en, 'That overlaps another appointment for Ann.');
});

// --- staff/calendar.mjs: layoutDay -----------------------------------------

const DAY = '2026-09-28';

test('parseTimeMinutes converts HH:MM:SS to minutes-of-day', () => {
  assert.equal(parseTimeMinutes('10:00:00'), 600);
  assert.equal(parseTimeMinutes('20:30:00'), 1230);
});

test('weekdayOf reads the salon weekday (0=Sun) off the calendar date', () => {
  assert.equal(weekdayOf('2026-09-28'), 1); // Monday
  assert.equal(weekdayOf('2026-11-01'), 0); // Sunday
});

test('clipToDay clips a UTC instant range to one salon day, in minutes', () => {
  assert.deepEqual(
    clipToDay('2026-09-28T14:00:00.000Z', '2026-09-28T15:00:00.000Z', '2026-09-28'),
    { start: 600, end: 660 }
  );
});

test('clipToDay clips a span crossing midnight to each day it touches', () => {
  // 2026-09-28T22:20 salon time through 2026-09-29T01:00 salon time (EDT, UTC-4).
  assert.deepEqual(
    clipToDay('2026-09-29T02:20:00.000Z', '2026-09-29T05:00:00.000Z', '2026-09-28'),
    { start: 1340, end: 1440 }
  );
  assert.deepEqual(
    clipToDay('2026-09-29T02:20:00.000Z', '2026-09-29T05:00:00.000Z', '2026-09-29'),
    { start: 0, end: 60 }
  );
});

test('layoutDay: blocks positioned by salon minutes', () => {
  const staff = [{ id: 1, name: 'Mia', active: true }];
  const hours = [{ staffId: 1, start: 600, end: 1200 }];
  const appts = [{ id: 101, staffId: 1, start: 660, end: 720, status: 'confirmed', day: DAY }];
  const result = layoutDay(staff, hours, [], appts, DAY);
  assert.equal(result.startMin, 600);
  assert.equal(result.endMin, 1200);
  assert.deepEqual(result.columns, [
    {
      staffId: 1,
      name: 'Mia',
      shifts: [{ top: 0, height: 600 }],
      off: [],
      blocks: [{ id: 101, top: 60, height: 60, status: 'confirmed' }],
    },
  ]);
});

test('layoutDay: appointment outside hours is still placed', () => {
  const staff = [{ id: 1, name: 'Mia', active: true }];
  const hours = [{ staffId: 1, start: 600, end: 1200 }];
  // 20:30 start, 60-min appt -> ends 21:30 (1290), past the default 1200 end.
  const appts = [{ id: 1, staffId: 1, start: 1230, end: 1290, status: 'pending', day: DAY }];
  const result = layoutDay(staff, hours, [], appts, DAY);
  assert.ok(result.endMin >= 1290, `expected endMin >= 1290, got ${result.endMin}`);
  const [col] = result.columns;
  assert.deepEqual(col.blocks, [{ id: 1, top: 1230 - result.startMin, height: 60, status: 'pending' }]);
});

test('layoutDay: declined/cancelled not shown', () => {
  const staff = [{ id: 1, name: 'Mia', active: true }];
  const hours = [{ staffId: 1, start: 600, end: 1200 }];
  const appts = [
    { id: 1, staffId: 1, start: 660, end: 720, status: 'declined', day: DAY },
    { id: 2, staffId: 1, start: 900, end: 960, status: 'cancelled', day: DAY },
  ];
  const result = layoutDay(staff, hours, [], appts, DAY);
  assert.deepEqual(result.columns[0].blocks, []);
});

test('layoutDay: inactive staff column shown only if they have appointments that day', () => {
  const staff = [
    { id: 1, name: 'Mia', active: true },
    { id: 2, name: 'Retired', active: false },
  ];
  const hours = [{ staffId: 1, start: 600, end: 1200 }];

  const withoutAppt = layoutDay(staff, hours, [], [], DAY);
  assert.deepEqual(withoutAppt.columns.map((c) => c.staffId), [1]);

  const appts = [{ id: 5, staffId: 2, start: 660, end: 720, status: 'confirmed', day: DAY }];
  const withAppt = layoutDay(staff, hours, [], appts, DAY);
  assert.deepEqual(withAppt.columns.map((c) => c.staffId), [1, 2]);
});

// --- staff/calendar.mjs: createLoadSequencer (reload() staleness guard) ----

test('createLoadSequencer: only the most recently bumped sequence is current', () => {
  const seqr = createLoadSequencer();
  const first = seqr.bump(); // e.g. reload(B) captures this
  const second = seqr.bump(); // reload(C) fires right after, captures this
  assert.equal(seqr.isCurrent(first), false, 'an older capture is stale once a newer one exists');
  assert.equal(seqr.isCurrent(second), true);
});

test('createLoadSequencer: bump() never repeats a number, so old and new mounts cannot collide', () => {
  const seqr = createLoadSequencer();
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    const n = seqr.bump();
    assert.ok(!seen.has(n), `bump() repeated ${n}`);
    seen.add(n);
  }
});

test('createLoadSequencer: a bump from unmount()/mount() invalidates an in-flight reload even with no query in between', () => {
  const seqr = createLoadSequencer();
  const inFlight = seqr.bump(); // reload() captured this before its first await
  seqr.bump(); // unmount() bumps
  seqr.bump(); // the next mount() bumps again
  assert.equal(seqr.isCurrent(inFlight), false);
});

// --- staff/calendar.mjs: createForgetfulCache (ensureStaticData's cache) --

test('createForgetfulCache: caches a successful result and does not call fn again', async () => {
  let calls = 0;
  const cache = createForgetfulCache(
    async () => {
      calls += 1;
      return { ok: true, value: 'staff' };
    },
    (r) => r.ok,
    { ok: false }
  );
  const first = await cache();
  const second = await cache();
  assert.deepEqual(first, { ok: true, value: 'staff' });
  assert.deepEqual(second, { ok: true, value: 'staff' });
  assert.equal(calls, 1, 'fn should only run once for a successful result');
});

test('createForgetfulCache: forgets a soft failure ({ok:false}) so the next call retries', async () => {
  let calls = 0;
  const cache = createForgetfulCache(
    async () => {
      calls += 1;
      return calls === 1 ? { ok: false } : { ok: true, value: 'staff' };
    },
    (r) => r.ok,
    { ok: false }
  );
  const failed = await cache();
  assert.deepEqual(failed, { ok: false });
  const retried = await cache();
  assert.deepEqual(retried, { ok: true, value: 'staff' });
  assert.equal(calls, 2, 'a soft failure must not be cached — the retry has to call fn again');
});

test('createForgetfulCache: forgets a hard rejection (network throw) so the next call retries', async () => {
  let calls = 0;
  const cache = createForgetfulCache(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return { ok: true, value: 'staff' };
    },
    (r) => r.ok,
    { ok: false }
  );
  const failed = await cache();
  assert.deepEqual(failed, { ok: false }, 'a hard rejection resolves as the fallback, never throws to the caller');
  const retried = await cache();
  assert.deepEqual(retried, { ok: true, value: 'staff' });
  assert.equal(calls, 2, 'a rejected promise must not stay cached — the retry has to call fn again');
});

test('createForgetfulCache: concurrent callers while a load is in flight share one fn call', async () => {
  let calls = 0;
  let resolve;
  const cache = createForgetfulCache(
    () => {
      calls += 1;
      return new Promise((r) => { resolve = r; });
    },
    (r) => r.ok,
    { ok: false }
  );
  const a = cache();
  const b = cache();
  // fn() is invoked via `Promise.resolve().then(fn)` inside the cache, so it
  // runs on a later microtask, not synchronously within cache(); flush the
  // microtask queue so `resolve` is captured before we call it.
  await Promise.resolve();
  await Promise.resolve();
  resolve({ ok: true, value: 'staff' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { ok: true, value: 'staff' });
  assert.deepEqual(rb, { ok: true, value: 'staff' });
  assert.equal(calls, 1, 'two concurrent callers should share the one in-flight call');
});

// --- staff/booking-editor.mjs: apptPayload ---------------------------------

test('apptPayload builds an insert/update row via salonInstant + DST-safe ms math', () => {
  const payload = apptPayload({
    staffId: 3,
    services: ['Nails'],
    day: '2026-11-01', // DST fall-back day
    startMin: 600,
    lengthMin: 90,
    customerName: 'Ann',
    phone: '7185550100',
    email: '',
    notes: '',
    source: 'phone',
    status: 'confirmed',
  });
  assert.deepEqual(payload, {
    staff_id: 3,
    services: ['Nails'],
    starts_at: '2026-11-01T15:00:00.000Z',
    ends_at: '2026-11-01T16:30:00.000Z',
    status: 'confirmed',
    customer_name: 'Ann',
    phone: '7185550100',
    email: null,
    notes: null,
    source: 'phone',
  });
});

// --- staff/schedules.mjs: timeOptions -------------------------------------

test('timeOptions lists half-hour steps from 6:00 AM to 11:30 PM', () => {
  const opts = timeOptions();
  assert.equal(opts.length, 36);
  assert.deepEqual(opts[0], { value: '06:00', label: '6:00 AM' });
  assert.deepEqual(opts[1], { value: '06:30', label: '6:30 AM' });
  assert.deepEqual(opts.at(-1), { value: '23:30', label: '11:30 PM' });
});

test('timeOptions keeps an off-grid saved time, in order', () => {
  const values = timeOptions('10:15').map((o) => o.value);
  assert.equal(values.length, 37);
  assert.deepEqual(values.slice(8, 11), ['10:00', '10:15', '10:30']);
  assert.equal(timeOptions('10:00').length, 36);
});

test('new shifts default to 10:00 AM - 8:00 PM', () => {
  assert.deepEqual(DEFAULT_SHIFT, { start: '10:00', end: '20:00' });
});

// --- staff/schedules.mjs: validateShifts -----------------------------------

test('validateShifts accepts split shifts (gap on the same weekday)', () => {
  const rows = [
    { weekday: 2, start: '09:00', end: '12:00' },
    { weekday: 2, start: '13:00', end: '17:00' },
  ];
  assert.equal(validateShifts(rows), null);
});

test('validateShifts accepts an empty list and shifts on different weekdays', () => {
  assert.equal(validateShifts([]), null);
  const rows = [
    { weekday: 1, start: '10:00', end: '18:00' },
    { weekday: 3, start: '10:00', end: '18:00' },
  ];
  assert.equal(validateShifts(rows), null);
});

test('validateShifts rejects end <= start', () => {
  const rows = [{ weekday: 1, start: '10:00', end: '10:00' }];
  assert.equal(validateShifts(rows).en, 'End must be after start');
});

test('validateShifts rejects overlapping shifts on the same weekday', () => {
  const rows = [
    { weekday: 2, start: '09:00', end: '13:00' },
    { weekday: 2, start: '12:00', end: '17:00' },
  ];
  assert.equal(validateShifts(rows).en, 'Tuesday shifts overlap');
});

// --- staff/team.mjs: reorder -------------------------------------------
// Fix round 1 on 9637272: reorderButtons previously swapped two staff.sort
// values with two independent update() calls; a partial failure (one
// succeeds, one doesn't — no unique constraint on sort) could leave two rows
// sharing a sort value, and a later same-direction swap of equal values was
// a no-op, wedging the order. reorder() instead computes the whole new id
// order; the caller (persistReorder in team.mjs) renumbers sort = 1..n from
// it and only writes rows that actually changed, so retrying after any
// partial failure converges instead of getting stuck.

const REORDER_LIST = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('reorder moves an item up, returning the full id order', () => {
  assert.deepEqual(reorder(REORDER_LIST, 1, -1), [2, 1, 3]);
});

test('reorder moves an item down, returning the full id order', () => {
  assert.deepEqual(reorder(REORDER_LIST, 1, 1), [1, 3, 2]);
});

test('reorder moving the top item up is a no-op', () => {
  assert.deepEqual(reorder(REORDER_LIST, 0, -1), [1, 2, 3]);
});

test('reorder moving the bottom item down is a no-op', () => {
  assert.deepEqual(reorder(REORDER_LIST, 2, 1), [1, 2, 3]);
});

test('reorder is idempotent: running it again on its own output leaves the order stable except for a fresh move', () => {
  const oncePastId = reorder(REORDER_LIST, 0, 1); // [2, 1, 3]
  const listAfter = oncePastId.map((id) => ({ id }));
  // Moving the (new) top item up again is a no-op, same as any fresh list.
  assert.deepEqual(reorder(listAfter, 0, -1), oncePastId);
});

// --- Final-review fixes ---------------------------------------------------

test('createListenerSet: add returns an unsubscribe; emit reaches only current listeners', () => {
  const set = createListenerSet();
  const seen = [];
  const offA = set.add((day) => seen.push(`a:${day}`));
  set.add((day) => seen.push(`b:${day}`));
  set.emit('2026-10-27');
  offA();
  offA(); // idempotent
  set.emit('2026-10-28');
  assert.deepEqual(seen, ['a:2026-10-27', 'b:2026-10-27', 'b:2026-10-28']);
  assert.equal(set.size, 1);
});

test('createListenerSet: a throwing listener does not stop the others', () => {
  const set = createListenerSet();
  const seen = [];
  set.add(() => { throw new Error('boom'); });
  set.add((day) => seen.push(day));
  set.emit('2026-10-27');
  assert.deepEqual(seen, ['2026-10-27']);
});

test('createListenerSet: a listener removed during emit is not called afterwards', () => {
  const set = createListenerSet();
  const seen = [];
  let offB = null;
  set.add(() => { seen.push('a'); offB(); });
  offB = set.add(() => seen.push('b'));
  set.emit('d');
  set.emit('d');
  assert.deepEqual(seen, ['a', 'a']);
});

test('authAction: first callback renders shell or sign-in', () => {
  assert.equal(authAction(undefined, { user: { id: 'u1' } }), 'shell');
  assert.equal(authAction(undefined, null), 'signin');
});

test('authAction: token refresh / visibility SIGNED_IN for the same user does nothing', () => {
  assert.equal(authAction('u1', { user: { id: 'u1' } }), 'none');
  assert.equal(authAction(null, null), 'none');
});

test('authAction: sign-in, sign-out and a different user are real transitions', () => {
  assert.equal(authAction(null, { user: { id: 'u1' } }), 'shell');
  assert.equal(authAction('u1', null), 'signin');
  assert.equal(authAction('u1', { user: { id: 'u2' } }), 'shell');
});

test('tapMinute floors to the 15-minute slot that was tapped', () => {
  // 600 = 10:00 grid start, 1 px per minute
  assert.equal(tapMinute(0, 600, 1200), 600);
  assert.equal(tapMinute(14, 600, 1200), 600); // 10:14 -> 10:00, not 10:15
  assert.equal(tapMinute(8, 600, 1200), 600); // rounding would give 10:15
  assert.equal(tapMinute(15, 600, 1200), 615);
  assert.equal(tapMinute(29.9, 600, 1200), 615);
});

test('tapMinute clamps to the grid', () => {
  assert.equal(tapMinute(-5, 600, 1200), 600);
  assert.equal(tapMinute(10000, 600, 1200), 1185);
});

test('confirmProviderOptions: active staff, current provider selected', () => {
  const staff = [
    { id: 1, name: 'Mia', active: true },
    { id: 2, name: 'Yoyo', active: true },
  ];
  assert.deepEqual(confirmProviderOptions(staff, 2), [
    { id: 1, label: 'Mia', selected: false },
    { id: 2, label: 'Yoyo', selected: true },
  ]);
});

test('confirmProviderOptions: an inactive current provider is kept, selected and marked', () => {
  const staff = [
    { id: 1, name: 'Mia', active: true },
    { id: 3, name: 'Carmela', active: false },
    { id: 2, name: 'Yoyo', active: true },
  ];
  assert.deepEqual(confirmProviderOptions(staff, 3), [
    { id: 1, label: 'Mia', selected: false },
    { id: 3, label: 'Carmela (inactive)', selected: true },
    { id: 2, label: 'Yoyo', selected: false },
  ]);
  // Other inactive staff are still left out.
  assert.deepEqual(confirmProviderOptions(staff, 1).map((o) => o.id), [1, 2]);
});

test('createDeferredReload: reloads immediately when nothing is held', () => {
  let n = 0;
  const d = createDeferredReload(() => { n += 1; });
  d.request();
  assert.equal(n, 1);
});

test('createDeferredReload: defers while held and reloads once when the last hold is released', () => {
  let n = 0;
  const d = createDeferredReload(() => { n += 1; });
  const releaseA = d.hold();
  const releaseB = d.hold();
  d.request();
  d.request();
  assert.equal(n, 0);
  releaseA();
  assert.equal(n, 0);
  releaseB();
  assert.equal(n, 1);
  releaseB(); // idempotent
  assert.equal(n, 1);
});

test('createDeferredReload: releasing with nothing requested does not reload; reset drops holds', () => {
  let n = 0;
  const d = createDeferredReload(() => { n += 1; });
  const release = d.hold();
  release();
  assert.equal(n, 0);
  d.hold();
  d.reset();
  d.request();
  assert.equal(n, 1);
});

test('createDeferredReload: held reflects open holds', () => {
  const d = createDeferredReload(() => {});
  assert.equal(d.held, false);
  const release = d.hold();
  assert.equal(d.held, true);
  release();
  assert.equal(d.held, false);
});

test('requestNotes shows the booking notes (nail details) on a request card, or nothing', () => {
  const notes = 'Gel X: New set, Chrome\n\nShort please';
  assert.equal(requestNotes({ notes }), notes);
  assert.equal(requestNotes({ notes: '  ' }), null);
  assert.equal(requestNotes({ notes: null }), null);
  assert.equal(requestNotes({}), null);
});

test('columnClass marks a column with no shift that day red (no-shift)', () => {
  assert.equal(columnClass({ shifts: [{ top: 0, height: 480 }] }), 'day-col');
  assert.equal(columnClass({ shifts: [] }), 'day-col no-shift');
});

// --- staff/i18n.mjs --------------------------------------------------------

test('t() shows the chosen language, English by default', () => {
  assert.equal(getLang(), 'en');
  assert.equal(t('Requests'), 'Requests');
  setLang('es');
  assert.equal(t('Requests'), 'Solicitudes');
  setLang('zh');
  assert.equal(t('Requests'), '预约请求');
  assert.equal(t('Day|view'), '日');
  assert.equal(t('Zzz unknown'), 'Zzz unknown', 'missing translation falls back to English');
  assert.equal(t({ en: 'Hi Ann', es: 'Hola Ann', zh: '你好 Ann' }), '你好 Ann');
  setLang('fr');
  assert.equal(getLang(), 'zh', 'unknown language codes are ignored');
  setLang('en');
  assert.equal(t('Day|view'), 'Day');
});

test('lookup() splits a key into its three languages; unknown keys stay English', () => {
  assert.deepEqual(lookup('Confirm'), { en: 'Confirm', es: 'Confirmar', zh: '确认' });
  assert.deepEqual(lookup('Zzz unknown'), { en: 'Zzz unknown', es: '', zh: '' });
});

test('a "|context" suffix picks a different translation but shows the same English', () => {
  assert.equal(lookup('Day|view').en, 'Day');
  assert.notEqual(lookup('Day|view').zh, lookup('Day').zh);
});

test('every label the staff app translates has Spanish and Chinese', () => {
  const dir = new URL('../staff/', import.meta.url);
  const missing = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'i18n.mjs')) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    // say(el, 'x'), t('x'), lookup('x'), and the *_COPY message constants.
    const pattern = /(?:\bsay\([\w.]+,\s*|(?<![\w.])t\(|\blookup\(|_COPY = )(['"])(.+?)\1/g;
    for (const [, , key] of src.matchAll(pattern)) {
      if (!STRINGS[key]) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('overlapMessage and validateShifts come back in all three languages', () => {
  const m = overlapMessage('Ann');
  assert.equal(m.en, 'That overlaps another appointment for Ann.');
  assert.match(m.es, /Ann/);
  assert.match(m.zh, /Ann/);
  const overlap = validateShifts([
    { weekday: 2, start: '10:00', end: '14:00' },
    { weekday: 2, start: '13:00', end: '18:00' },
  ]);
  assert.deepEqual(overlap, { en: 'Tuesday shifts overlap', es: 'Los turnos del martes se cruzan', zh: '星期二的班次时间重叠' });
});
