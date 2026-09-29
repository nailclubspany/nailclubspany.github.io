// Pure availability calculations shared by the public booking form and the
// staff app. No DOM, no network, no imports — importable directly by node
// tests (tests/availability.test.mjs) and as a browser ES module.
//
// Consumes the `public_day` JSON shape (see
// supabase/migrations/20260928000002_public_api.sql):
//   { day, services: {name: requires|null}, staff: [{id,name,services}],
//     hours: [{staff_id,start_min,end_min}], off: [...], busy: [...] }
// Minutes are salon wall-clock minutes (0-1440) of that day.

export const SLOT_STEP = 15;
export const BLOCK_MIN = 60;
export const LEAD_MIN = 60;
export const HORIZON_DAYS = 60;
export const TZ = 'America/New_York';

// --- Salon clock -----------------------------------------------------------

// Salon (New York) wall-clock date and minute-of-day for an instant.
function salonPartsFromDate(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Today's date at the salon, regardless of the visitor's time zone.
export function salonToday(now) {
  return salonPartsFromDate(now).day;
}

// Salon wall-clock day/minutes for an ISO instant string.
export function salonParts(iso) {
  return salonPartsFromDate(new Date(iso));
}

// Absolute minutes (UTC-epoch minutes at that calendar day's midnight, plus
// minutes) — a scale on which two (day, minutes) pairs can be compared or
// subtracted regardless of time zone.
function absMinutes(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + minutes;
}

// ISO UTC instant for a given New York wall-clock day/minutes. Guesses the
// instant as if `minutes` were UTC, checks what that guess actually reads as
// on the NY clock, then corrects by the observed offset. This naturally
// handles DST because the correction is derived from the real clock, not a
// fixed UTC offset.
export function salonInstant(day, minutes) {
  const target = absMinutes(day, minutes);
  const guess = new Date(target * 60000);
  const observed = salonPartsFromDate(guess);
  const observedAbs = absMinutes(observed.day, observed.minutes);
  const corrected = new Date(guess.getTime() + (target - observedAbs) * 60000);
  return corrected.toISOString();
}

// --- Lead time / horizon -----------------------------------------------------

export function addDaysToIso(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Earliest bookable start minute for `day`, salon-now-aware:
//   null  — day is before salon-today, or after salon-today + HORIZON_DAYS
//   0     — a future day within the horizon (any start on that day is fine)
//   n     — today: salon-now-minutes + LEAD_MIN
export function earliestStart(day, now) {
  const today = salonToday(now);
  if (day < today) return null;
  if (day > addDaysToIso(today, HORIZON_DAYS)) return null;
  if (day === today) return salonPartsFromDate(now).minutes + LEAD_MIN;
  return 0;
}

// --- Services / staff --------------------------------------------------------

// Picked labels the database doesn't offer — e.g. a nail service the form
// knows about (js/services.mjs) whose migration hasn't been run yet.
export function unknownServices(dayData, labels) {
  return labels.filter((label) => !Object.hasOwn(dayData.services, label));
}

// --- Slots -------------------------------------------------------------------

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Whether `staffId` has a single hours row fully covering [m, m+BLOCK_MIN),
// with no overlapping off or busy block.
function staffCovers(dayData, staffId, m) {
  const end = m + BLOCK_MIN;
  const hasShift = dayData.hours.some(
    (h) => h.staff_id === staffId && h.start_min <= m && h.end_min >= end
  );
  if (!hasShift) return false;
  const blocked = [...dayData.off, ...dayData.busy].some(
    (b) => b.staff_id === staffId && overlaps(m, end, b.start_min, b.end_min)
  );
  return !blocked;
}

// Sorted distinct start minutes on the 15-min grid, at or after `earliest`,
// where any provider (or the chosen `staffId`, if given) has an unbroken
// shift covering the 60-min block with no off/busy overlap. Skills don't
// limit this: customers may pick anyone, and staff sort out a mismatch.
export function openSlots(dayData, staffId, earliest) {
  const candidates = staffId == null ? dayData.staff : dayData.staff.filter((s) => s.id === staffId);
  if (candidates.length === 0) return [];

  const start = Math.max(0, Math.ceil(earliest / SLOT_STEP) * SLOT_STEP);
  const slots = [];
  for (let m = start; m + BLOCK_MIN <= 1440; m += SLOT_STEP) {
    if (candidates.some((s) => staffCovers(dayData, s.id, m))) slots.push(m);
  }
  return slots;
}

// --- Formatting ---------------------------------------------------------

// Minute-of-day to '2:00 PM' style label.
export function formatMinutes(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}
