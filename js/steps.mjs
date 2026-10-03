// Shows the booking form (book/index.html) one screen at a time.
//
// The form is a single <form> holding `.step` panels numbered by
// `data-step`; only the current one is visible. Hidden panels are not
// disabled, so their fields are still checked and sent on Send —
// js/booking.mjs's submit code needs no knowledge of screens.
//
// There can be more screens than steps on the progress line: each panel's
// `data-progress` says which of the three named steps it belongs to (the
// services screen and its optional-details screen are both step 1). A screen
// with nothing to show is skipped (the `skip` hook).
//
// The address carries the screen (/book/#1 … #4). Next adds a history entry,
// so the browser's Back button returns one screen. A visitor can always go
// back, but never past a screen whose own fields don't pass yet (a deep link
// to the last screen on a fresh form shows the first).
//
// The pure helpers at the top have no DOM access — tested by
// tests/steps.test.mjs.

// The screen a hash asks for: '#1' … `#${last}`, anything else is screen 1.
export function stepFromHash(hash, last) {
  const m = /^#(\d)$/.exec(hash);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= last ? n : 1;
}

// `done[i]` says whether screen i+1 passes its checks. With every earlier
// screen done, the answer is the last screen.
export function firstIncompleteStep(done) {
  const i = done.indexOf(false);
  return i === -1 ? done.length + 1 : i + 1;
}

export function allowedStep(wanted, done) {
  return Math.min(wanted, firstIncompleteStep(done));
}

// The nearest screen at or after `from` (moving by `direction`, +1 or -1)
// that isn't skipped; the first and last screens are never skipped.
export function nearestShown(from, direction, last, skip) {
  let n = from;
  while (n > 1 && n < last && skip(n)) n += direction;
  return n;
}

// Wires the panels, the Back/Next/Send buttons and the progress line.
// `beforeValidate()` lets the caller set custom validity (e.g. "choose at
// least one service") before a screen's fields are checked; `skip(n)` says
// whether screen n has nothing to show right now; `onShow(n)` runs whenever
// screen n becomes the visible one. Returns { go(n), current }.
export function bookingSteps(form, { beforeValidate = () => {}, skip = () => false, onShow = () => {} } = {}) {
  const panels = [...form.querySelectorAll('.step')];
  const labels = [...document.querySelectorAll('[data-step-label]')];
  const back = form.querySelector('[data-back]');
  const next = form.querySelector('[data-next]');
  const send = form.querySelector('[data-send]');
  const last = panels.length;
  let current = 0; // nothing shown yet

  const panel = (n) => panels.find((p) => Number(p.dataset.step) === n);
  const controls = (n) => [...panel(n).querySelectorAll('input, select, textarea')];
  const stepOf = (control) => Number(control.closest?.('.step')?.dataset.step) || 0;

  // Quiet check: no messages shown.
  function passes(n) {
    beforeValidate();
    return controls(n).every((c) => !c.willValidate || c.validity.valid);
  }
  // Loud check: each failing field fires `invalid`, which js/inline-errors.mjs
  // turns into a message under the field.
  function validate(n) {
    beforeValidate();
    return controls(n).map((c) => c.checkValidity()).every(Boolean);
  }

  function show(n, { focus = true } = {}) {
    if (n === current) return;
    const firstShow = current === 0;
    current = n;
    for (const p of panels) p.hidden = Number(p.dataset.step) !== n;
    const progress = Number(panel(n).dataset.progress);
    for (const label of labels) {
      const s = Number(label.dataset.stepLabel);
      label.classList.toggle('done', s < progress);
      if (s === progress) label.setAttribute('aria-current', 'step');
      else label.removeAttribute('aria-current');
    }
    back.hidden = n === 1;
    next.hidden = n === last;
    send.hidden = n !== last;
    onShow(n);
    if (firstShow || !focus) return;
    form.scrollIntoView({ block: 'start' });
    panel(n).querySelector('h2')?.focus({ preventScroll: true });
  }

  // Shows whatever the address asks for, held back to the first unfinished screen.
  function sync() {
    const done = panels.slice(0, -1).map((p) => passes(Number(p.dataset.step)));
    const n = nearestShown(allowedStep(stepFromHash(location.hash, last), done), -1, last, skip);
    if (location.hash !== `#${n}`) history.replaceState(history.state, '', `#${n}`);
    show(n);
  }

  function go(n, options) {
    history.replaceState(history.state, '', `#${n}`);
    show(n, options);
  }

  function advance() {
    if (current >= last || !validate(current)) return;
    const n = nearestShown(current + 1, 1, last, skip);
    history.pushState({ pushed: true }, '', `#${n}`);
    show(n);
  }

  next.addEventListener('click', advance);
  back.addEventListener('click', () => {
    // Undo our own history entry when there is one, so Back-then-Next doesn't pile entries up.
    if (history.state?.pushed) history.back();
    else go(nearestShown(current - 1, -1, last, skip));
  });
  // Enter in a field submits the form even while Send is hidden: before the
  // last screen, treat it as Next and keep it away from the real submit handler.
  form.addEventListener('submit', (e) => {
    if (current >= last) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    advance();
  }, true);
  // Send checks every field. If one on an earlier screen fails (say the chosen
  // time is no longer open), take the customer back to it.
  form.addEventListener('invalid', (e) => {
    const n = stepOf(e.target);
    if (n && n < current) go(n, { focus: false });
  }, true);
  addEventListener('popstate', sync);
  addEventListener('hashchange', sync);

  sync();
  return { go, get current() { return current; } };
}
