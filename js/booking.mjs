// Wires up the public booking form (index.html #booking-form).
//
// Legacy mode (default): exactly today's behaviour — salon-hours time list
// computed client-side, submitted by Web3Forms (or mailto if no key). Wired
// synchronously at module load, before any await, so the form is *never*
// left unwired — a submit before a live-mode upgrade resolves (or times
// out) would otherwise fall through to a native GET, putting the
// customer's name/phone/email in the URL.
//
// Live mode: when js/config.mjs supplies SUPABASE_URL/SUPABASE_ANON_KEY,
// asynchronously attempts to upgrade to booking against real availability
// via Supabase RPCs. The attempt (CDN import + first public_day call) is
// timeout-guarded — a hang counts the same as an error — and any failure
// (import, timeout, first public_day call, or a later RPC error) falls back
// to (or stays in) legacy mode.
//
// Uses globals defined by the classic <script id="booking-logic"> in
// index.html (function declarations there become properties of the global
// object, so they're visible here as bare identifiers): buildBookingMailto,
// buildBookingSubmission, timeSlots, weekdayOf, isPastDate, localISODate.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.mjs';
import { HORIZON_DAYS, salonToday, earliestStart, unknownServices, openSlots, formatMinutes, addDaysToIso } from './schedule.mjs';
import { withTimeout, canOverwriteStatus, createGenerationalCache, resumeRefreshDue, isTestHost, phoneLooksValid } from './booking-support.mjs';
import { renderNailPicker, serviceSummary } from './nail-picker.mjs';
import { SPA_SERVICES, bookingNotes } from './services.mjs';

const SALON_EMAIL = 'nailclubspany@gmail.com'; // keep in sync with Contact section
// Web3Forms access key for SALON_EMAIL (get one free at web3forms.com). Until it's set, the form falls back to mailto.
const WEB3FORMS_KEY = '257c0065-a5ef-40a0-a5ba-0b4922f98284';
// How long the live-mode upgrade attempt (CDN import + first public_day call) may
// take before it's treated the same as an error and we stay in legacy mode.
const CONNECT_TIMEOUT_MS = 5000;
// While a date is chosen in live mode, re-check its open times this often,
// and whenever the customer comes back to the tab (focus / visible) if the
// last check is at least RESUME_MIN_GAP_MS old — so a slot that has aged
// inside the 60-minute lead time drops off the list before they submit.
const PERIODIC_REFRESH_MS = 5 * 60 * 1000;
const RESUME_MIN_GAP_MS = 60 * 1000;
// Served from this computer or the local network: don't spend Web3Forms
// quota on test requests — log what would have been emailed instead. Live
// mode still writes real holds to the database; decline them in Requests.
const TEST_MODE = isTestHost(location.hostname);

const form = document.getElementById('booking-form');
const status = document.getElementById('booking-status');
const dateInput = form.elements.date;
const timeSelect = form.elements.time;
const technicianSelect = form.elements.technician;
// A corrected phone number clears the too-short message (set on submit).
form.elements.phone.addEventListener('input', () => form.elements.phone.setCustomValidity(''));
// Render the detailed service boxes first, so serviceBoxes below includes them.
renderNailPicker(document.getElementById('nail-services'));
renderNailPicker(document.getElementById('spa-services'), SPA_SERVICES);
const serviceBoxes = [...form.querySelectorAll('input[name="service"]')];
const pickedServices = () => serviceBoxes.filter((b) => b.checked).map((b) => b.value);
// Snapshot of the static Mia/Yoyo/Carmela/Lili/Linda <option>s, before live mode ever
// replaces them with staff ids — restored if a later fallback to legacy mode happens.
const staticTechnicianOptions = [...technicianSelect.options].map((o) => o.cloneNode(true));

const CHECKING_COPY = 'Checking availability…';
const NO_OPENINGS_COPY = 'No openings that day — try another date or call (718) 392-8899.';
const SUCCESS_COPY = "Request received — this time is held for you. We'll call or text to confirm.";
const TAKEN_COPY = 'That time was just taken — here are the open times.';
const TOO_MANY_COPY = 'You already have 3 requests waiting — please call (718) 392-8899.';
const PHONE_COPY = 'Please enter a 10-digit phone number, including area code.';
const ERROR_COPY = "Sorry, we couldn't send your request. Please call (718) 392-8899.";

// Messages a background availability refresh (triggered by a realtime broadcast, or
// the one that follows a submission) is allowed to write over — never a
// submit-outcome message like SUCCESS_COPY/TAKEN_COPY/TOO_MANY_COPY/ERROR_COPY, or
// the transient "Sending your request…", which only a direct user action may set.
const REFRESH_OWN_MESSAGES = [CHECKING_COPY, NO_OPENINGS_COPY];
function setRefreshStatus(text) {
  if (canOverwriteStatus(status.textContent, REFRESH_OWN_MESSAGES)) status.textContent = text;
}

