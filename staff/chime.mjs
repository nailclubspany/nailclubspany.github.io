// New-request chime for the staff app: two soft rising notes, synthesised
// with Web Audio so there's no sound file to load.
//
// Browsers (Safari on iPad especially) only allow sound after someone has
// tapped the page, so app.mjs calls unlock() from the first tap and from the
// Sound button; playChime() before that is silently skipped. The on/off
// choice is saved per device, like the language.
//
// Must never import app.mjs or the supabase-js CDN.

const STORAGE_KEY = 'staff-sound';

let ctx = null;

export function soundOn() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundOn(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Not saved; still applies until the page reloads.
  }
}

// Must run inside a tap/click handler. Resolves once audio is allowed.
export async function unlock() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  ctx ??= new AC();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // Still locked; the next tap tries again.
    }
  }
}

export function unlocked() {
  return ctx?.state === 'running';
}

export function playChime() {
  if (!unlocked()) return;
  const t0 = ctx.currentTime;
  for (const [i, freq] of [880, 1318.5].entries()) { // A5, then E6
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = t0 + i * 0.18;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.95);
  }
}
