// Staff app shell: owns the Supabase client, the auth session, the tab bar,
// and the views map. View modules (requests.mjs, calendar.mjs, schedules.mjs,
// team.mjs) never import this file or the CDN, so their pure helpers stay
// importable by plain `node --test`; each one exports
// `default { mount(el, ctx), unmount() }` and is handed
// `ctx = { supabase, show, onAvailabilityChanged }` on mount.
//
// Realtime: this shell owns the ONE `availability` broadcast channel for
// the signed-in session (opened on sign-in, removed on sign-out). Views
// never create or remove channels; they call
// `ctx.onAvailabilityChanged(cb)` in mount — cb(day) runs for each
// broadcast — and call the returned unsubscribe in unmount. (Per-view
// channels broke after the first tab switch: removeChannel is async, so the
// next view's supabase.channel('availability') got back the still-leaving
// channel, its subscribe() was a no-op, and it was dropped when the leave
// finished.)
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../js/config.mjs';
import { createListenerSet, authAction, newIdsSince } from './shell-support.mjs';
import { soundOn, setSoundOn, unlock, unlocked, playChime } from './chime.mjs';
import requestsView from './requests.mjs';
import calendarView from './calendar.mjs';
import schedulesView from './schedules.mjs';
import teamView from './team.mjs';
import { say, t, fieldMessage, LANGS, getLang, setLang } from './i18n.mjs';
import { inlineErrors } from '../js/inline-errors.mjs';

const NOT_SET_UP_COPY = "Live booking isn't set up yet — see supabase/README.md.";

// One entry per view. The tab bar only ever shows the views listed.
const VIEWS = [
  { name: 'requests', label: 'Requests', module: requestsView },
  { name: 'calendar', label: 'Calendar', module: calendarView },
  { name: 'schedules', label: 'Schedules', module: schedulesView },
  { name: 'staff', label: 'Staff', module: teamView },
];

const root = document.getElementById('root');

document.documentElement.lang = LANGS.find((l) => l.code === getLang()).htmlLang;

// EN / ES / 中文 switch. Choosing a language saves it for this device and
// reloads, so every view re-renders in it (the sign-in session survives).
function langSwitch() {
  const group = document.createElement('div');
  group.className = 'lang-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language');
  for (const { code, label, htmlLang } of LANGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.lang = htmlLang;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(code === getLang()));
    btn.addEventListener('click', () => {
      if (code === getLang()) return;
      setLang(code);
      window.location.reload();
    });
    group.appendChild(btn);
  }
  return group;
}

// Bell button: new-request chime on (🔔) or off (🔕). Audio also needs one
// tap on the page after each load, which the first tap anywhere handles.
function soundButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sound';
  const refresh = () => {
    const on = soundOn();
    btn.textContent = on ? '🔔' : '🔕';
    btn.title = t(on ? 'Sound on' : 'Sound off');
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', async () => {
    const turningOn = !soundOn() || !unlocked();
    setSoundOn(turningOn);
    if (turningOn) {
      await unlock();
      playChime(); // a preview, so staff hear what to listen for
    }
    refresh();
  });
  // The first tap anywhere unlocks audio (browsers require one).
  document.addEventListener('pointerdown', async () => {
    await unlock();
    refresh();
  }, { once: true });
  refresh();
  return btn;
}

function renderNotice(text) {
  root.replaceChildren();
  const p = document.createElement('p');
  p.className = 'notice';
  say(p, text);
  root.appendChild(p);
}

