// Schedules view: per-provider weekly hours editor and time-off list. Pure
// helpers (`validateShifts`) have no DOM/network and are imported directly
// by node tests. mount/unmount own the live Supabase reads/writes — those
// are only exercised manually (a Supabase project is required; see the task
// report).
//
// Must never import app.mjs or the supabase-js CDN — that's what keeps the
// pure helpers importable by plain `node --test`.
import { salonInstant, addDaysToIso, salonParts, formatMinutes } from '../js/schedule.mjs';
import { parseTimeMinutes, createLoadSequencer } from './calendar.mjs';
import { formatDay } from './requests.mjs';
import { say, t, lookup, tri } from './i18n.mjs';

// --- Pure helpers ------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_SHIFT = { start: '10:00', end: '20:00' };

const FIRST_OPTION_MIN = 6 * 60; // 6:00 AM
const LAST_OPTION_MIN = 23 * 60 + 30; // 11:30 PM

function hhmm(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Choices for the time dropdowns: every half hour 6:00 AM–11:30 PM. A saved
// `current` value off that grid (e.g. an older '10:15') is slotted in at its
// place so re-saving never silently changes someone's hours.
export function timeOptions(current = '') {
  const minutes = [];
  for (let m = FIRST_OPTION_MIN; m <= LAST_OPTION_MIN; m += 30) minutes.push(m);
  if (current) {
    const extra = parseTimeMinutes(current);
    if (!minutes.includes(extra)) {
      minutes.push(extra);
      minutes.sort((a, b) => a - b);
    }
  }
  return minutes.map((m) => ({ value: hhmm(m), label: formatMinutes(m) }));
}

// Validates a full set of a provider's weekly-hours rows before save.
// Returns a message ({en, es, zh}) for the first problem found, else null:
//   - any row where end <= start -> 'End must be after start'
//   - two rows on the same weekday whose [start,end) ranges overlap ->
//     '<Weekday> shifts overlap' (back-to-back rows, end === next start,
//     are allowed — that's a split-shift boundary, not an overlap)
export function validateShifts(rows) {
  for (const row of rows) {
    if (parseTimeMinutes(row.end) <= parseTimeMinutes(row.start)) {
      return lookup('End must be after start');
    }
  }

  const byWeekday = new Map();
  for (const row of rows) {
    if (!byWeekday.has(row.weekday)) byWeekday.set(row.weekday, []);
    byWeekday.get(row.weekday).push(row);
  }

  for (const [weekday, shifts] of byWeekday) {
    const sorted = [...shifts].sort((a, b) => parseTimeMinutes(a.start) - parseTimeMinutes(b.start));
    for (let i = 1; i < sorted.length; i += 1) {
      if (parseTimeMinutes(sorted[i].start) < parseTimeMinutes(sorted[i - 1].end)) {
        const day = lookup(WEEKDAY_NAMES[weekday]);
        return tri(
          `${day.en} shifts overlap`,
          `Los turnos del ${day.es.toLowerCase()} se cruzan`,
          `${day.zh}的班次时间重叠`,
        );
      }
    }
  }

  return null;
}

// Builds a time_off insert row from the add-time-off form's fields. All-day
// spans midnight-to-midnight (salonInstant(day,0) -> salonInstant(day+1,0));
// a partial span is salonInstant(day,from) -> salonInstant(day,to) — see the
// task 7 controller ruling.
function timeOffPayload(staffId, { day, allDay, from, to, note }) {
  const startsAt = allDay ? salonInstant(day, 0) : salonInstant(day, parseTimeMinutes(from));
  const endsAt = allDay ? salonInstant(addDaysToIso(day, 1), 0) : salonInstant(day, parseTimeMinutes(to));
  return { staff_id: staffId, starts_at: startsAt, ends_at: endsAt, note: note || null };
}

// --- DOM ------------------------------------------------------------------

const LOAD_ERROR_COPY = "Couldn't load schedules — check the connection and try again.";
const SAVE_ERROR_COPY = 'Could not save hours — try again.';
const TIME_OFF_ERROR_COPY = 'Could not save — try again.';
const DELETE_ERROR_COPY = 'Could not delete — try again.';

let state = null; // { supabase, show, onAvailabilityChanged } (only show/supabase used here)
let container = null;
let providerSelect = null;
let hoursForm = null;
let hoursStatus = null;
let timeOffList = null;
let timeOffForm = null;
let timeOffStatus = null;
let weekdaySections = [];

let staffList = [];
let currentStaffId = null;
let currentHoursIds = []; // ids of the rows currently saved for currentStaffId

// Out-of-order-response guard for reload()/reloadProvider() — see
// staff/calendar.mjs's createLoadSequencer for the contract.
const seqr = createLoadSequencer();

function timeSelect(value, className) {
  const select = document.createElement('select');
  select.className = className;
  select.required = true;
  // defaultSelected too, so form.reset() returns to this value, not 6:00 AM.
  for (const { value: v, label } of timeOptions(value)) select.add(new Option(label, v, v === value, v === value));
  return select;
}

function shiftRow(start = DEFAULT_SHIFT.start, end = DEFAULT_SHIFT.end) {
  const row = document.createElement('div');
  row.className = 'shift-row';

  const startInput = timeSelect(start, 'shift-start');

  const sep = document.createElement('span');
  sep.className = 'shift-sep';
  sep.textContent = '–';

  const endInput = timeSelect(end, 'shift-end');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn shift-remove-btn';
  say(removeBtn, 'Remove');
  removeBtn.addEventListener('click', () => row.remove());

  row.append(startInput, sep, endInput, removeBtn);
  return row;
}

function weekdaySection(weekday) {
  const section = document.createElement('div');
  section.className = 'weekday-section';
  section.dataset.weekday = String(weekday);

  const h3 = document.createElement('h3');
  say(h3, WEEKDAY_NAMES[weekday]);

  const rows = document.createElement('div');
  rows.className = 'shift-rows';
  rows.dataset.empty = t('Off'); // shown by CSS while the day has no shifts

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn shift-add-btn';
  say(addBtn, 'Add shift');
  addBtn.addEventListener('click', () => rows.appendChild(shiftRow()));

  section.append(h3, rows, addBtn);
  return { section, rows };
}

function buildHoursForm() {
  const form = document.createElement('form');
  form.className = 'hours-form';

  const title = document.createElement('h2');
  say(title, 'Weekly hours');
  const hint = document.createElement('p');
  hint.className = 'hours-hint';
  say(hint, 'These repeat every week. For one date (a day off or a short day), use Time off below.');
  form.append(title, hint);

  // One row of seven day columns, Sunday–Saturday (scrolls sideways on phones).
  const week = document.createElement('div');
  week.className = 'week-grid';
  weekdaySections = Array.from({ length: 7 }, (_, weekday) => weekdaySection(weekday));
  for (const { section } of weekdaySections) week.appendChild(section);
  form.appendChild(week);

  hoursStatus = document.createElement('p');
  hoursStatus.className = 'hours-status';
  hoursStatus.setAttribute('role', 'alert');

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  say(saveBtn, 'Save hours');

  form.append(hoursStatus, saveBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = collectShiftRows();
    const problem = validateShifts(rows);
    if (problem) {
      say(hoursStatus, problem);
      return;
    }
    saveBtn.disabled = true;
    hoursStatus.textContent = '';
    await saveHours(rows);
    saveBtn.disabled = false;
  });

  return form;
}