let supabase = null;
let channel = null;
// The customer's last real (non-placeholder) time pick. Read instead of
// timeSelect.value when deciding what to preserve/report across a refresh,
// since the select shows a transient "Checking…"/"No openings…" placeholder
// while a refresh is in flight.
let lastPick = '';
timeSelect.addEventListener('change', () => { lastPick = timeSelect.value; });
// True for the duration of a live submit (RPC round-trip), as extra
// insurance (alongside clearing lastPick — see the submit handler) against
// showing TAKEN_COPY for the customer's own successful booking, should its
// own realtime broadcast race the submit handler's refresh.
let submitting = false;
// Bumped on every refresh() call; a call whose sequence number is no longer
// current when its network fetch resolves was superseded by a later one
// (new date/service/provider change, or another broadcast) and drops its
// result instead of overwriting what the newer call already showed.
let refreshSeq = 0;
// Date.now() of the last refresh() that actually applied a result.
let lastRefreshAt = 0;
let periodicTimer = null;
// Per-day public_day results. Uses invalidate() (not a bare Map.delete) so a
// fetch already in flight when a day is invalidated (by our own booking or a
// realtime broadcast) can never resolve into stale cached data afterwards —
// see js/booking-support.mjs's createGenerationalCache for why a plain
// Map + "in-flight promise" cache got this wrong.
const dayAvailability = createGenerationalCache(async (day) => {
  const { data, error } = await supabase.rpc('public_day', { p_day: day });
  if (error) throw error;
  return data;
});

// --- Legacy mode: today's exact behaviour, moved verbatim from the old inline <script>. ---
function enterLegacyMode() {
  if (channel) { try { supabase.removeChannel(channel); } catch { /* ignore */ } channel = null; }
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  supabase = null;
  dayAvailability.clear();
  technicianSelect.replaceChildren(...staticTechnicianOptions.map((o) => o.cloneNode(true)));

  dateInput.min = localISODate(new Date());
  dateInput.removeAttribute('max');

  function fillTimes() {
    const picked = timeSelect.value;
    const slots = timeSlots(dateInput.value ? weekdayOf(dateInput.value) : 1);
    timeSelect.replaceChildren(new Option('Choose a time…', ''), ...slots.map((t) => new Option(t)));
    if (slots.includes(picked)) timeSelect.value = picked;
  }
  timeSelect.disabled = false;
  fillTimes();

  dateInput.oninput = () => { dateInput.setCustomValidity(''); fillTimes(); };
  serviceBoxes.forEach((b) => { b.onchange = () => serviceBoxes[0].setCustomValidity(''); });
  technicianSelect.onchange = null;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    f.name.value = f.name.value.trim();
    f.phone.value = f.phone.value.trim();
    f.email.value = f.email.value.trim();
    if (dateInput.value && isPastDate(dateInput.value, new Date())) {
      dateInput.setCustomValidity('Please choose today or a future date.');
    }
    f.phone.setCustomValidity(!f.phone.value || phoneLooksValid(f.phone.value) ? '' : PHONE_COPY);
    serviceBoxes[0].setCustomValidity(pickedServices().length ? '' : 'Please choose at least one service.');
    if (!form.reportValidity()) return;

    const data = {
      name: f.name.value,
      phone: f.phone.value,
      email: f.email.value,
      service: serviceSummary(form).detailLines.join('; '),
      technician: f.technician.value,
      date: f.date.value,
      time: f.time.value,
      notes: f.notes.value.trim(),
    };

    if (!WEB3FORMS_KEY) {
      location.href = buildBookingMailto(data, SALON_EMAIL);
      status.textContent = 'Your email app should open with your request. Nothing happened? Call (718) 392-8899.';
      return;
    }

    if (f.botcheck.checked) return; // honeypot: only bots tick the hidden box

    if (TEST_MODE) {
      console.log('Test mode — not emailed:', buildBookingSubmission(data, WEB3FORMS_KEY));
      form.reset();
      fillTimes();
      status.textContent = `Test mode — not emailed: ${data.service} · ${data.date} ${data.time}`;
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Sending your request…';
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildBookingSubmission(data, WEB3FORMS_KEY)),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.message);
      form.reset();
      fillTimes();
      status.textContent = "Thanks! Your request was sent. We'll contact you to confirm.";
    } catch {
      status.textContent = ERROR_COPY;
    } finally {
      button.disabled = false;
    }
  };
}

// --- Live mode: book against real availability from Supabase. ---

