// Calendar view: day-per-provider and week-per-provider schedules, with
// tap-to-add/tap-to-edit booking via staff/booking-editor.mjs. Pure helpers
// (layoutDay, columnClass, weekdayOf, clipToDay, parseTimeMinutes) have no DOM/network and
// are imported directly by node tests. mount/unmount own the live Supabase
// reads and the realtime subscription — those are only exercised manually
// (a Supabase project is required; see the task report).
//
// Must never import app.mjs or the supabase-js CDN — that's what keeps the
// pure helpers importable by plain `node --test`.
import { salonParts, salonInstant, addDaysToIso, salonToday } from '../js/schedule.mjs';
import { formatDay } from './requests.mjs';
import editor from './booking-editor.mjs';
import { say, t } from './i18n.mjs';

// --- Pure helpers ------------------------------------------------------

// Default visible window (10:00–20:00), widened by any shift or appointment
// that falls outside it that day.
const DEFAULT_START = 600;
const DEFAULT_END = 1200;

// Statuses that ever get drawn as a block on the calendar. `declined` and
// `cancelled` appointments are dropped entirely (they don't hold time and
// staff don't need to see them here).
const VISIBLE_STATUSES = new Set(['pending', 'confirmed']);

// 'HH:MM:SS' (or 'HH:MM') -> minutes-of-day.
export function parseTimeMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Salon weekday (0=Sun..6=Sat, matching weekly_hours.weekday) for a
// 'YYYY-MM-DD' salon calendar date. Anchored at noon UTC so the date itself
// never shifts across the NY conversion (same trick as requests.mjs's
// formatDay).
export function weekdayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(noonUtc);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
}

// Clips a UTC instant range (e.g. a time_off or appointment row's
// starts_at/ends_at) to the portion that falls on salon calendar day `day`,
// in salon minutes-of-day (0–1440). A range that starts before `day` is
// clipped to start at 0; one that ends after `day` is clipped to end at
// 1440. Caller is expected to only call this for a (row, day) pair that
// actually intersects — see the day/eDay checks in staff/calendar.mjs's
// mount() where rows are split into per-day segments.
export function clipToDay(startsAt, endsAt, day) {
  const s = salonParts(startsAt);
  const e = salonParts(endsAt);
  const start = s.day < day ? 0 : s.minutes;
  const end = e.day > day ? 1440 : e.minutes;
  return { start, end };
}

/**
 * Lays out one salon day's shifts, time-off, and appointments into
 * per-provider columns of minute offsets, ready to render as absolutely
 * positioned blocks.
 *
 * @param {Array<{id:number|string, name:string, active:boolean}>} staff
 * @param {Array<{staffId:number|string, start:number, end:number}>} hours
 *   That weekday's shift(s) per provider, in salon minutes — already
 *   resolved by the caller from weekly_hours (parseTimeMinutes on
 *   start_time/end_time, pre-filtered to `day`'s weekday).
 * @param {Array<{staffId:number|string, start:number, end:number, day:string}>} off
 *   time_off rows converted to salon minutes via clipToDay and split per
 *   day; only entries whose `day` matches the `day` argument are used.
 * @param {Array<{id:number|string, staffId:number|string, start:number, end:number, status:string, day:string}>} appts
 *   appointments rows converted the same way as `off`, plus `status`
 *   (pending|confirmed|declined|cancelled) and the row's `id`.
 * @param {string} day - the salon calendar day ('YYYY-MM-DD') being laid
 *   out; `off`/`appts` entries whose `day` doesn't match are ignored.
 * @returns {{
 *   columns: Array<{staffId:number|string, name:string,
 *     shifts: Array<{top:number, height:number}>,
 *     off: Array<{top:number, height:number}>,
 *     blocks: Array<{id:number|string, top:number, height:number, status:string}>}>,
 *   startMin: number, endMin: number
 * }} top/height are minutes relative to `startMin`. `startMin`/`endMin` are
 *   the min/max of 600–1200 and any shift or (visible) appointment that day
 *   — so an appointment outside a provider's hours still gets a wide-enough
 *   grid to render in, even if it falls outside the default window.
 */