async function init() {
  let createClient;
  try {
    ({ createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm'));
  } catch {
    renderNotice("Couldn't load the sign-in system — check your connection and reload.");
    return;
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let activeView = null;
  let contentEl = null;
  let tabButtons = [];

  // --- The session's single availability channel ---
  const availabilityListeners = createListenerSet();
  let availabilityChannel = null;
  // Resolves once the previous channel has finished leaving, so a quick
  // sign-out/sign-in never gets handed back the still-leaving channel.
  let channelClosing = Promise.resolve();
  let channelGen = 0;

  function onAvailabilityChanged(cb) {
    return availabilityListeners.add(cb);
  }

  // --- New-request chime ---
  // Ids of the pending requests already seen; null until the first check
  // after sign-in, so requests that were already waiting don't chime.
  let knownPending = null;
  let pendingTimer = null;
  let pendingGen = 0;

  async function checkPending() {
    const gen = pendingGen;
    const { data, error } = await supabase.from('appointments').select('id').eq('status', 'pending');
    if (error || gen !== pendingGen) return; // failed, or signed out meanwhile
    const ids = data.map((r) => r.id);
    if (knownPending && soundOn() && newIdsSince(knownPending, ids).length > 0) playChime();
    knownPending = new Set(ids);
  }

  // Booking changes arrive as a burst of per-day broadcasts; check once.
  function schedulePendingCheck() {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(checkPending, 400);
  }

  availabilityListeners.add(() => {
    if (renderedUserId) schedulePendingCheck();
  });
  // Backup for broadcasts missed while the connection was down (e.g. the
  // iPad slept): look again every minute.
  setInterval(() => {
    if (renderedUserId) checkPending();
  }, 60_000);

  async function openAvailabilityChannel() {
    const gen = ++channelGen;
    await channelClosing;
    if (gen !== channelGen || availabilityChannel) return; // closed/reopened meanwhile
    const ch = supabase.channel('availability');
    ch.on('broadcast', { event: 'changed' }, (msg) => {
      const day = msg?.payload?.day ?? msg?.day;
      if (day) availabilityListeners.emit(day);
    });
    ch.subscribe();
    availabilityChannel = ch;
  }

  function closeAvailabilityChannel() {
    channelGen += 1; // cancels an open still waiting on channelClosing
    const ch = availabilityChannel;
    availabilityChannel = null;
    if (!ch) return;
    try {
      channelClosing = Promise.resolve(supabase.removeChannel(ch)).catch(() => {});
    } catch {
      channelClosing = Promise.resolve();
    }
  }

  function teardownView() {
    if (activeView) {
      activeView.module.unmount();
      activeView = null;
    }
  }

  function show(name) {
    const entry = VIEWS.find((v) => v.name === name);
    if (!entry || !contentEl) return;
    teardownView();
    for (const btn of tabButtons) {
      btn.setAttribute('aria-current', btn.dataset.view === name ? 'page' : 'false');
    }
    activeView = entry;
    entry.module.mount(contentEl, { supabase, show, onAvailabilityChanged });
  }

  function renderShell(userEmail) {
    root.replaceChildren();

    const header = document.createElement('header');
    header.className = 'app-header';
    const brand = document.createElement('span');
    brand.className = 'app-brand';
    brand.textContent = 'The Nail Club & Spa — Staff';
    const who = document.createElement('span');
    who.className = 'app-user';
    who.textContent = userEmail || '';
    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'btn btn-signout';
    say(signOutBtn, 'Sign out');
    signOutBtn.addEventListener('click', () => supabase.auth.signOut());
    header.append(brand, who, soundButton(), langSwitch(), signOutBtn);

    const nav = document.createElement('nav');
    nav.className = 'app-tabs';
    tabButtons = VIEWS.map((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      say(btn, v.label);
      btn.dataset.view = v.name;
      btn.addEventListener('click', () => show(v.name));
      nav.appendChild(btn);
      return btn;
    });

    contentEl = document.createElement('main');
    contentEl.className = 'app-content';

    root.append(header, nav, contentEl);
    show(VIEWS[0].name);
  }

  function renderSignIn() {
    root.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'signin-wrap';
    const h1 = document.createElement('h1');
    say(h1, 'Staff sign in');

    const form = document.createElement('form');
    form.className = 'signin-form';
    inlineErrors(form, fieldMessage);

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.required = true;
    emailInput.autocomplete = 'username';
    const emailLabel = document.createElement('label');
    const emailSpan = document.createElement('span');
    say(emailSpan, 'Email');
    emailLabel.append(emailSpan, emailInput);

    const passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.name = 'password';
    passInput.required = true;
    passInput.autocomplete = 'current-password';
    const passLabel = document.createElement('label');
    const passSpan = document.createElement('span');
    say(passSpan, 'Password');
    passLabel.append(passSpan, passInput);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    say(submitBtn, 'Sign in');

    const error = document.createElement('p');
    error.className = 'signin-error';
    error.setAttribute('role', 'alert');

    form.append(emailLabel, passLabel, submitBtn, error);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      error.textContent = '';
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: emailInput.value.trim(),
        password: passInput.value,
      });
      submitBtn.disabled = false;
      if (signInError) say(error, 'Sign-in failed — check the email and password.');
      // A successful sign-in is picked up by onAuthStateChange below.
    });

    wrap.append(langSwitch(), h1, form);
    root.appendChild(wrap);
  }

  // The user id the screen was last rendered for: undefined before the
  // first auth callback, null while signed out.
  let renderedUserId;

  function handleAuth(session) {
    const action = authAction(renderedUserId, session);
    if (action === 'none') return; // e.g. TOKEN_REFRESHED, same-user SIGNED_IN on tab focus
    renderedUserId = session?.user?.id ?? null;
    pendingGen += 1;
    knownPending = null;
    teardownView();
    contentEl = null;
    if (action === 'shell') {
      closeAvailabilityChannel(); // no-op unless a different user took over
      openAvailabilityChannel();
      renderShell(session.user?.email ?? '');
      checkPending();
    } else {
      closeAvailabilityChannel();
      renderSignIn();
    }
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    // Supabase advises against doing work (especially other supabase calls)
    // inside this callback — it runs while auth-js holds its lock — so hand
    // it off to a fresh task.
    setTimeout(() => handleAuth(session), 0);
  });
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  renderNotice(NOT_SET_UP_COPY);
} else {
  init();
}
