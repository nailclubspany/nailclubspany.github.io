// The "here's what you picked" summary on the booking page: shown on the last
// step (with Change links back to the step that owns each row) and again on
// the confirmation screen.
//
// formatDay and recapRows are pure — tested by tests/steps.test.mjs.

// 'Tue, Oct 6' for a YYYY-MM-DD date as written, independent of time zone.
export function formatDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// `services` is one line per picked service (js/nail-picker.mjs's
// detailLines); `time` is the label the customer saw (e.g. '2:15 PM').
// `step` is the screen of book/index.html that changes the row. Two rows
// only, so the recap stays a couple of lines tall on a phone.
export function recapRows({ services, provider, date, time }) {
  return [
    { label: 'Services', lines: services, step: 1 },
    { label: 'When', lines: [`${formatDay(date)} at ${time}`, provider ? `with ${provider}` : 'any provider'], step: 3 },
  ];
}

// Fills a <dl> with the rows. With `onChange(step)` each row gets a Change
// button; without it (the confirmation screen) the rows are read-only.
export function renderRecap(host, rows, onChange) {
  host.replaceChildren(...rows.map((row) => {
    const item = document.createElement('div');
    const term = Object.assign(document.createElement('dt'), { textContent: row.label });
    const detail = document.createElement('dd');
    detail.append(...row.lines.map((line) => Object.assign(document.createElement('span'), { textContent: line })));
    item.append(term, detail);
    if (onChange) {
      const change = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Change' });
      change.setAttribute('aria-label', `Change ${row.label.toLowerCase()}`);
      change.addEventListener('click', () => onChange(row.step));
      item.append(change);
    }
    return item;
  }));
}