export function layoutDay(staff, hours, off, appts, day) {
  const dayOff = off.filter((o) => o.day === day);
  const dayAppts = appts.filter((a) => a.day === day && VISIBLE_STATUSES.has(a.status));

  let startMin = DEFAULT_START;
  let endMin = DEFAULT_END;
  for (const h of hours) {
    startMin = Math.min(startMin, h.start);
    endMin = Math.max(endMin, h.end);
  }
  for (const a of dayAppts) {
    startMin = Math.min(startMin, a.start);
    endMin = Math.max(endMin, a.end);
  }

  const apptStaffIds = new Set(dayAppts.map((a) => a.staffId));
  const columnStaff = staff.filter((s) => s.active || apptStaffIds.has(s.id));

  const columns = columnStaff.map((s) => ({
    staffId: s.id,
    name: s.name,
    shifts: hours
      .filter((h) => h.staffId === s.id)
      .map((h) => ({ top: h.start - startMin, height: h.end - h.start })),
    off: dayOff
      .filter((o) => o.staffId === s.id)
      .map((o) => ({ top: o.start - startMin, height: o.end - o.start })),
    blocks: dayAppts
      .filter((a) => a.staffId === s.id)
      .map((a) => ({ id: a.id, top: a.start - startMin, height: a.end - a.start, status: a.status })),
  }));

  return { columns, startMin, endMin };
}

// CSS class for a laid-out column: a provider (day view) or a day (week
// view) with no shift gets `no-shift`, drawn red so missing hours stand out.
export function columnClass(col) {
  return col.shifts.length ? 'day-col' : 'day-col no-shift';
}

// --- Conversion (DB rows -> layoutDay input shape) -------------------------

function hoursForWeekday(hoursRows, weekday) {
  return hoursRows
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ staffId: h.staff_id, start: parseTimeMinutes(h.start_time), end: parseTimeMinutes(h.end_time) }));
}

// Splits rows with starts_at/ends_at into the segment (if any) that falls on
// `day`, tagging each with the fields layoutDay's `off`/`appts` expect.
function segmentsForDay(rows, day, extra) {
  const out = [];
  for (const r of rows) {
    const sDay = salonParts(r.starts_at).day;
    const eDay = salonParts(r.ends_at).day;
    if (day < sDay || day > eDay) continue;
    const { start, end } = clipToDay(r.starts_at, r.ends_at, day);
    out.push({ staffId: r.staff_id, start, end, day, ...extra(r) });
  }
  return out;
}

function offSegmentsForDay(offRows, day) {
  return segmentsForDay(offRows, day, () => ({}));
}

function apptSegmentsForDay(apptRows, day) {
  return segmentsForDay(apptRows, day, (r) => ({ id: r.id, status: r.status }));
}

// Out-of-order-response guard for reload(). Each reload() call captures
// `bump()`'s return value before its first await; anything else that should
// invalidate in-flight requests (a newer reload(), mount(), unmount()) calls
// `bump()` again. A captured number is only `isCurrent` if nothing has
// bumped since — so a reload() that resolves after a later one (double-tap
// next-day, a mode/provider switch, or an unmount->remount) discards its
// result instead of drawing stale data into the current grid.
export function createLoadSequencer() {
  let seq = 0;
  return {
    bump() {
      seq += 1;
      return seq;
    },
    isCurrent(captured) {
      return captured === seq;
    },
  };
}

// A memoized async loader that *forgets* its cached promise on failure —
// either a soft failure (`fn()` resolves, but `isOk(value)` says no, e.g. a
// Supabase `{data, error}` response with `error` set) or a hard rejection
// (`fn()` throws, e.g. a network-level failure) — so the next call retries
// instead of permanently caching a bad result or a rejected promise.
// Concurrent callers made while a load is in flight all share that one
// call. Never rejects: a hard rejection from `fn` resolves as `fallback`
// (which must itself fail `isOk`, or the failure would wrongly get cached
// as success).
export function createForgetfulCache(fn, isOk, fallback) {
  let cached = null;
  return function load() {
    if (!cached) {
      cached = Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!isOk(value)) cached = null;
            return value;
          },
          () => {
            cached = null;
            return fallback;
          }
        );
    }
    return cached;
  };
}

