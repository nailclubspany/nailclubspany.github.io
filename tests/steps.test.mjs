import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepFromHash, firstIncompleteStep, allowedStep, nearestShown } from '../js/steps.mjs';
import { formatDay, recapRows } from '../js/recap.mjs';

// --- which screen to show ---------------------------------------------------

test('stepFromHash reads #1 up to the last screen and treats anything else as screen 1', () => {
  assert.equal(stepFromHash('#1', 4), 1);
  assert.equal(stepFromHash('#2', 4), 2);
  assert.equal(stepFromHash('#4', 4), 4);
  for (const hash of ['', '#', '#5', '#0', '#book', '#22', '#done']) assert.equal(stepFromHash(hash, 4), 1, hash);
  assert.equal(stepFromHash('#4', 3), 1, 'past the last screen');
});

test('firstIncompleteStep is the first screen whose checks fail, or the last screen', () => {
  assert.equal(firstIncompleteStep([false, true, false]), 1);
  assert.equal(firstIncompleteStep([true, true, false]), 3);
  assert.equal(firstIncompleteStep([true, false, true]), 2);
  assert.equal(firstIncompleteStep([true, true, true]), 4);
});

test('allowedStep never skips past an unfinished screen, but going back is always fine', () => {
  assert.equal(allowedStep(4, [false, true, false]), 1, 'deep link to the last screen on a fresh form');
  assert.equal(allowedStep(4, [true, true, false]), 3);
  assert.equal(allowedStep(4, [true, true, true]), 4);
  assert.equal(allowedStep(1, [true, true, true]), 1);
  assert.equal(allowedStep(3, [true, true, true]), 3);
});

test('nearestShown steps over a screen with nothing on it, in the direction of travel', () => {
  const noDetails = (n) => n === 2;
  assert.equal(nearestShown(2, 1, 4, noDetails), 3, 'Next from services skips the empty details screen');
  assert.equal(nearestShown(2, -1, 4, noDetails), 1, 'Back from date and time skips it too');
  assert.equal(nearestShown(2, 1, 4, () => false), 2, 'shown when it has something to ask');
  assert.equal(nearestShown(3, 1, 4, noDetails), 3);
  // The first and last screens are never skipped, whatever skip says.
  assert.equal(nearestShown(1, -1, 4, () => true), 1);
  assert.equal(nearestShown(4, 1, 4, () => true), 4);
});

// --- recap ------------------------------------------------------------------

test('formatDay writes the calendar date as picked, independent of time zone', () => {
  assert.equal(formatDay('2026-10-06'), 'Tue, Oct 6');
  assert.equal(formatDay('2026-01-01'), 'Thu, Jan 1');
  assert.equal(formatDay(''), '');
});

test('recapRows is two rows — services, and when with whom — each with the screen that changes it', () => {
  assert.deepEqual(
    recapRows({ services: ['Gel X: Fill, Chrome + Paraffin', 'Waxing'], provider: 'Mia', date: '2026-10-06', time: '2:15 PM' }),
    [
      { label: 'Services', lines: ['Gel X: Fill, Chrome + Paraffin', 'Waxing'], step: 1 },
      { label: 'When', lines: ['Tue, Oct 6 at 2:15 PM', 'with Mia'], step: 3 },
    ]
  );
});

test('recapRows says any provider when none was chosen', () => {
  const rows = recapRows({ services: ['Manicure'], provider: '', date: '2026-10-06', time: '10:00 AM' });
  assert.deepEqual(rows[1].lines, ['Tue, Oct 6 at 10:00 AM', 'any provider']);
});