// Every active provider, whatever services are picked: skills don't limit
// who a customer may choose (staff sort out a mismatch when confirming).
function populateProviders(dayData) {
  const picked = technicianSelect.value;
  technicianSelect.replaceChildren(
    new Option('No preference', ''),
    ...dayData.staff.map((s) => new Option(s.name, String(s.id)))
  );
  if (dayData.staff.some((s) => String(s.id) === picked)) technicianSelect.value = picked;
}

function setCheckingTime() {
  timeSelect.disabled = false;
  const opt = new Option(CHECKING_COPY, '');
  opt.disabled = true;
  timeSelect.replaceChildren(opt);
}

// Refreshes the provider/time lists for the currently chosen date. Returns
// true if it actually applied a result, false if it fell back to legacy
// mode or was superseded by a later call before its fetch resolved.
async function refresh() {
  const mySeq = ++refreshSeq;
  const day = dateInput.value || salonToday(new Date());
  const prevPicked = lastPick;

  setCheckingTime();
  setRefreshStatus(CHECKING_COPY);

  let dayData;
  try {
    dayData = await dayAvailability.get(day);
  } catch {
    enterLegacyMode();
    return false;
  }

  // A newer refresh (a fresh date/service/provider change, another
  // broadcast, or the refresh that follows a submission) started while we
  // were waiting on the network — drop this now-stale result.
  if (mySeq !== refreshSeq) return false;
  if ((dateInput.value || salonToday(new Date())) !== day) return false;
  // The form offers a service the database doesn't know (its migration
  // hasn't been run): request_appointment would reject it, so fall back to
  // emailing the request instead.
  if (unknownServices(dayData, pickedServices()).length) {
    setRefreshStatus('');
    enterLegacyMode();
    return false;
  }
  lastRefreshAt = Date.now();

  populateProviders(dayData);
  setRefreshStatus('');

  const earliest = earliestStart(day, new Date());
  const staffId = technicianSelect.value ? Number(technicianSelect.value) : null;
  const slots = earliest == null ? [] : openSlots(dayData, staffId, earliest);

  timeSelect.disabled = false;
  if (slots.length === 0) {
    timeSelect.replaceChildren(new Option(NO_OPENINGS_COPY, ''));
    setRefreshStatus(NO_OPENINGS_COPY);
    lastPick = '';
    return true;
  }

  timeSelect.replaceChildren(new Option('Choose a time…', ''), ...slots.map((m) => new Option(formatMinutes(m), String(m))));
  if (slots.map(String).includes(prevPicked)) {
    timeSelect.value = prevPicked;
    lastPick = prevPicked;
  } else {
    lastPick = '';
  }
  return true;
}

// Refetches the chosen day's availability in the background (a realtime
// broadcast, the tab regaining focus, or the periodic timer) and, if the
// customer's pick disappeared, tells them.
function refreshChosenDay() {
  if (!supabase || submitting) return;
  const day = dateInput.value || salonToday(new Date());
  const hadPick = lastPick;
  dayAvailability.invalidate(day);
  refresh().then((applied) => {
    // A broadcast for this day almost always includes the customer's own
    // just-submitted booking (the insert that triggered it). lastPick is
    // cleared synchronously as soon as that submission succeeds (see the
    // submit handler), so `hadPick` is already '' for that case and this
    // never fires; `!submitting` is a second, cheap guard for the same
    // race. Either way, a customer must never see "just taken" for their
    // own successful request.
    if (applied && hadPick && lastPick !== hadPick && !submitting) status.textContent = TAKEN_COPY;
  });
}

function subscribeAvailability() {
  channel = supabase.channel('availability');
  channel.on('broadcast', { event: 'changed' }, (msg) => {
    const day = msg?.payload?.day ?? msg?.day;
    if (!day) return;
    const chosen = dateInput.value || salonToday(new Date());
    if (day !== chosen) return;
    refreshChosenDay();
  });
  channel.subscribe();
}

// Same-day slots age out of the 60-minute lead time while the page sits
// open, so re-check when the customer comes back to the tab and every few
// minutes while a date is chosen.
function onResume() {
  if (document.visibilityState === 'hidden' || !dateInput.value) return;
  if (!resumeRefreshDue(lastRefreshAt, Date.now(), RESUME_MIN_GAP_MS)) return;
  refreshChosenDay();
}
function watchForStaleSlots() {
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('focus', onResume);
  periodicTimer = setInterval(() => {
    if (document.visibilityState === 'hidden' || !dateInput.value) return;
    refreshChosenDay();
  }, PERIODIC_REFRESH_MS);
}

