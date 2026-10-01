// Add/edit-booking editor, opened by staff/calendar.mjs over an empty grid
// cell (new booking) or an existing block (edit). Pure helpers (`apptPayload`)
// have no DOM/network and are imported directly by node tests; `open`/`close`
// own the live Supabase insert/update and are only exercised manually (see
// the task report).
//
// Must never import app.mjs or the supabase-js CDN — that's what keeps the
// pure helpers importable by plain `node --test`.
import { salonInstant } from '../js/schedule.mjs';
import { overlapMessage } from './requests.mjs';
import { say, t, fieldMessage } from './i18n.mjs';
import { inlineErrors } from '../js/inline-errors.mjs';

// --- Pure helpers ------------------------------------------------------

export const LENGTH_OPTIONS = [];
for (let m = 15; m <= 240; m += 15) LENGTH_OPTIONS.push(m);
export const DEFAULT_LENGTH = 60;

export const START_OPTIONS = [];
for (let m = 0; m < 1440; m += 15) START_OPTIONS.push(m);

// Builds an `appointments` insert/update row. `starts_at` comes from
// `salonInstant(day, startMin)`; `ends_at` is computed with ISO-millisecond
// math off that instant (not wall-clock field arithmetic), so it stays
// correct across a DST transition — same approach as requests.mjs's
// confirmPatch.
export function apptPayload({
  staffId,
  services,
  day,
  startMin,
  lengthMin,
  customerName,
  phone,
  email,
  notes,
  source,
  status,
}) {
  const startsAt = salonInstant(day, startMin);
  const endsAt = new Date(new Date(startsAt).getTime() + lengthMin * 60000).toISOString();
  return {
    staff_id: staffId,
    services,
    starts_at: startsAt,
    ends_at: endsAt,
    status,
    customer_name: customerName || null,
    phone: phone || null,
    email: email || null,
    notes: notes || null,
    source,
  };
}

// --- DOM -----------------------------------------------------------------

let state = null; // { supabase }
let host = null;
let onDone = null; // called after a successful save/cancel, or on dismiss

function field(labelText, input) {
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  say(span, labelText);
  label.append(span, input);
  return label;
}

function buildServiceChecks(services, selected) {
  const wrap = document.createElement('div');
  wrap.className = 'service-checks';
  for (const svc of services) {
    const label = document.createElement('label');
    label.className = 'service-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'service';
    box.value = svc.name;
    box.checked = selected.includes(svc.name);
    const span = document.createElement('span');
    span.textContent = svc.name;
    label.append(box, span);
    wrap.appendChild(label);
  }
  return wrap;
}

function minutesToOption(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  const opt = new Option(`${h12}:${String(mm).padStart(2, '0')} ${ampm}`, String(m));
  return opt;
}