// Minute-of-day for a tap `y` px down a day track that starts at
// `startMin` and ends at `endMin`: the 15-minute slot the tap landed IN
// (floored, so a tap in the lower half of 10:00-10:15 is still 10:00, not
// 10:15), clamped to the track's last slot.
export function tapMinute(y, startMin, endMin, pxPerMin = 1) {
  const minute = startMin + Math.floor(y / pxPerMin / 15) * 15;
  return Math.max(startMin, Math.min(endMin - 15, minute));
}

// --- DOM ------------------------------------------------------------------

const PX_PER_MIN = 1;

let state = null; // { supabase, show, onAvailabilityChanged }
let container = null;
let unsubscribeAvailability = null;
let gridHost = null;
let editorHost = null;

let mode = 'day'; // 'day' | 'week'
let currentDay = '';
let currentStaffId = null;
let staffList = [];
let servicesList = [];
let apptsById = new Map();
// See createLoadSequencer() above. A single persistent instance whose
// counter only ever goes up (never reassigned/reset) — mount() and
// unmount() both bump() it, so a captured seq from a prior mount can never
// collide with one from a later mount.
const seqr = createLoadSequencer();
let staticDataLoaded = false;
// A forgetful cache (see createForgetfulCache() above) around the
// staff/services fetch: dedupes concurrent callers (mount()'s own reload()
// and the toolbar's provider-list prefetch both call ensureStaticData())
// so they share one fetch, and forgets on *any* failure — a Supabase
// `{error}` response or a hard rejection (network-level throw) — so the
// next call retries instead of getting stuck replaying a cached failure
// forever. Reassigned fresh in mount() so a new mount always starts clean.
let staticDataCache = createForgetfulCache(loadStaticData, (r) => r.ok, { ok: false });

async function loadStaticData() {
  const [staffRes, servicesRes] = await Promise.all([
    state.supabase.from('staff').select('id,name,active,sort').order('sort', { ascending: true }),
    state.supabase.from('services').select('name,requires').order('name', { ascending: true }),
  ]);
  if (staffRes.error || servicesRes.error) return { ok: false };
  return { ok: true, staff: staffRes.data ?? [], services: servicesRes.data ?? [] };
}

const LOAD_ERROR_COPY = "Couldn't load the schedule — check the connection and try again.";

// Resolves true once staff/services are loaded, false if the query failed
// (soft error or hard rejection — see createForgetfulCache()).
async function ensureStaticData() {
  if (staticDataLoaded) return true;
  const result = await staticDataCache();
  if (!result.ok) return false;
  staffList = result.staff;
  servicesList = result.services;
  if (currentStaffId == null) {
    currentStaffId = staffList.find((s) => s.active)?.id ?? staffList[0]?.id ?? null;
  }
  staticDataLoaded = true;
  return true;
}

async function fetchRange(staffIdFilter, startDay, endDayExclusive) {
  const startIso = salonInstant(startDay, 0);
  const endIso = salonInstant(endDayExclusive, 0);
  let hoursQuery = state.supabase.from('weekly_hours').select('staff_id,weekday,start_time,end_time');
  let offQuery = state.supabase.from('time_off').select('staff_id,starts_at,ends_at,note').lt('starts_at', endIso).gt('ends_at', startIso);
  let apptQuery = state.supabase
    .from('appointments')
    .select('id,staff_id,services,starts_at,ends_at,status,customer_name,phone,email,notes,source')
    .lt('starts_at', endIso)
    .gt('ends_at', startIso);
  if (staffIdFilter != null) {
    hoursQuery = hoursQuery.eq('staff_id', staffIdFilter);
    offQuery = offQuery.eq('staff_id', staffIdFilter);
    apptQuery = apptQuery.eq('staff_id', staffIdFilter);
  }
  const [hoursRes, offRes, apptRes] = await Promise.all([hoursQuery, offQuery, apptQuery]);
  const error = hoursRes.error || offRes.error || apptRes.error || null;
  return { hoursRows: hoursRes.data ?? [], offRows: offRes.data ?? [], apptRows: apptRes.data ?? [], error };
}