function collectShiftRows() {
  const rows = [];
  for (const { section, rows: rowsHost } of weekdaySections) {
    const weekday = Number(section.dataset.weekday);
    for (const rowEl of rowsHost.querySelectorAll('.shift-row')) {
      const start = rowEl.querySelector('.shift-start').value;
      const end = rowEl.querySelector('.shift-end').value;
      rows.push({ weekday, start, end });
    }
  }
  return rows;
}

function renderHours(hoursRows) {
  currentHoursIds = hoursRows.map((h) => h.id);
  for (const { rows } of weekdaySections) rows.replaceChildren();
  for (const h of hoursRows) {
    const { rows } = weekdaySections[h.weekday];
    rows.appendChild(shiftRow(h.start_time.slice(0, 5), h.end_time.slice(0, 5)));
  }
}

async function saveHours(rows) {
  const staffId = currentStaffId;
  const oldIds = currentHoursIds;
  const insertRows = rows.map((r) => ({ staff_id: staffId, weekday: r.weekday, start_time: r.start, end_time: r.end }));

  // Insert the new rows first, then delete the old ones by id — a write
  // failure at any point leaves the previously-saved hours intact instead
  // of losing them.
  if (insertRows.length > 0) {
    const { error: insertError } = await state.supabase.from('weekly_hours').insert(insertRows);
    if (insertError) {
      say(hoursStatus, SAVE_ERROR_COPY);
      await reloadProvider();
      return;
    }
  }
  if (oldIds.length > 0) {
    const { error: deleteError } = await state.supabase.from('weekly_hours').delete().in('id', oldIds);
    if (deleteError) {
      say(hoursStatus, SAVE_ERROR_COPY);
      await reloadProvider();
      return;
    }
  }
  say(hoursStatus, 'Saved.');
  await reloadProvider();
}

