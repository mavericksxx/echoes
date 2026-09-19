// Phase 13a ("Show it off"): small synthesized WebAudio cues — no asset
// files, everything generated at runtime. Muted by default; a speaker
// toggle (wired by initSoundToggle) persists the choice to localStorage. The
// shared AudioContext itself is created lazily, on the first real user
// gesture after sound is (or already was, from a previous session) enabled
// — most browsers refuse to start one any earlier, and creating it eagerly
// on page load would just leave it sitting suspended anyway.

import type { WeatherId } from "../shared/world";

const STORAGE_KEY = "echoes:sound-enabled";

function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // localStorage unavailable (private mode, blocked) — stay muted
  }
}

function writeStoredEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Nothing to do — the toggle still works for this session, it just
    // won't be remembered next time.
  }
}

let enabled = readStoredEnabled();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Lazily creates (once) and resumes the shared AudioContext, only while
 * sound is actually enabled. Safe to call from any gesture handler — a
 * no-op (returns null) when sound is off or the API doesn't exist at all. */
function ensureContext(): AudioContext | null {
  if (!enabled) return null;
  if (typeof AudioContext === "undefined") return null; // unsupported browser — degrade to silent
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

let unlockArmed = false;

/** Arms a one-time listener that creates/resumes the AudioContext on the
 * first pointerdown/keydown anywhere in the app — so a returning visitor
 * who already had sound on doesn't need to find and re-press the speaker
 * toggle before anything plays. Harmless (ensureContext() just no-ops) when
 * sound starts off. */
function armGestureUnlock(): void {
  if (unlockArmed) return;
  unlockArmed = true;
  const unlock = (): void => {
    ensureContext();
  };
  window.addEventListener("pointerdown", unlock, { once: true, passive: true });
  window.addEventListener("keydown", unlock, { once: true });
  // iOS Safari doesn't reliably fire pointerdown as a "real" user gesture for
  // AudioContext purposes on every element — click always does.
  window.addEventListener("click", unlock, { once: true });
}
armGestureUnlock();

// ---------------------------------------------------------------------------
// Speaker toggle
// ---------------------------------------------------------------------------

/** Wires a speaker/mute button: reflects the persisted state on load, and
 * toggles + persists it on click. The click itself is a user gesture, so
 * turning sound on also starts the AudioContext right there. */
export function initSoundToggle(button: HTMLButtonElement): void {
  const sync = (): void => {
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", enabled ? "Turn sound off" : "Turn sound on");
  };
  sync();
  button.addEventListener("click", () => {
    enabled = !enabled;
    writeStoredEnabled(enabled);
    sync();
    if (enabled) ensureContext();
    else stopAmbience(); // don't wait for the next frame's updateWeatherAmbience call to go quiet
  });
}

// ---------------------------------------------------------------------------
// One-shot cues — short synthesized blips, envelope-only, no samples.
// ---------------------------------------------------------------------------

function playTone(freq: number, durationSec: number, gain: number, type: OscillatorType): void {
  const audio = ensureContext();
  if (!audio || !master) return;
  const osc = audio.createOscillator();
  const env = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const now = audio.currentTime;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
  osc.connect(env);
  env.connect(master);
  osc.start(now);
  osc.stop(now + durationSec + 0.02);
}

/** Soft UI click — sidebar/tab actions (src/sidebar.ts). */
export function playClick(): void {
  playTone(1200, 0.05, 0.05, "triangle");
}

const FOOTSTEP_MIN_GAP_MS = 260;
let lastFootstepAt = 0;

/** Footstep tick for the village camera's arrow-key pan (src/main.ts's
 * applyKeyPan — the closest thing this village sim has to "the player
 * walking"). Throttled internally: safe to call every frame a pan key is
 * held, but it only actually sounds every FOOTSTEP_MIN_GAP_MS. */
export function playFootstep(): void {
  const now = performance.now();
  if (now - lastFootstepAt < FOOTSTEP_MIN_GAP_MS) return;
  lastFootstepAt = now;
  playTone(140, 0.07, 0.045, "square");
}

// ---------------------------------------------------------------------------
// Weather ambience — a looping filtered-noise bed for rain/storm, silence
// otherwise. One shared noise buffer (generated once), gain ramped in/out on
// start/stop rather than hard-cut, so toggling weather never clicks.
// ---------------------------------------------------------------------------

let noiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(audio: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    const seconds = 2;
    noiseBuffer = audio.createBuffer(1, audio.sampleRate * seconds, audio.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

interface Ambience {
  source: AudioBufferSourceNode;
  gain: GainNode;
}
let ambience: Ambience | null = null;
let ambienceKind: WeatherId | "none" = "none";

function stopAmbience(): void {
  if (!ambience) return;
  const { source, gain } = ambience;
  ambience = null;
  if (ctx) {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.3);
  }
  window.setTimeout(() => source.stop(), 350);
}

function startRainAmbience(kind: "rain" | "storm"): void {
  const audio = ensureContext();
  if (!audio || !master) return;
  const source = audio.createBufferSource();
  source.buffer = getNoiseBuffer(audio);
  source.loop = true;
  // Band-limited toward "hiss", not full white noise — storm reads a touch
  // brighter/louder than a plain rain shower.
  const highpass = audio.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 240;
  const lowpass = audio.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = kind === "storm" ? 1600 : 1100;
  const gain = audio.createGain();
  const targetGain = kind === "storm" ? 0.05 : 0.035;
  gain.gain.value = 0;
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(master);
  source.start();
  gain.gain.linearRampToValueAtTime(targetGain, audio.currentTime + 0.6);
  ambience = { source, gain };
}

/** Called once per frame (src/main.ts) with the world's current weather —
 * a no-op unless the ambient category actually changed, so it's cheap to
 * call every frame. Only "rain" and "storm" get an ambience bed (filtered
 * noise); every other weather, including "clear"/undefined, plays nothing
 * (SPEC.md Phase 13: "filtered noise for rain; nothing for clear"). */
export function updateWeatherAmbience(weather: WeatherId | undefined): void {
  if (!enabled) {
    if (ambience) stopAmbience();
    ambienceKind = "none";
    return;
  }
  const kind: WeatherId | "none" = weather === "rain" || weather === "storm" ? weather : "none";
  if (kind === ambienceKind) return;
  stopAmbience();
  ambienceKind = kind;
  if (kind !== "none") startRainAmbience(kind);
}