function openEditorFor({ day, staffId, startMin, appt }) {
  editorHost.classList.remove('hidden');
  editor.open(editorHost, state, {
    staffList,
    services: servicesList,
    day,
    staffId,
    startMin,
    appt,
    onSaved: reload,
    onClose: () => editorHost.classList.add('hidden'),
  });
}

function blockLabel(appt) {
  const svc = Array.isArray(appt?.services) ? appt.services.join(', ') : '';
  const name = appt?.customer_name || '(no name)';
  return svc ? `${name} — ${svc}` : name;
}

function renderTrack(col, startMin, endMin, onEmptyClick, onBlockClick) {
  const track = document.createElement('div');
  track.className = 'day-col-track';
  track.style.height = `${(endMin - startMin) * PX_PER_MIN}px`;

  for (const shift of col.shifts) {
    const el = document.createElement('div');
    el.className = 'shift-block';
    el.style.top = `${shift.top * PX_PER_MIN}px`;
    el.style.height = `${shift.height * PX_PER_MIN}px`;
    track.appendChild(el);
  }
  for (const o of col.off) {
    const el = document.createElement('div');
    el.className = 'off-block';
    el.style.top = `${o.top * PX_PER_MIN}px`;
    el.style.height = `${o.height * PX_PER_MIN}px`;
    track.appendChild(el);
  }
  for (const b of col.blocks) {
    const appt = apptsById.get(b.id);
    const el = document.createElement('div');
    el.className = `appt-block appt-${b.status}`;
    el.style.top = `${b.top * PX_PER_MIN}px`;
    el.style.height = `${Math.max(b.height, 15) * PX_PER_MIN}px`;
    if (b.status === 'pending') {
      const tag = document.createElement('span');
      tag.className = 'appt-tag';
      say(tag, 'Pending');
      el.append(tag);
    }
    el.append(blockLabel(appt));
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onBlockClick(b.id);
    });
    track.appendChild(el);
  }

  track.addEventListener('click', (e) => {
    if (e.target !== track) return; // a block/shift click already stopped propagation
    const rect = track.getBoundingClientRect();
    const y = e.clientY - rect.top;
    onEmptyClick(tapMinute(y, startMin, endMin, PX_PER_MIN));
  });

  return track;
}

function renderColumn(headerText, col, startMin, endMin, onEmptyClick, onBlockClick) {
  const wrap = document.createElement('div');
  wrap.className = columnClass(col);
  if (!col.shifts.length) wrap.title = t('No shift entered');
  const header = document.createElement('div');
  header.className = 'day-col-header';
  header.textContent = headerText;
  wrap.append(header, renderTrack(col, startMin, endMin, onEmptyClick, onBlockClick));
  return wrap;
}

function renderHourGutter(startMin, endMin) {
  const gutter = document.createElement('div');
  gutter.className = 'hour-gutter';
  const spacer = document.createElement('div');
  spacer.className = 'day-col-header';
  gutter.appendChild(spacer);
  const track = document.createElement('div');
  track.className = 'hour-gutter-track';
  track.style.height = `${(endMin - startMin) * PX_PER_MIN}px`;
  for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) {
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.top = `${(m - startMin) * PX_PER_MIN}px`;
    const h = Math.floor(m / 60);
    const h12 = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    label.textContent = `${h12} ${ampm}`;
    track.appendChild(label);
  }
  gutter.appendChild(track);
  return gutter;
}

function handleBlockClick(day, id) {
  const appt = apptsById.get(id);
  if (!appt) return;
  const parts = salonParts(appt.starts_at);
  openEditorFor({ day: parts.day, staffId: appt.staff_id, startMin: parts.minutes, appt });
}

function renderDayGrid(layout) {
  gridHost.replaceChildren();
  const row = document.createElement('div');
  row.className = 'day-grid';
  row.appendChild(renderHourGutter(layout.startMin, layout.endMin));
  for (const col of layout.columns) {
    row.appendChild(
      renderColumn(
        col.name,
        col,
        layout.startMin,
        layout.endMin,
        (minute) => openEditorFor({ day: currentDay, staffId: col.staffId, startMin: minute, appt: null }),
        (id) => handleBlockClick(currentDay, id)
      )
    );
  }
  gridHost.appendChild(row);
}