function describeTimeOff(row) {
  const s = salonParts(row.starts_at);
  const e = salonParts(row.ends_at);
  const isAllDay = s.minutes === 0 && e.minutes === 0 && addDaysToIso(s.day, 1) === e.day;
  const when = isAllDay
    ? `${formatDay(s.day)} — ${t('all day')}`
    : `${formatDay(s.day)} · ${formatMinutes(s.minutes)}–${formatMinutes(e.minutes)}`;
  return row.note ? `${when} — ${row.note}` : when;
}

function renderTimeOff(offRows) {
  timeOffList.replaceChildren();
  if (offRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    say(empty, 'No upcoming time off.');
    timeOffList.appendChild(empty);
    return;
  }
  for (const row of offRows) {
    const item = document.createElement('div');
    item.className = 'time-off-item';

    const label = document.createElement('span');
    label.textContent = describeTimeOff(row);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-decline';
    say(deleteBtn, 'Delete');
    deleteBtn.addEventListener('click', async () => {
      deleteBtn.disabled = true;
      timeOffStatus.textContent = '';
      const { error } = await state.supabase.from('time_off').delete().eq('id', row.id);
      if (error) {
        say(timeOffStatus, DELETE_ERROR_COPY);
        deleteBtn.disabled = false;
        return;
      }
      await reloadProvider();
    });

    item.append(label, deleteBtn);
    timeOffList.appendChild(item);
  }
}

function buildTimeOffSection() {
  const section = document.createElement('section');
  section.className = 'time-off-section';

  const h2 = document.createElement('h2');
  say(h2, 'Time off');

  timeOffList = document.createElement('div');
  timeOffList.className = 'time-off-list';

  timeOffForm = document.createElement('form');
  timeOffForm.className = 'time-off-form';

  const dayField = document.createElement('label');
  dayField.className = 'field';
  const daySpan = document.createElement('span');
  say(daySpan, 'Day');
  const dayInput = document.createElement('input');
  dayInput.type = 'date';
  dayInput.required = true;
  dayField.append(daySpan, dayInput);

  const allDayLabel = document.createElement('label');
  allDayLabel.className = 'all-day-check';
  const allDayInput = document.createElement('input');
  allDayInput.type = 'checkbox';
  allDayInput.checked = true;
  const allDaySpan = document.createElement('span');
  say(allDaySpan, 'All day');
  allDayLabel.append(allDayInput, allDaySpan);

  const range = document.createElement('div');
  range.className = 'time-off-range hidden';
  const fromField = document.createElement('label');
  fromField.className = 'field';
  const fromSpan = document.createElement('span');
  say(fromSpan, 'From');
  const fromInput = timeSelect(DEFAULT_SHIFT.start, 'time-off-from');
  fromField.append(fromSpan, fromInput);
  const toField = document.createElement('label');
  toField.className = 'field';
  const toSpan = document.createElement('span');
  say(toSpan, 'To');
  const toInput = timeSelect(DEFAULT_SHIFT.end, 'time-off-to');
  toField.append(toSpan, toInput);
  range.append(fromField, toField);

  function syncAllDay() {
    const isAllDay = allDayInput.checked;
    range.classList.toggle('hidden', isAllDay);
    fromInput.required = !isAllDay;
    toInput.required = !isAllDay;
  }
  allDayInput.addEventListener('change', syncAllDay);
  syncAllDay();

  const noteField = document.createElement('label');
  noteField.className = 'field';
  const noteSpan = document.createElement('span');
  say(noteSpan, 'Note (optional)');
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteField.append(noteSpan, noteInput);

  timeOffStatus = document.createElement('p');
  timeOffStatus.className = 'time-off-status';
  timeOffStatus.setAttribute('role', 'alert');

  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.className = 'btn';
  say(addBtn, 'Add time off');

  timeOffForm.append(dayField, allDayLabel, range, noteField, timeOffStatus, addBtn);

  timeOffForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const allDay = allDayInput.checked;
    if (!allDay && parseTimeMinutes(toInput.value) <= parseTimeMinutes(fromInput.value)) {
      say(timeOffStatus, 'End must be after start');
      return;
    }
    addBtn.disabled = true;
    timeOffStatus.textContent = '';
    const payload = timeOffPayload(currentStaffId, {
      day: dayInput.value,
      allDay,
      from: fromInput.value,
      to: toInput.value,
      note: noteInput.value.trim(),
    });
    const { error } = await state.supabase.from('time_off').insert(payload);
    addBtn.disabled = false;
    if (error) {
      say(timeOffStatus, TIME_OFF_ERROR_COPY);
      return;
    }
    timeOffForm.reset();
    allDayInput.checked = true;
    syncAllDay();
    await reloadProvider();
  });

  section.append(h2, timeOffList, timeOffForm);
  return section;
}