// Renders the editor into `host` (replacing its contents). `opts`:
//   staffList  — [{id,name,active}], active-first for the provider <select>
//   services   — [{name,requires}]
//   day, staffId, startMin — prefill for a new booking (tap on an empty cell)
//   appt       — an existing appointments row to edit instead (tap on a block)
//   onSaved()  — called after a successful insert/update/cancel
//   onClose()  — called when the editor is dismissed without saving
export function open(hostEl, ctx, opts) {
  state = ctx;
  host = hostEl;
  onDone = opts.onClose;

  const editing = opts.appt ?? null;
  const startingServices = editing ? editing.services ?? [] : [];
  const startingDay = editing ? opts.day : opts.day;
  const startingStaffId = editing ? editing.staff_id : opts.staffId;
  const startingStartMin = editing ? opts.startMin : opts.startMin;
  const startingLength = editing
    ? Math.round((new Date(editing.ends_at) - new Date(editing.starts_at)) / 60000)
    : DEFAULT_LENGTH;

  const overlay = document.createElement('div');
  overlay.className = 'editor-overlay';
  const card = document.createElement('div');
  card.className = 'editor-card';
  overlay.appendChild(card);

  const title = document.createElement('h2');
  say(title, editing ? 'Edit booking' : 'New booking');
  card.appendChild(title);

  const form = document.createElement('form');
  form.className = 'editor-form';
  inlineErrors(form, fieldMessage);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = editing?.customer_name ?? '';
  nameInput.required = true;

  const phoneInput = document.createElement('input');
  phoneInput.type = 'tel';
  phoneInput.value = editing?.phone ?? '';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.value = editing?.email ?? '';

  const servicesWrap = buildServiceChecks(opts.services, startingServices);

  const providerSelect = document.createElement('select');
  for (const s of opts.staffList) {
    const opt = new Option(s.name, String(s.id));
    if (s.id === startingStaffId) opt.selected = true;
    providerSelect.appendChild(opt);
  }

  const dayInput = document.createElement('input');
  dayInput.type = 'date';
  dayInput.value = startingDay;
  dayInput.required = true;

  const startSelect = document.createElement('select');
  for (const m of START_OPTIONS) {
    const opt = minutesToOption(m);
    if (m === startingStartMin) opt.selected = true;
    startSelect.appendChild(opt);
  }

  const lengthSelect = document.createElement('select');
  for (const m of LENGTH_OPTIONS) {
    const opt = new Option(`${m} min`, String(m));
    if (m === startingLength) opt.selected = true;
    lengthSelect.appendChild(opt);
  }

  const sourceSelect = document.createElement('select');
  const sourceOptions = editing?.source === 'web' ? ['web'] : ['phone', 'walk-in'];
  for (const s of sourceOptions) {
    const opt = new Option(t(s), s);
    if (s === (editing?.source ?? 'phone')) opt.selected = true;
    sourceSelect.appendChild(opt);
  }
  sourceSelect.disabled = editing?.source === 'web';

  const statusSelect = document.createElement('select');
  for (const s of ['pending', 'confirmed', 'declined', 'cancelled']) {
    const opt = new Option(t(s), s);
    if (s === (editing?.status ?? 'confirmed')) opt.selected = true;
    statusSelect.appendChild(opt);
  }

  const notesInput = document.createElement('textarea');
  notesInput.value = editing?.notes ?? '';

  form.append(
    field('Name', nameInput),
    field('Phone', phoneInput),
    field('Email', emailInput),
    field('Services', servicesWrap),
    field('Provider', providerSelect),
    field('Day', dayInput),
    field('Start', startSelect),
    field('Length', lengthSelect),
    field('Source', sourceSelect),
    field('Status', statusSelect),
    field('Notes', notesInput)
  );

  const status = document.createElement('p');
  status.className = 'editor-status';
  status.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'editor-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  say(saveBtn, editing ? 'Save changes' : 'Add booking');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-signout';
  say(cancelBtn, 'Close');
  cancelBtn.addEventListener('click', () => close());

  actions.append(saveBtn, cancelBtn);

  if (editing && editing.status !== 'cancelled') {
    const cancelApptBtn = document.createElement('button');
    cancelApptBtn.type = 'button';
    cancelApptBtn.className = 'btn btn-decline';
    say(cancelApptBtn, 'Cancel appointment');
    cancelApptBtn.addEventListener('click', async () => {
      cancelApptBtn.disabled = true;
      status.textContent = '';
      const { error } = await state.supabase
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('id', editing.id);
      cancelApptBtn.disabled = false;
      if (error) {
        say(status, 'Could not cancel — try again.');
        return;
      }
      opts.onSaved?.();
      close();
    });
    actions.append(cancelApptBtn);
  }

  form.append(status, actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checkedServices = [...servicesWrap.querySelectorAll('input[name="service"]:checked')].map((b) => b.value);
    if (checkedServices.length === 0) {
      say(status, 'Choose at least one service.');
      return;
    }
    saveBtn.disabled = true;
    status.textContent = '';
    const payload = apptPayload({
      staffId: Number(providerSelect.value),
      services: checkedServices,
      day: dayInput.value,
      startMin: Number(startSelect.value),
      lengthMin: Number(lengthSelect.value),
      customerName: nameInput.value.trim(),
      phone: phoneInput.value.trim(),
      email: emailInput.value.trim(),
      notes: notesInput.value.trim(),
      source: sourceSelect.value,
      status: statusSelect.value,
    });

    const query = editing
      ? state.supabase.from('appointments').update(payload).eq('id', editing.id)
      : state.supabase.from('appointments').insert(payload);
    const { error } = await query;
    saveBtn.disabled = false;
    if (error) {
      // Name the provider whose time is double-booked, not the customer.
      say(status, error.code === '23P01'
        ? overlapMessage(providerSelect.selectedOptions[0]?.textContent || 'this provider')
        : 'Could not save — try again.');
      return;
    }
    opts.onSaved?.();
    close();
  });

  card.appendChild(form);
  host.replaceChildren(overlay);
}

function close() {
  if (host) host.replaceChildren();
  const cb = onDone;
  state = null;
  host = null;
  onDone = null;
  cb?.();
}

export default { open, close };
