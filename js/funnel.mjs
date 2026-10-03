// Anonymous step counters for the booking page: how far visitors get before
// they stop. Each step is sent to GoatCounter (the script at the bottom of
// each page) as a named event, the first time a visitor reaches it on this
// page load. Only the step name is sent — never a name, phone number, email,
// or which service was picked.
//
// In the GoatCounter dashboard the events list as their own rows; read
// top-to-bottom they are the funnel through the three steps of
// book/index.html:
//   book-1-opened → book-1-service-picked → book-1-details-reached (only
//   when a picked service has optional details) →
//   book-2-reached → book-2-date-picked → book-2-time-picked →
//   book-3-reached → book-3-contact-started → book-3-send-tapped →
//   book-4-<outcome>
// plus book-<step>-error-<field> (what stopped a Next or a Send) and
// call-tapped-<where> (they phoned instead; counted on the homepage too).
//
// No top-level `document`/`window` access, so the helpers are unit-testable
// in Node (see tests/funnel.test.mjs).

export const STEPS = {
  opened: 'book-1-opened',
  servicePicked: 'book-1-service-picked',
  detailsReached: 'book-1-details-reached', // the optional-details screen
  datePicked: 'book-2-date-picked',
  timePicked: 'book-2-time-picked',
  contactStarted: 'book-3-contact-started',
  sendTapped: 'book-3-send-tapped',
  // Outcomes of a Send that passed the form's checks.
  held: 'book-4-held', // saved online
  timeTaken: 'book-4-time-taken',
  tooMany: 'book-4-too-many',
  emailedNotSaved: 'book-4-emailed-not-saved', // booking system failed, email got through
  failed: 'book-4-failed', // customer saw "couldn't send your request"
  sentByEmail: 'book-4-sent-by-email', // legacy (email-only) mode
};

const CONTACT_FIELDS = ['name', 'phone', 'email'];
// Which step of the form each checked field sits on.
const FIELD_STEP = { service: 1, choice: 1, date: 2, time: 2, name: 3, phone: 3, email: 3, other: 3 };

// Returns step(name), which passes each name to `send` only once.
export function createFunnel(send) {
  const reached = new Set();
  return (name) => {
    if (reached.has(name)) return;
    reached.add(name);
    send(name);
  };
}

// GoatCounter's script loads async, so an early step (the page has only just
// opened) can be reached before it exists. `getCount()` returns the counting
// function once it's available, else null; steps wait in order until then.
// After `maxTries` checks (an ad blocker: the script never comes) the
// waiting steps are dropped and nothing retries again.
export function createQueuedSender(getCount, { retryMs = 500, maxTries = 20, setTimer = setTimeout } = {}) {
  const queue = [];
  let tries = 0;
  let waiting = false;
  function flush() {
    waiting = false;
    const count = getCount();
    if (count) {
      for (const name of queue.splice(0)) count(name);
      return;
    }
    if (++tries >= maxTries) {
      queue.length = 0;
      return;
    }
    waiting = true;
    setTimer(flush, retryMs);
  }
  return (name) => {
    queue.push(name);
    if (!waiting) flush();
  };
}

// The step for arriving at step 2 or 3 of the form.
export function reachedStep(n) {
  return `book-${n}-reached`;
}

// The step for a field that failed its checks on Next or Send. Radio groups
// are named after their service ("Massage|Duration"), so they share "choice".
export function errorStep(control) {
  const field = control.type === 'radio' ? 'choice' : control.name in FIELD_STEP ? control.name : 'other';
  return `book-${FIELD_STEP[field]}-error-${field}`;
}

// The step for a tap on a phone link; `where` is the part of the page it's in.
export function callStep(where) {
  return `call-tapped-${where || 'top'}`;
}

// step() for this page. On a test host nothing is counted; steps are logged
// to the console instead.
export function pageCounter(testMode) {
  return createFunnel(createQueuedSender(() => {
    if (testMode) return (name) => console.log('Test mode — step not counted:', name);
    const counter = window.goatcounter;
    return counter?.count ? (name) => counter.count({ path: name, title: name, event: true }) : null;
  }));
}

// Counts taps on phone links, by the section (or <main>) they sit in.
export function trackCalls(step) {
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[href^="tel:"]');
    if (link) step(callStep(link.closest('section[id], main[id]')?.id));
  });
}

// Wires the booking form's counters and returns step(), for js/booking.mjs
// to report step changes and submit outcomes.
export function bookingFunnel(form, testMode) {
  const step = pageCounter(testMode);
  step(STEPS.opened);
  form.addEventListener('change', (e) => {
    const control = e.target;
    // Only the first screen's boxes: a nail service ticked on the details screen is not this step.
    if (control.name === 'service' && control.checked && control.closest('[data-step="1"]')) step(STEPS.servicePicked);
    else if (control.name === 'date' && control.value) step(STEPS.datePicked);
    else if (control.name === 'time' && control.value) step(STEPS.timePicked);
  });
  form.addEventListener('input', (e) => {
    // Safari can hold a date's `change` until the field loses focus.
    if (e.target.name === 'date' && e.target.value) step(STEPS.datePicked);
    if (CONTACT_FIELDS.includes(e.target.name) && e.target.value) step(STEPS.contactStarted);
  });
  // `invalid` doesn't bubble; capture it, as js/inline-errors.mjs does.
  form.addEventListener('invalid', (e) => step(errorStep(e.target)), true);
  trackCalls(step);
  return step;
}
