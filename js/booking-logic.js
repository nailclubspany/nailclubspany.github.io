// Pure helpers (no DOM) — tested by tests/booking.test.mjs
function localISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isPastDate(iso, today) {
  return iso < localISODate(today);
}

function buildBookingMailto(data, to) {
  const body = [
    `Name: ${data.name}`,
    `Phone: ${data.phone}`,
    `Email: ${data.email}`,
    `Service: ${data.service}`,
    `Technician: ${data.technician ? data.technician : 'No preference'}`,
    `Preferred date: ${data.date}`,
    `Preferred time: ${data.time}`,
    `Notes: ${data.notes ? data.notes : '(none)'}`,
  ].join('\r\n');
  const subject = `Appointment request – ${data.name}`;
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// JSON payload for Web3Forms, which emails it to the inbox that owns the access key.
// `held` marks a request that was already booked live (server-side hold) rather than
// merely requested — the subject and an extra status field flag it for staff.
// `held`: true = saved online as a Pending hold; a string = live booking
// could NOT save it (the string says why, for staff); false = email-only form.
function buildBookingSubmission(data, accessKey, held = false) {
  const notSaved = typeof held === 'string';
  const tag = notSaved ? ' (NOT saved online)' : held ? ' (held)' : '';
  const payload = {
    access_key: accessKey,
    subject: `Appointment request${tag} – ${data.name}`,
    from_name: 'Nail Club Spa NY',
    name: data.name,
    phone: data.phone,
    email: data.email,
    service: data.service,
    technician: data.technician ? data.technician : 'No preference',
    'preferred date': data.date,
    'preferred time': data.time,
    notes: data.notes ? data.notes : '(none)',
  };
  if (notSaved) payload.status = held;
  else if (held) payload.status = 'Held online — confirm in the staff app';
  return payload;
}

// Opening hours in minutes after midnight, keyed by day (0 = Sunday). Keep in sync with the Hours table.
const SALON_HOURS = { 0: [600, 1140], 1: [600, 1200], 2: [600, 1200], 3: [600, 1200], 4: [600, 1200], 5: [600, 1200], 6: [600, 1200] };
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Day and time at the salon (New York), regardless of the visitor's time zone.
function salonClock(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { day: WEEKDAYS[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function formatHour(minutes) {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
}

// Bookable start times for a weekday: every 15 minutes from opening until 15 minutes before close.
function timeSlots(day) {
  const [open, close] = SALON_HOURS[day];
  const slots = [];
  for (let m = open; m <= close - 30; m += 15) { // last appointment 30 min before close
    const h = Math.floor(m / 60);
    slots.push(`${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`);
  }
  return slots;
}

// Weekday (0 = Sunday) of a YYYY-MM-DD date as written, independent of time zone.
function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function openStatus(now) {
  const { day, minutes } = salonClock(now);
  const [open, close] = SALON_HOURS[day];
  if (minutes < open) return `Closed, opens ${formatHour(open)}`;
  if (minutes < close) return `Open now, closes ${formatHour(close)}`;
  return `Closed, opens ${formatHour(SALON_HOURS[(day + 1) % 7][0])} tomorrow`;
}
