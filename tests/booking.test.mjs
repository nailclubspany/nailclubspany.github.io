import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/<script id="booking-logic">([\s\S]*?)<\/script>/);
assert.ok(match, 'index.html must contain <script id="booking-logic">');
const ctx = vm.createContext({});
vm.runInContext(match[1], ctx);
const { buildBookingMailto, buildBookingSubmission, localISODate, isPastDate } = ctx;

const TO = 'nailclubspany@gmail.com';
const sample = {
  name: 'Ann & Bo',
  phone: '718-555-0100',
  email: 'ann@example.com',
  service: 'Nails',
  technician: 'Mia',
  date: '2026-10-01',
  time: '2:00 PM',
  notes: 'Line1\nLine2 #1 50%',
};

function parts(url) {
  const [addr, query] = url.split('?');
  const params = Object.fromEntries(
    query.split('&').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, decodeURIComponent(v)];
    })
  );
  return { addr, ...params };
}

test('mailto is addressed to the salon', () => {
  assert.ok(buildBookingMailto(sample, TO).startsWith(`mailto:${TO}?subject=`));
});

test('subject names the customer, special characters intact', () => {
  assert.equal(parts(buildBookingMailto(sample, TO)).subject, 'Appointment request – Ann & Bo');
});

test('body lists every field on CRLF-separated lines', () => {
  const { body } = parts(buildBookingMailto(sample, TO));
  assert.equal(
    body,
    [
      'Name: Ann & Bo',
      'Phone: 718-555-0100',
      'Email: ann@example.com',
      'Service: Nails',
      'Technician: Mia',
      'Preferred date: 2026-10-01',
      'Preferred time: 2:00 PM',
      'Notes: Line1\nLine2 #1 50%',
    ].join('\r\n')
  );
});

test('no technician chosen reads as No preference', () => {
  const { body } = parts(buildBookingMailto({ ...sample, technician: '' }, TO));
  assert.ok(body.includes('\r\nTechnician: No preference\r\n'));
});

test('empty notes read as (none)', () => {
  const { body } = parts(buildBookingMailto({ ...sample, notes: '' }, TO));
  assert.ok(body.endsWith('Notes: (none)'));
});

test('web submission carries the access key, subject, and every field', () => {
  const payload = JSON.parse(JSON.stringify(buildBookingSubmission(sample, 'KEY-123')));
  assert.deepEqual(payload, {
    access_key: 'KEY-123',
    subject: 'Appointment request – Ann & Bo',
    from_name: 'Nail Club Spa NY',
    name: 'Ann & Bo',
    phone: '718-555-0100',
    email: 'ann@example.com',
    service: 'Nails',
    technician: 'Mia',
    'preferred date': '2026-10-01',
    'preferred time': '2:00 PM',
    notes: 'Line1\nLine2 #1 50%',
  });
});

test('web submission fills blanks with No preference and (none)', () => {
  const payload = buildBookingSubmission({ ...sample, technician: '', notes: '' }, 'KEY-123');
  assert.equal(payload.technician, 'No preference');
  assert.equal(payload.notes, '(none)');
});

test('localISODate uses local time, not UTC', () => {
  assert.equal(localISODate(new Date(2026, 8, 25, 23, 30)), '2026-09-25');
});

test('isPastDate: yesterday past, today and tomorrow not', () => {
  const lateTonight = new Date(2026, 8, 25, 23, 30);
  assert.equal(isPastDate('2026-09-24', lateTonight), true);
  assert.equal(isPastDate('2026-09-25', lateTonight), false);
  assert.equal(isPastDate('2026-09-26', lateTonight), false);
});

// 2026-09-25 is a Friday; New York is UTC-4 (EDT) on these dates.
const { salonClock, openStatus } = ctx;

test('salonClock reports New York day and minutes, not UTC', () => {
  const c = salonClock(new Date('2026-09-26T02:00:00Z')); // Fri 10:00pm in NY, Sat in UTC
  assert.equal(c.day, 5);
  assert.equal(c.minutes, 22 * 60);
});

test('openStatus: before opening', () => {
  assert.equal(openStatus(new Date('2026-09-25T13:59:00Z')), 'Closed, opens 10am');
});

test('openStatus: open from 10am until closing', () => {
  assert.equal(openStatus(new Date('2026-09-25T14:00:00Z')), 'Open now, closes 8pm');
  assert.equal(openStatus(new Date('2026-09-25T23:59:00Z')), 'Open now, closes 8pm');
});

test('openStatus: after closing says tomorrow', () => {
  assert.equal(openStatus(new Date('2026-09-26T00:00:00Z')), 'Closed, opens 10am tomorrow');
});

test('openStatus: Sunday closes at 7pm', () => {
  assert.equal(openStatus(new Date('2026-09-27T22:59:00Z')), 'Open now, closes 7pm');
  assert.equal(openStatus(new Date('2026-09-27T23:00:00Z')), 'Closed, opens 10am tomorrow');
});

const { timeSlots, weekdayOf } = ctx;

test('timeSlots: 15-minute AM/PM slots from opening until 15 min before close', () => {
  const mon = timeSlots(1);
  assert.equal(mon[0], '10:00 AM');
  assert.equal(mon[1], '10:15 AM');
  assert.ok(mon.includes('12:00 PM'));
  assert.ok(mon.includes('12:45 PM'));
  assert.equal(mon.at(-1), '7:45 PM');
  assert.equal(mon.length, 40);
});

test('timeSlots: Sunday stops earlier (closes 7pm)', () => {
  assert.equal(timeSlots(0).at(-1), '6:45 PM');
});

test('weekdayOf reads the calendar date, not UTC', () => {
  assert.equal(weekdayOf('2026-09-27'), 0); // Sunday
  assert.equal(weekdayOf('2026-09-25'), 5); // Friday
});
