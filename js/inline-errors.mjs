// Form errors as text under each field, instead of the browser's validation
// bubble — which some phones and in-app browsers (e.g. the Google Maps one)
// never show, and which vanishes after a moment everywhere else.
//
// inlineErrors(form, messageFor) hooks the browser's own checks (required,
// type="email", setCustomValidity, ...): whenever a field fails one, its
// message appears under the field, the field gets aria-invalid (red outline),
// and the first failing field is scrolled to and focused. Editing the field
// clears its message. `messageFor(control)` may return friendlier text; it
// falls back to the browser's own validationMessage.
//
// Radio groups are skipped: js/nail-picker.mjs shows its own "Please choose
// one." under each group. Checkboxes share one message per fieldset (e.g.
// "choose at least one service").
//
// Used by the public booking form and the staff app; no network, no CDN.

const errors = new WeakMap(); // host element -> its error element

// Where a control's message goes: a checkbox's fieldset, else its label,
// else its parent.
function hostOf(control) {
  if (control.type === 'checkbox') return control.closest('fieldset') ?? control.parentElement;
  return control.closest('label') ?? control.parentElement;
}

export function showError(control, message) {
  const host = hostOf(control);
  let el = errors.get(host);
  if (!el) {
    el = document.createElement('span');
    el.className = 'field-error';
    el.setAttribute('role', 'alert');
    host.append(el);
    errors.set(host, el);
  }
  el.textContent = message;
  el.hidden = false;
  if (control.type !== 'checkbox') control.setAttribute('aria-invalid', 'true');
}

export function clearError(control) {
  const el = errors.get(hostOf(control));
  if (el) el.hidden = true;
  control.removeAttribute('aria-invalid');
}

export function inlineErrors(form, messageFor = () => undefined) {
  let focusQueued = false;
  form.addEventListener('invalid', (e) => {
    const control = e.target;
    e.preventDefault(); // no bubble — the text under the field says it
    if (control.type !== 'radio') showError(control, messageFor(control) || control.validationMessage);
    if (focusQueued) return;
    focusQueued = true;
    // After every invalid event of this check has fired, bring the first
    // failing field into view.
    setTimeout(() => {
      focusQueued = false;
      const first = form.querySelector('input:invalid, select:invalid, textarea:invalid');
      if (!first) return;
      (first.type === 'radio' ? first.closest('fieldset') : hostOf(first))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // focusVisible: false — no focus ring after a tap, so an untouched
      // option pill doesn't look already picked. (Keyboard users still get
      // the ring as soon as they move.)
      first.focus({ preventScroll: true, focusVisible: false });
    }, 0);
  }, true);
  const clear = (e) => {
    const control = e.target;
    if (!control.matches?.('input, select, textarea') || control.type === 'radio') return;
    clearError(control);
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
}