function enterLiveMode() {
  const todayIso = salonToday(new Date());
  dateInput.min = todayIso;
  dateInput.max = addDaysToIso(todayIso, HORIZON_DAYS);

  // A deliberate user change is a fresh attempt — clear any stale
  // submit-outcome message directly (bypassing the refresh-only guard).
  dateInput.oninput = () => { dateInput.setCustomValidity(''); status.textContent = ''; refresh(); };
  serviceBoxes.forEach((b) => { b.onchange = () => { serviceBoxes[0].setCustomValidity(''); status.textContent = ''; refresh(); }; });
  technicianSelect.onchange = () => { status.textContent = ''; refresh(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    f.name.value = f.name.value.trim();
    f.phone.value = f.phone.value.trim();
    f.email.value = f.email.value.trim();
    if (dateInput.value && isPastDate(dateInput.value, new Date())) {
      dateInput.setCustomValidity('Please choose today or a future date.');
    }
    f.phone.setCustomValidity(!f.phone.value || phoneLooksValid(f.phone.value) ? '' : PHONE_COPY);
    serviceBoxes[0].setCustomValidity(pickedServices().length ? '' : 'Please choose at least one service.');
    if (!form.reportValidity()) return;
    if (f.botcheck.checked) return; // honeypot: only bots tick the hidden box

    const day = f.date.value || salonToday(new Date());
    const startMin = f.time.value === '' ? null : Number(f.time.value);
    if (startMin == null) return;

    // Read the picks now: the customer can still change the form while the
    // RPC is in flight, and the email must describe what was booked.
    const summary = serviceSummary(form);
    const notes = f.notes.value.trim();

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Sending your request…';
    submitting = true;
    try {
      const { data, error } = await supabase.rpc('request_appointment', {
        p_name: f.name.value,
        p_phone: f.phone.value,
        p_email: f.email.value,
        p_services: summary.names,
        p_staff_id: f.technician.value ? Number(f.technician.value) : null,
        p_day: day,
        p_start_min: startMin,
        // Nail choices/add-ons ride in front of the customer's notes so staff see them.
        p_notes: bookingNotes(summary.pickDetailLines, notes),
      });
      if (error) throw error;

      if (data?.ok) {
        // Clear synchronously, with no await in between, so the realtime
        // broadcast our own insert triggers (racing this same refresh) can
        // never see a "held pick" for this booking and show TAKEN_COPY for
        // it — see subscribeAvailability(). JS run-to-completion guarantees
        // this runs before that broadcast's handler can.
        lastPick = '';
        const heldData = {
          name: f.name.value,
          phone: f.phone.value,
          email: f.email.value,
          service: summary.detailLines.join('; '),
          technician: data.staff_name,
          date: day,
          time: formatMinutes(startMin),
          notes,
        };
        form.reset();
        if (TEST_MODE) {
          console.log('Test mode — not emailed:', buildBookingSubmission(heldData, WEB3FORMS_KEY, true));
        } else {
          fetch('https://api.web3forms.com/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(buildBookingSubmission(heldData, WEB3FORMS_KEY, true)),
          }).catch(() => { /* fire-and-forget: staff copy only, RPC already holds the slot */ });
        }
        dayAvailability.invalidate(day);
        await refresh();
        // Set after refresh so it isn't cleared by refresh's own '' write.
        status.textContent = TEST_MODE ? `${SUCCESS_COPY} (Test mode — not emailed.)` : SUCCESS_COPY;
      } else if (data?.reason === 'slot_taken') {
        // Also covers a slot that aged inside the lead time (or past the
        // horizon) while the form was open: refetch and show what's open.
        dayAvailability.invalidate(day);
        await refresh();
        status.textContent = TAKEN_COPY;
      } else if (data?.reason === 'too_many') {
        status.textContent = TOO_MANY_COPY;
      } else {
        status.textContent = ERROR_COPY; // 'invalid' or unrecognized
      }
    } catch {
      status.textContent = ERROR_COPY;
    } finally {
      submitting = false;
      button.disabled = false;
    }
  };

  subscribeAvailability();
  watchForStaleSlots();
  status.textContent = '';
  refresh();
}

async function tryEnterLiveMode() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    const { createClient } = await withTimeout(
      import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm'),
      CONNECT_TIMEOUT_MS,
      'supabase-js load timed out'
    );
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const today = salonToday(new Date());
    const { data, error } = await withTimeout(
      client.rpc('public_day', { p_day: today }),
      CONNECT_TIMEOUT_MS,
      'public_day timed out'
    );
    if (error) throw error;
    supabase = client;
    dayAvailability.set(today, data);
    enterLiveMode();
  } catch {
    // A hang counts the same as an error here (withTimeout turns it into
    // one) — either way, stay on the legacy wiring already in place.
    enterLegacyMode();
  }
}

// Wire the safe, synchronous baseline first — before any await — so the
// form is never left unwired while a live-mode upgrade is (maybe slowly,
// maybe never) resolving.
enterLegacyMode();
tryEnterLiveMode();
