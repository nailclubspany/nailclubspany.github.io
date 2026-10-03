import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, createFunnel, createQueuedSender, reachedStep, errorStep, callStep } from '../js/funnel.mjs';

// --- createFunnel -----------------------------------------------------------

test('createFunnel sends each step only the first time it is reached', () => {
  const sent = [];
  const step = createFunnel((name) => sent.push(name));
  step(STEPS.servicePicked);
  step(STEPS.servicePicked);
  step(STEPS.datePicked);
  step(STEPS.servicePicked);
  assert.deepEqual(sent, [STEPS.servicePicked, STEPS.datePicked]);
});

test('step names sort in form order and carry nothing personal', () => {
  const ordered = [STEPS.opened, STEPS.servicePicked, STEPS.detailsReached, reachedStep(2), STEPS.datePicked, STEPS.timePicked,
    reachedStep(3), STEPS.contactStarted, STEPS.sendTapped, STEPS.held];
  assert.deepEqual(ordered.map((name) => name.slice(0, 6)), [
    'book-1', 'book-1', 'book-1', 'book-2', 'book-2', 'book-2', 'book-3', 'book-3', 'book-3', 'book-4',
  ]);
  for (const name of Object.values(STEPS)) assert.match(name, /^book-\d-[a-z-]+$/);
});

// --- createQueuedSender -----------------------------------------------------

// A fake timer: collects callbacks so a test can fire them one at a time.
function fakeTimer() {
  const pending = [];
  return { setTimer: (fn) => pending.push(fn), tick: () => pending.shift()?.(), pending };
}

test('createQueuedSender counts straight away when the counter is loaded', () => {
  const counted = [];
  const timer = fakeTimer();
  const send = createQueuedSender(() => (name) => counted.push(name), timer);
  send('a');
  assert.deepEqual(counted, ['a']);
  assert.equal(timer.pending.length, 0);
});

test('createQueuedSender holds steps until the counter script has loaded, keeping their order', () => {
  const counted = [];
  let loaded = false;
  const timer = fakeTimer();
  const send = createQueuedSender(() => (loaded ? (name) => counted.push(name) : null), timer);
  send('a');
  send('b');
  assert.deepEqual(counted, []);
  assert.equal(timer.pending.length, 1, 'one retry timer, not one per step');
  timer.tick();
  assert.deepEqual(counted, []);
  loaded = true;
  timer.tick();
  assert.deepEqual(counted, ['a', 'b']);
  send('c');
  assert.deepEqual(counted, ['a', 'b', 'c']);
});

test('createQueuedSender gives up quietly when the counter never loads (ad blocker)', () => {
  const timer = fakeTimer();
  const send = createQueuedSender(() => null, { ...timer, maxTries: 3 });
  send('a');
  timer.tick();
  timer.tick();
  assert.equal(timer.pending.length, 0, 'stopped retrying');
  send('b');
  assert.equal(timer.pending.length, 0, 'later steps do not restart the retries');
});

// --- reachedStep / errorStep / callStep -------------------------------------

test('reachedStep names arriving at a step', () => {
  assert.equal(reachedStep(2), 'book-2-reached');
  assert.equal(reachedStep(3), 'book-3-reached');
});

test('errorStep names the field that stopped a Next or Send, on its own step, never its value', () => {
  assert.equal(errorStep({ type: 'checkbox', name: 'service', value: 'Manicure' }), 'book-1-error-service');
  assert.equal(errorStep({ type: 'radio', name: 'Massage|Duration' }), 'book-1-error-choice');
  assert.equal(errorStep({ type: 'date', name: 'date' }), 'book-2-error-date');
  assert.equal(errorStep({ type: 'select-one', name: 'time' }), 'book-2-error-time');
  assert.equal(errorStep({ type: 'email', name: 'email', value: 'someone@example.com' }), 'book-3-error-email');
  assert.equal(errorStep({ type: 'text', name: 'something-new' }), 'book-3-error-other');
});

test('callStep says which part of the page the phone link was in', () => {
  assert.equal(callStep('book'), 'call-tapped-book');
  assert.equal(callStep('booking'), 'call-tapped-booking');
  assert.equal(callStep(undefined), 'call-tapped-top');
});

// --- wiring -----------------------------------------------------------------

test('booking.mjs reports step changes and every submit outcome to the funnel', () => {
  const js = readFileSync(new URL('../js/booking.mjs', import.meta.url), 'utf8');
  assert.ok(js.includes('bookingFunnel(form, TEST_MODE)'));
  assert.ok(js.includes('step(reachedStep(2))') && js.includes('step(reachedStep(3))'));
  for (const name of ['detailsReached', 'sendTapped', 'held', 'timeTaken', 'tooMany', 'emailedNotSaved', 'failed', 'sentByEmail']) {
    assert.ok(js.includes(`STEPS.${name}`), `missing STEPS.${name}`);
  }
});

test('the homepage counts phone taps too', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../js/home.mjs', import.meta.url), 'utf8');
  assert.ok(html.includes('<script type="module" src="js/home.mjs"></script>'));
  assert.match(home, /trackCalls\(pageCounter\(/);
});
