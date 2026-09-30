// Requests view: lists Pending online-booking holds for staff to confirm or
// decline. Pure helpers (requestNotes, formatPhone, confirmPatch, formatDay,
// overlapMessage, confirmProviderOptions, createDeferredReload) have no
// DOM/network and are imported directly by node tests. mount/unmount own the
// live Supabase reads/writes and register for availability broadcasts via
// ctx.onAvailabilityChanged (the shell owns the channel) — those are only
// exercised manually (a Supabase project is required; see the task report).
//
// Must never import app.mjs or the supabase-js CDN — that's what keeps the
// pure helpers importable by plain `node --test`.
import { salonParts, formatMinutes } from '../js/schedule.mjs';
import { say, t, tri } from './i18n.mjs';

// --- Pure helpers ------------------------------------------------------

function digitsOnly(phone) {
  return (phone || '').replace(/\D/g, '');
}

// The booking's notes for a request card, or null when there are none. Online
// requests put the nail service details (e.g. "Gel X: New set, Chrome")
// first — what staff need to pick the right length when confirming.
export function requestNotes(appt) {
  return appt.notes && appt.notes.trim() ? appt.notes : null;
}

// A customer's phone as staff read it: a US number (10 digits, or 11 with a
// leading 1) as '(718) 555-0100'; anything else exactly as they typed it.
export function formatPhone(phone) {
  const d = digitsOnly(phone);
  const us = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (us.length === 10) return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  return phone ?? '';
}

// Confirms a pending hold: assigns the chosen provider and the real
// duration. `ends_at` is computed with ISO-millisecond math off `starts_at`
// (an instant plus a fixed number of minutes), not wall-clock field
// arithmetic, so it's correct across a DST transition.
export function confirmPatch(appt, lengthMin, staffId) {
  const endsAt = new Date(new Date(appt.starts_at).getTime() + lengthMin * 60000).toISOString();
  return { status: 'confirmed', staff_id: staffId, ends_at: endsAt };
}

// 'YYYY-MM-DD' salon day -> 'Sun, Nov 1'. Formatting off noon UTC sidesteps
// any timezone edge that could otherwise shift the calendar date by a day.
export function formatDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).format(noonUtc);
}

// Shared with staff/booking-editor.mjs (Task 6) so the overlap-error copy
// only lives in one place. `name` is the PROVIDER whose time overlaps.
export function overlapMessage(name) {
  return tri(
    `That overlaps another appointment for ${name}.`,
    `Se cruza con otra cita de ${name}.`,
    `与${name}的其他预约时间冲突。`,
  );
}

// Provider <option>s for the confirm form: every active provider, in the
// given (sort) order, with the request's current provider selected. If that
// provider has since been deactivated they're still included — selected,
// labelled "(inactive)" — so pressing Confirm never silently reassigns the
// request to whoever happens to be first in the list.
export function confirmProviderOptions(staffRows, currentStaffId) {
  return staffRows
    .filter((s) => s.active || s.id === currentStaffId)
    .map((s) => ({
      id: s.id,
      label: s.active ? s.name : `${s.name} (${t('inactive')})`,
      selected: s.id === currentStaffId,
    }));
}

// Coalesces reload requests while something on screen must not be wiped
// (an open confirm form). request() reloads now if nothing is held,
// otherwise remembers; hold() returns an idempotent release, and releasing
// the last hold runs one reload if any were requested meanwhile. reset()
// drops all holds and any pending request (the list was just re-rendered).
export function createDeferredReload(reload) {
  let holds = 0;
  let pending = false;
  let epoch = 0;
  return {
    request() {
      if (holds > 0) {
        pending = true;
        return;
      }
      pending = false;
      reload();
    },
    hold() {
      holds += 1;
      const myEpoch = epoch;
      let released = false;
      return () => {
        if (released || myEpoch !== epoch) return;
        released = true;
        holds -= 1;
        if (holds === 0 && pending) {
          pending = false;
          reload();
        }
      };
    },
    reset() {
      epoch += 1;
      holds = 0;
      pending = false;
    },
    // True while any hold is open (a load that finishes now should defer).
    get held() {
      return holds > 0;
    },
  };
}

const LENGTH_OPTIONS = [];
for (let m = 30; m <= 180; m += 15) LENGTH_OPTIONS.push(m);
const DEFAULT_LENGTH = 60;

// --- DOM ------------------------------------------------------------------

let state = null; // { supabase, show, onAvailabilityChanged }
let container = null;
let unsubscribeAvailability = null;
// Broadcast-triggered reloads wait while a confirm form is open, so staff
// mid-confirm never have the form closed under them.
const reloads = createDeferredReload(() => load());

function labelWithSelect(text, select) {
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  say(span, text);
  label.append(span, select);
  return label;
}