function renderWeekGrid(dayLayouts) {
  gridHost.replaceChildren();
  const startMin = Math.min(...dayLayouts.map((d) => d.layout.startMin));
  const endMin = Math.max(...dayLayouts.map((d) => d.layout.endMin));

  const row = document.createElement('div');
  row.className = 'day-grid';
  row.appendChild(renderHourGutter(startMin, endMin));
  for (const { day, layout } of dayLayouts) {
    const col = layout.columns[0] ?? { staffId: currentStaffId, name: '', shifts: [], off: [], blocks: [] };
    const offset = layout.startMin - startMin;
    const shifted = {
      ...col,
      shifts: col.shifts.map((b) => ({ ...b, top: b.top + offset })),
      off: col.off.map((b) => ({ ...b, top: b.top + offset })),
      blocks: col.blocks.map((b) => ({ ...b, top: b.top + offset })),
    };
    row.appendChild(
      renderColumn(
        formatDay(day),
        shifted,
        startMin,
        endMin,
        (minute) => openEditorFor({ day, staffId: currentStaffId, startMin: minute, appt: null }),
        (id) => handleBlockClick(day, id)
      )
    );
  }
  gridHost.appendChild(row);
}

function showError(message) {
  if (!gridHost) return;
  gridHost.replaceChildren();
  const p = document.createElement('p');
  p.className = 'error';
  say(p, message);
  gridHost.appendChild(p);
}

// Captures a sequence number before its first await so a response that
// resolves after a newer reload() (or a mount()/unmount()) can tell it's
// stale and discard itself instead of drawing into the current grid — see
// createLoadSequencer() above. Query/network failures render a visible
// error instead of silently falling back to an empty (falsely "free")
// calendar.
async function reload() {
  const seq = seqr.bump();
  if (!container) return;
  try {
    const staticOk = await ensureStaticData();
    if (!seqr.isCurrent(seq) || !container) return;
    if (!staticOk) {
      showError(LOAD_ERROR_COPY);
      return;
    }
    if (mode === 'day') {
      const { hoursRows, offRows, apptRows, error } = await fetchRange(null, currentDay, addDaysToIso(currentDay, 1));
      if (!seqr.isCurrent(seq) || !container) return;
      if (error) {
        showError(LOAD_ERROR_COPY);
        return;
      }
      apptsById = new Map(apptRows.map((r) => [r.id, r]));
      const hours = hoursForWeekday(hoursRows, weekdayOf(currentDay));
      const off = offSegmentsForDay(offRows, currentDay);
      const appts = apptSegmentsForDay(apptRows, currentDay);
      renderDayGrid(layoutDay(staffList, hours, off, appts, currentDay));
    } else {
      const weekStart = addDaysToIso(currentDay, -weekdayOf(currentDay));
      const weekEndExclusive = addDaysToIso(weekStart, 7);
      const { hoursRows, offRows, apptRows, error } = await fetchRange(currentStaffId, weekStart, weekEndExclusive);
      if (!seqr.isCurrent(seq) || !container) return;
      if (error) {
        showError(LOAD_ERROR_COPY);
        return;
      }
      apptsById = new Map(apptRows.map((r) => [r.id, r]));
      const staffObj = staffList.find((s) => s.id === currentStaffId);
      const days = Array.from({ length: 7 }, (_, i) => addDaysToIso(weekStart, i));
      const dayLayouts = days.map((day) => ({
        day,
        layout: staffObj
          ? layoutDay([staffObj], hoursForWeekday(hoursRows, weekdayOf(day)), offSegmentsForDay(offRows, day), apptSegmentsForDay(apptRows, day), day)
          : { columns: [], startMin: DEFAULT_START, endMin: DEFAULT_END },
      }));
      renderWeekGrid(dayLayouts);
    }
  } catch {
    if (seqr.isCurrent(seq) && container) showError(LOAD_ERROR_COPY);
  }
}

