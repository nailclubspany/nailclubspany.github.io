// New-request chime for the staff app: a bright bell arpeggio, synthesised
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
  // iPadOS 17+: play like a media app, so the silent switch / silent mode
  // doesn't mute the chime.
  try {
    if (globalThis.navigator?.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // Older Safari; the silent switch still applies.
  }
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

// A rising bell arpeggio (C6 E6 G6 C7), played twice so it carries across a
// busy salon. Each note stacks a few overtones for a struck-bell timbre; the
// upper ones sit at 2–6 kHz, where small tablet speakers and ears are loudest.
const NOTES = [1046.5, 1318.5, 1568, 2093]; // C6, E6, G6, C7
const PARTIALS = [[1, 1], [2, 0.6], [3, 0.35], [4.2, 0.15]]; // [ratio, level]
const NOTE_GAP = 0.13;
const REPEAT_GAP = 1.1;
const DRIVE = 6; // how hard the soft clipper squeezes; higher = louder, grittier

// Soft-clipping curve (tanh): squeezes the signal up toward full scale so the
// chime plays at the speaker's maximum without harsh digital distortion.
let curve = null;
function softClip() {
  if (!curve) {
    curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(DRIVE * x) / Math.tanh(DRIVE);
    }
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

export function playChime() {
  if (!unlocked()) return;
  const out = ctx.createGain();
  out.gain.value = 0.3; // keeps overlapping notes inside the curve's -1..1 range
  out.connect(softClip()).connect(ctx.destination);

  const t0 = ctx.currentTime + 0.02;
  for (let rep = 0; rep < 2; rep++) {
    for (const [i, freq] of NOTES.entries()) {
      const t = t0 + rep * REPEAT_GAP + i * NOTE_GAP;
      const last = i === NOTES.length - 1;
      bell(out, freq, t, last ? 1.6 : 0.9, last ? 0.9 : 0.7);
    }
  }
}

function bell(out, freq, t, decay, peak) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  gain.connect(out);
  for (const [ratio, level] of PARTIALS) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = ratio === 1 ? 'triangle' : 'sine';
    osc.frequency.value = freq * ratio;
    g.gain.value = level;
    osc.connect(g).connect(gain);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}