function buildCard(appt, staffNameById, staffRows) {
  const card = document.createElement('article');
  card.className = 'request-card';

  const { day, minutes } = salonParts(appt.starts_at);

  const when = document.createElement('p');
  when.className = 'request-when';
  when.textContent = `${formatDay(day)} · ${formatMinutes(minutes)}`;

  const services = document.createElement('p');
  services.className = 'request-services';
  services.textContent = Array.isArray(appt.services) ? appt.services.join(', ') : '';

  const provider = document.createElement('p');
  provider.className = 'request-provider';
  const providerName = staffNameById.get(appt.staff_id);
  if (providerName) provider.textContent = providerName;
  else say(provider, 'Unassigned');

  const name = document.createElement('p');
  name.className = 'request-name';
  if (appt.customer_name) name.textContent = appt.customer_name;
  else say(name, '(no name given)');

  card.append(when, services, provider, name);

  const notesText = requestNotes(appt);
  if (notesText) {
    const notes = document.createElement('p');
    notes.className = 'request-notes';
    notes.textContent = notesText;
    card.append(notes);
  }

  const contact = document.createElement('p');
  contact.className = 'request-contact';
  contact.textContent = [formatPhone(appt.phone), appt.email].filter(Boolean).join(' · ');
  card.appendChild(contact);

  const status = document.createElement('p');
  status.className = 'request-status';
  status.setAttribute('role', 'status');

  const lengthSelect = document.createElement('select');
  for (const m of LENGTH_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = `${m} min`;
    if (m === DEFAULT_LENGTH) opt.selected = true;
    lengthSelect.appendChild(opt);
  }

  const providerSelect = document.createElement('select');
  for (const o of confirmProviderOptions(staffRows, appt.staff_id)) {
    const opt = document.createElement('option');
    opt.value = String(o.id);
    opt.textContent = o.label;
    if (o.selected) opt.selected = true;
    providerSelect.appendChild(opt);
  }

  const confirmForm = document.createElement('form');
  confirmForm.className = 'confirm-form hidden';

  // Held while this card's confirm form is open (see `reloads`).
  let releaseHold = null;
  function setConfirmOpen(open) {
    confirmForm.classList.toggle('hidden', !open);
    if (open && !releaseHold) {
      releaseHold = reloads.hold();
    } else if (!open && releaseHold) {
      const release = releaseHold;
      releaseHold = null;
      release();
    }
  }
  const confirmSubmit = document.createElement('button');
  confirmSubmit.type = 'submit';
  confirmSubmit.className = 'btn btn-primary';
  say(confirmSubmit, 'Confirm booking');
  confirmForm.append(
    labelWithSelect('Length', lengthSelect),
    labelWithSelect('Provider', providerSelect),
    confirmSubmit
  );

  confirmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    confirmSubmit.disabled = true;
    status.textContent = '';
    const staffId = Number(providerSelect.value);
    const patch = confirmPatch(appt, Number(lengthSelect.value), staffId);
    const { error } = await state.supabase.from('appointments').update(patch).eq('id', appt.id);
    confirmSubmit.disabled = false;
    if (!state) return; // unmounted while saving
    if (error) {
      say(status, error.code === '23P01'
        ? overlapMessage(staffNameById.get(staffId) ?? 'this provider')
        : 'Could not confirm — try again.');
      return;
    }
    // It's no longer pending: drop the card now, then let any reload that
    // was waiting on this form run.
    card.remove();
    setConfirmOpen(false);
  });

  const actions = document.createElement('div');
  actions.className = 'request-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-confirm';
  say(confirmBtn, 'Confirm');
  confirmBtn.addEventListener('click', () => setConfirmOpen(confirmForm.classList.contains('hidden')));

  const declineBtn = document.createElement('button');
  declineBtn.type = 'button';
  declineBtn.className = 'btn btn-decline';
  say(declineBtn, 'Decline');
  declineBtn.addEventListener('click', async () => {
    declineBtn.disabled = true;
    status.textContent = '';
    const { error } = await state.supabase.from('appointments').update({ status: 'declined' }).eq('id', appt.id);
    declineBtn.disabled = false;
    if (!state) return; // unmounted while saving
    if (error) {
      say(status, 'Could not decline — try again.');
      return;
    }
    // Drop it now (a reload may be deferred behind another card's open
    // confirm form), and release this card's own hold if it had one.
    card.remove();
    setConfirmOpen(false);
  });

  actions.append(confirmBtn, declineBtn);
  card.append(actions, confirmForm, status);

  return card;
}

function render(appts, staffNameById, staffRows) {
  reloads.reset(); // every open confirm form is about to be replaced
  container.replaceChildren();
  if (appts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    say(empty, 'No pending requests.');
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'request-list';
  for (const appt of appts) list.appendChild(buildCard(appt, staffNameById, staffRows));
  container.appendChild(list);
}

async function load() {
  const [apptRes, staffRes] = await Promise.all([
    state.supabase.from('appointments').select('*').eq('status', 'pending').order('starts_at', { ascending: true }),
    state.supabase.from('staff').select('id,name,active').order('sort', { ascending: true }),
  ]);
  if (!container) return; // unmounted while the fetch was in flight
  // A confirm form was opened while this fetch was in flight: don't wipe
  // it — queue a fresh reload for when it closes instead.
  if (reloads.held) {
    reloads.request();
    return;
  }
  if (apptRes.error || staffRes.error) {
    container.replaceChildren();
    const p = document.createElement('p');
    p.className = 'error';
    say(p, 'Could not load requests — try again.');
    container.appendChild(p);
    return;
  }
  const staffRows = staffRes.data ?? [];
  const staffNameById = new Map(staffRows.map((s) => [s.id, s.name]));
  render(apptRes.data ?? [], staffNameById, staffRows);
}

function mount(root, ctx) {
  state = ctx;
  container = document.createElement('div');
  container.className = 'requests-view';
  root.replaceChildren(container);
  reloads.reset();
  load();
  unsubscribeAvailability = ctx.onAvailabilityChanged(() => reloads.request());
}

function unmount() {
  if (unsubscribeAvailability) {
    unsubscribeAvailability();
    unsubscribeAvailability = null;
  }
  reloads.reset();
  container = null;
  state = null;
}

export default { mount, unmount };
