import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_STEP,
  BLOCK_MIN,
  LEAD_MIN,
  HORIZON_DAYS,
  TZ,
  unknownServices,
  earliestStart,
  openSlots,
  formatMinutes,
  salonToday,
  salonParts,
  salonInstant,
  addDaysToIso,
} from '../js/schedule.mjs';

test('constants match the spec', () => {
  assert.equal(SLOT_STEP, 15);
  assert.equal(BLOCK_MIN, 60);
  assert.equal(LEAD_MIN, 60);
  assert.equal(HORIZON_DAYS, 60);
  assert.equal(TZ, 'America/New_York');
});

// --- Fixtures -------------------------------------------------------------

// Base day: two techs who each cover one skill, plus a third who covers both.
function baseDay(overrides = {}) {
  return {
    day: '2026-10-05',
    services: {
      'Gel Mani': 'Nails',
      'Classic Pedi': 'Nails',
      'Mani-Pedi Bundle': 'Nails',
      'Lash Lift': 'Lashes',
      Other: null,
      ...overrides.services,
    },
    staff: overrides.staff ?? [
      { id: 1, name: 'Mia', services: ['Nails'] },
      { id: 2, name: 'Ken', services: ['Lashes'] },
      { id: 3, name: 'Zoe', services: ['Nails', 'Lashes'] },
    ],
    hours: overrides.hours ?? [],
    off: overrides.off ?? [],
    busy: overrides.busy ?? [],
  };
}

// --- openSlots --------------------------------------------------------------

test('last slot is 30 minutes before the shift ends', () => {
  const day = baseDay({ hours: [{ staff_id: 1, start_min: 600, end_min: 1080 }] });
  const slots = openSlots(day, null, 0);
  assert.equal(slots[0], 600);
  assert.equal(slots.at(-1), 1050);
  assert.equal(slots.length, 31);
});

test('salon cap: no start after 7:30 PM Mon–Sat or 6:30 PM Sunday, even on a longer shift', () => {
  const hours = [{ staff_id: 1, start_min: 600, end_min: 1320 }]; // 10 AM–10 PM
  assert.equal(openSlots(baseDay({ hours }), null, 0).at(-1), 1170); // Monday 2026-10-05
  const sunday = { ...baseDay({ hours }), day: '2026-10-04' };
  assert.equal(openSlots(sunday, null, 0).at(-1), 1110);
});

test('split shift gap', () => {
  const day = baseDay({
    hours: [
      { staff_id: 1, start_min: 600, end_min: 780 },
      { staff_id: 1, start_min: 840, end_min: 1080 },
    ],
  });
  const slots = openSlots(day, null, 0);
  assert.ok(slots.includes(750));
  assert.ok(!slots.includes(765));
  assert.ok(!slots.includes(780));
  assert.ok(!slots.includes(795));
  assert.ok(slots.includes(840));
});

test('off and busy remove overlapping starts', () => {
  const day = baseDay({
    hours: [{ staff_id: 1, start_min: 600, end_min: 1080 }],
    busy: [{ staff_id: 1, start_min: 840, end_min: 900 }],
  });
  const slots = openSlots(day, null, 0);
  for (const m of [795, 810, 825, 840, 855, 870, 885]) {
    assert.ok(!slots.includes(m), `expected ${m} to be removed by busy block`);
  }
  assert.ok(slots.includes(780));
  assert.ok(slots.includes(900));
});

test('off blocks remove overlapping starts same as busy', () => {
  const day = baseDay({
    hours: [{ staff_id: 1, start_min: 600, end_min: 1080 }],
    off: [{ staff_id: 1, start_min: 600, end_min: 660 }],
  });
  const slots = openSlots(day, null, 0);
  assert.ok(!slots.includes(600));
  assert.ok(!slots.includes(615));
  assert.ok(slots.includes(660));
});

test('no preference unions all staff; chosen staff only theirs', () => {
  const day = baseDay({
    hours: [
      { staff_id: 1, start_min: 600, end_min: 660 },
      { staff_id: 3, start_min: 900, end_min: 960 },
    ],
  });
  const union = openSlots(day, null, 0);
  assert.ok(union.includes(600));
  assert.ok(union.includes(900));

  const miaOnly = openSlots(day, 1, 0);
  assert.ok(miaOnly.includes(600));
  assert.ok(!miaOnly.includes(900));
});

test('earliest filters and rounds', () => {
  const day = baseDay({ hours: [{ staff_id: 1, start_min: 600, end_min: 1080 }] });
  const slots = openSlots(day, null, 613);
  assert.equal(slots[0], 615);
});

test('skills do not limit slots: a provider without the skill still has their times', () => {
  const day = baseDay({ hours: [{ staff_id: 2, start_min: 600, end_min: 1080 }] });
  // Ken (id 2) only has Lashes; customers may still pick him for nails.
  const slots = openSlots(day, 2, 0);
  assert.equal(slots[0], 600);
});

// --- earliestStart ------------------------------------------------------

test('earliestStart uses salon clock', () => {
  // 11:30pm LA / 6:30am UTC on 10/20 = 2:30am NY on 10/21.
  const now = new Date('2026-10-21T06:30:00Z');
  assert.equal(earliestStart('2026-10-21', now), 210);
  assert.equal(earliestStart('2026-10-20', now), null);
  assert.equal(earliestStart('2026-12-20', now), 0);
  assert.equal(earliestStart('2026-12-21', now), null);
});

// --- addDaysToIso (used by js/booking.mjs for the date input's live-mode max) --

test('addDaysToIso adds calendar days, crossing month and year boundaries', () => {
  assert.equal(addDaysToIso('2026-09-28', 60), '2026-11-27');
  assert.equal(addDaysToIso('2026-01-15', 20), '2026-02-04');
  assert.equal(addDaysToIso('2026-12-20', 15), '2027-01-04');
});

// --- formatMinutes --------------------------------------------------------

test('formatMinutes', () => {
  assert.equal(formatMinutes(0), '12:00 AM');
  assert.equal(formatMinutes(615), '10:15 AM');
  assert.equal(formatMinutes(780), '1:00 PM');
});

// --- salonToday / salonParts / salonInstant --------------------------------

test('salonToday reads the NY calendar date', () => {
  assert.equal(salonToday(new Date('2026-10-21T06:30:00Z')), '2026-10-21');
});

test('salonInstant/salonParts round-trip incl. DST', () => {
  assert.equal(salonInstant('2026-11-01', 600), '2026-11-01T15:00:00.000Z');
  assert.equal(salonInstant('2026-10-31', 600), '2026-10-31T14:00:00.000Z');

  assert.deepEqual(salonParts(salonInstant('2026-11-01', 600)), { day: '2026-11-01', minutes: 600 });
  assert.deepEqual(salonParts(salonInstant('2026-10-31', 600)), { day: '2026-10-31', minutes: 600 });
});

test('unknownServices lists picked labels the database does not offer', () => {
  const day = baseDay();
  assert.deepEqual(unknownServices(day, ['Gel Mani', 'Other']), []);
  // e.g. the live site's form offers a nail service before its migration ran.
  assert.deepEqual(unknownServices(day, ['Gel Mani', 'Gel X', 'UV Gel']), ['Gel X', 'UV Gel']);
});