function buildToolbar() {
  const bar = document.createElement('div');
  bar.className = 'calendar-toolbar';

  const modeGroup = document.createElement('div');
  modeGroup.className = 'mode-toggle';
  const dayBtn = document.createElement('button');
  dayBtn.type = 'button';
  say(dayBtn, 'Day|view');
  const weekBtn = document.createElement('button');
  weekBtn.type = 'button';
  say(weekBtn, 'Week');
  modeGroup.append(dayBtn, weekBtn);

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn';
  prevBtn.textContent = '‹';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn';
  nextBtn.textContent = '›';

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = currentDay;

  const providerSelect = document.createElement('select');
  providerSelect.className = 'week-provider hidden';

  function refreshProviderOptions() {
    providerSelect.replaceChildren(...staffList.map((s) => new Option(s.name, String(s.id), false, s.id === currentStaffId)));
  }

  function syncModeButtons() {
    dayBtn.setAttribute('aria-current', mode === 'day' ? 'page' : 'false');
    weekBtn.setAttribute('aria-current', mode === 'week' ? 'page' : 'false');
    providerSelect.classList.toggle('hidden', mode !== 'week');
  }

  dayBtn.addEventListener('click', () => {
    if (mode === 'day') return;
    mode = 'day';
    syncModeButtons();
    reload();
  });
  weekBtn.addEventListener('click', async () => {
    if (mode === 'week') return;
    await ensureStaticData();
    refreshProviderOptions();
    mode = 'week';
    syncModeButtons();
    reload();
  });
  providerSelect.addEventListener('change', () => {
    currentStaffId = Number(providerSelect.value);
    reload();
  });
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    currentDay = dateInput.value;
    reload();
  });
  prevBtn.addEventListener('click', () => {
    currentDay = addDaysToIso(currentDay, mode === 'week' ? -7 : -1);
    dateInput.value = currentDay;
    reload();
  });
  nextBtn.addEventListener('click', () => {
    currentDay = addDaysToIso(currentDay, mode === 'week' ? 7 : 1);
    dateInput.value = currentDay;
    reload();
  });

  syncModeButtons();
  ensureStaticData().then(refreshProviderOptions);

  bar.append(modeGroup, prevBtn, dateInput, nextBtn, providerSelect);
  return bar;
}

function mount(root, ctx) {
  // Invalidate any reload() still in flight from a prior mount (its
  // captured seq can now never be current again) before this mount's own
  // reload() captures a new one.
  seqr.bump();
  state = ctx;
  staticDataLoaded = false;
  staticDataCache = createForgetfulCache(loadStaticData, (r) => r.ok, { ok: false });
  staffList = [];
  servicesList = [];
  currentStaffId = null;
  apptsById = new Map();
  mode = 'day';
  currentDay = salonToday(new Date());

  container = document.createElement('div');
  container.className = 'calendar-view';

  container.appendChild(buildToolbar());

  gridHost = document.createElement('div');
  gridHost.className = 'day-grid-scroll';
  container.appendChild(gridHost);

  editorHost = document.createElement('div');
  editorHost.className = 'editor-host hidden';
  container.appendChild(editorHost);

  root.replaceChildren(container);
  reload();

  // The shell owns the channel; we just listen (see staff/app.mjs).
  unsubscribeAvailability = ctx.onAvailabilityChanged((day) => {
    if (!day) return;
    if (mode === 'day') {
      if (day === currentDay) reload();
    } else {
      const weekStart = addDaysToIso(currentDay, -weekdayOf(currentDay));
      const weekEndExclusive = addDaysToIso(weekStart, 7);
      if (day >= weekStart && day < weekEndExclusive) reload();
    }
  });
}

function unmount() {
  // Invalidate any reload() still in flight from this mount so it can't
  // draw stale data into whatever mounts next.
  seqr.bump();
  if (unsubscribeAvailability) {
    unsubscribeAvailability();
    unsubscribeAvailability = null;
  }
  container = null;
  gridHost = null;
  editorHost = null;
  state = null;
}

export default { mount, unmount };