function showError(message) {
  if (!container) return;
  say(hoursStatus, message);
  timeOffStatus.textContent = '';
}

async function loadStaff() {
  const { data, error } = await state.supabase.from('staff').select('id,name,active,sort').order('sort', { ascending: true });
  return { rows: data ?? [], error };
}

async function loadProviderData(staffId) {
  const [hoursRes, offRes] = await Promise.all([
    state.supabase.from('weekly_hours').select('id,weekday,start_time,end_time').eq('staff_id', staffId).order('start_time', { ascending: true }),
    state.supabase
      .from('time_off')
      .select('id,starts_at,ends_at,note')
      .eq('staff_id', staffId)
      .gte('ends_at', new Date().toISOString())
      .order('starts_at', { ascending: true }),
  ]);
  return {
    hoursRows: hoursRes.data ?? [],
    offRows: offRes.data ?? [],
    error: hoursRes.error || offRes.error || null,
  };
}

function refreshProviderOptions() {
  providerSelect.replaceChildren(
    ...staffList.map((s) => new Option(s.active ? s.name : `${s.name} (${t('inactive')})`, String(s.id), false, s.id === currentStaffId))
  );
}

async function reloadProvider() {
  const seq = seqr.bump();
  if (!container || currentStaffId == null) return;
  const { hoursRows, offRows, error } = await loadProviderData(currentStaffId);
  if (!seqr.isCurrent(seq) || !container) return;
  if (error) {
    showError(LOAD_ERROR_COPY);
    return;
  }
  renderHours(hoursRows);
  renderTimeOff(offRows);
}

async function reload() {
  const seq = seqr.bump();
  if (!container) return;
  const { rows, error } = await loadStaff();
  if (!seqr.isCurrent(seq) || !container) return;
  if (error) {
    showError(LOAD_ERROR_COPY);
    return;
  }
  staffList = rows;
  if (currentStaffId == null || !staffList.some((s) => s.id === currentStaffId)) {
    currentStaffId = staffList.find((s) => s.active)?.id ?? staffList[0]?.id ?? null;
  }
  refreshProviderOptions();
  await reloadProvider();
}

function mount(root, ctx) {
  seqr.bump();
  state = ctx;
  staffList = [];
  currentStaffId = null;
  currentHoursIds = [];

  container = document.createElement('div');
  container.className = 'schedules-view';

  const pickerLabel = document.createElement('label');
  pickerLabel.className = 'field provider-picker-field';
  const pickerSpan = document.createElement('span');
  say(pickerSpan, 'Provider');
  providerSelect = document.createElement('select');
  providerSelect.className = 'provider-picker';
  providerSelect.addEventListener('change', () => {
    currentStaffId = Number(providerSelect.value);
    reloadProvider();
  });
  pickerLabel.append(pickerSpan, providerSelect);

  hoursForm = buildHoursForm();

  container.append(pickerLabel, hoursForm, buildTimeOffSection());
  root.replaceChildren(container);

  reload();
}

function unmount() {
  seqr.bump();
  container = null;
  providerSelect = null;
  hoursForm = null;
  hoursStatus = null;
  timeOffList = null;
  timeOffForm = null;
  timeOffStatus = null;
  weekdaySections = [];
  state = null;
}

export default { mount, unmount };
