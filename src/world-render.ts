// Phase 11: draws the daily village agent's world effects — time-of-day
// tint, night light glows, festival decor, weather particles — on top of
// the pixel-art canvas. Plain canvas primitives only, same "no new ripped
// assets" convention as src/render.ts's drawNoticeBoard. Called from
// src/main.ts's renderVillage/renderDistrict, inside the world-space
// save()/translate(-camX,-camY)/restore() block, so the separate
// screen-space caption overlay (src/render.ts's drawCaptions) is never
// affected by any of it.

import type { Point } from "../data/types";
import type { ActivityLevel } from "../shared/activity";
import { sanitizeLabel, type TimeOfDayId, type WeatherId } from "../shared/world";
import { drawLighting, lerpTowards, type LightPool } from "./lighting";
import { getLiveNowPlaying } from "./now-playing-card";
import { getTimeOfDay, getWeather } from "./world-state";

/** One frame's shared timing/preference inputs — built once in src/main.ts's
 * frame() and threaded down to whatever draw calls need it, instead of each
 * one re-deriving its own (see this file's drawWorldEffects and main.ts's
 * frame() for the callers). `dt`/`ts` are the rAF frame's own delta/
 * timestamp (used for particle animation, independent of any Chronicle
 * replay); `clockMs` is world-state.ts's getSceneClockMs() — the replay's
 * fixed nowMs while one is active, else Date.now(). `hour` is world-state.
 * ts's getSceneHour() (fractional owner-local hour), read once here for
 * src/lighting.ts's darkness curve. `breathe` is the app's single "the map
 * breathes with the music" oscillator (Feature 2) — computed once per frame
 * in main.ts's frame() from the now-playing district's mood energy (there's
 * no per-track tempo/energy available; Spotify's audio-features API is
 * gone), 0.5 constant under reduced motion. No other module may create its
 * own oscillator — see drawWorldEffects below, the only reader. */
export interface WorldEnv {
  dt: number;
  ts: number;
  reduced: boolean;
  clockMs: number;
  hour: number;
  breathe: number;
}

// ---------------------------------------------------------------------------
// Time-of-day tint
// ---------------------------------------------------------------------------
// Low-alpha washes, same spirit as src/residents.ts's MOOD_TINTS — this
// reads as ambient lighting over the whole scene, not a color filter over
// the Naruto DS pixel art. "day"/"night" have no entry: real daylight needs
// no tint, and night is now the lighting layer's job (src/lighting.ts's
// drawLighting, folded in below) rather than a flat wash stacked on top of
// it — dawn/dusk keep their color tints, since those are hue, not darkness.
const TIME_TINTS: Partial<Record<TimeOfDayId, string | [string, string]>> = {
  dawn: "rgba(255, 178, 112, 0.14)",
  dusk: ["rgba(255, 142, 84, 0.16)", "rgba(112, 64, 158, 0.2)"],
};

export function drawTimeOfDayTint(ctx: CanvasRenderingContext2D, timeOfDay: TimeOfDayId, w: number, h: number): void {
  const tint = TIME_TINTS[timeOfDay];
  if (!tint) return;
  ctx.save();
  if (Array.isArray(tint)) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, tint[0]);
    grad.addColorStop(1, tint[1]);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = tint;
  }
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Lighting — light pools per district, replacing the old per-point night-
// glow gradients (deleted above) and src/residents.ts's ACTIVITY_TREATMENT
// dormant/quiet full-bg darkening (deleted at that call site) with
// src/lighting.ts's single darkness-layer-plus-punched-pools pass. One
// intensity per slot, persisted across frames and lerped toward its target
// (see stepPoolIntensity) so activity-level changes fade rather than pop.
// ---------------------------------------------------------------------------

/** One candidate light pool: the world-space point a district's pool is
 * centered on (VILLAGE.anchors in village view, district.home in district
 * view — see main.ts's renderVillage/renderDistrict), plus the slotId and
 * activity level (src/listening-source.ts's getActivity, itself replay-aware
 * via world-state.ts's getEffectiveWorld) that decide its target
 * intensity. */
export interface LightCandidate {
  slotId: string;
  point: Point;
  activity: ActivityLevel;
}

const ACTIVITY_POOL_INTENSITY: Record<ActivityLevel, number> = { dormant: 0, quiet: 0.35, active: 0.7, festival: 1.0 };
const NOW_PLAYING_INTENSITY = 1.0;

const VILLAGE_POOL_RADIUS = 76;
const DISTRICT_POOL_RADIUS = 210;
// Feature 2: the now-playing district's pool "breathes" ±10% off its base
// radius — the only place `breathe` touches lighting (the other is weather
// particle speed, see drawWeather below).
const BREATHE_RADIUS_SPAN = 0.1;

// Per-slot lerped intensity, persisted across frames — see lerpTowards's doc
// comment for why this isn't just a straight snap to target.
const poolIntensity = new Map<string, number>();

function stepPoolIntensity(slotId: string, target: number, dt: number, reduced: boolean): number {
  const current = poolIntensity.get(slotId) ?? target;
  const next = reduced ? target : lerpTowards(current, target, dt);
  poolIntensity.set(slotId, next);
  return next;
}

function buildLightPools(candidates: LightCandidate[], baseRadius: number, env: WorldEnv, nowPlayingSlotId: string | null): LightPool[] {
  return candidates.map((c) => {
    const boosted = c.slotId === nowPlayingSlotId;
    const target = boosted ? NOW_PLAYING_INTENSITY : ACTIVITY_POOL_INTENSITY[c.activity];
    const intensity = stepPoolIntensity(c.slotId, target, env.dt, env.reduced);
    const breathe = env.reduced ? 0.5 : env.breathe;
    const radius = boosted ? baseRadius * (1 + (breathe - 0.5) * 2 * BREATHE_RADIUS_SPAN) : baseRadius;
    return { point: c.point, intensity, radius };
  });
}

// ---------------------------------------------------------------------------
// Festival decor — paired paper lanterns on a crossbeam plus a small name
// plate, drawn above a district's village anchor (see src/main.ts's
// renderVillage). Mission-scroll palette, matching src/render.ts's
// drawNoticeBoard rather than the pixel sprites.
// ---------------------------------------------------------------------------
const FESTIVAL_NAME_MAX = 40; // sanitizeLabel's cap for this draw context

function ellipsizeToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let label = text;
  while (label.length > 1 && ctx.measureText(`${label}…`).width > maxW) label = label.slice(0, -1);
  return `${label}…`;
}

export function drawFestivalDecor(ctx: CanvasRenderingContext2D, x: number, y: number, rawName: string): void {
  const name = sanitizeLabel(rawName, FESTIVAL_NAME_MAX);
  ctx.save();
  ctx.translate(x, y);

  ctx.strokeStyle = "#3e2814"; // --wood-dark
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-16, -44);
  ctx.lineTo(16, -44);
  ctx.stroke();
  [-11, 11].forEach((lx) => {
    ctx.strokeStyle = "#3e2814";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, -44);
    ctx.lineTo(lx, -38);
    ctx.stroke();
    ctx.fillStyle = "#b8321f"; // --seal
    ctx.beginPath();
    ctx.ellipse(lx, -32, 5, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#f2c14e";
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  if (name) {
    ctx.font = "600 9px Archivo, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = ellipsizeToWidth(ctx, name, 72);
    const textW = ctx.measureText(label).width;
    const boxW = textW + 12;
    const boxY = -56;
    ctx.fillStyle = "rgba(220, 214, 189, 0.94)"; // --paper
    ctx.strokeStyle = "rgba(29, 39, 72, 0.4)";
    ctx.lineWidth = 1;
    ctx.fillRect(-boxW / 2, boxY - 7, boxW, 14);
    ctx.strokeRect(-boxW / 2, boxY - 7, boxW, 14);
    ctx.fillStyle = "#1d2748"; // --ink
    ctx.fillText(label, 0, boxY + 1);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Weather particles — cheap, capped, drawn in screen space (undoing the
// caller's world-space translate, see drawWeather) so density stays
// constant regardless of camera pan/zoom. Reused across both village and
// district views since both call drawWeather from within their own
// world-space save()/restore() block.
// ---------------------------------------------------------------------------
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
}

type ParticleKind = "rain" | "storm" | "snow" | "blossom";

const PARTICLE_CAPS: Record<ParticleKind, number> = {
  rain: 60,
  storm: 70,
  snow: 45,
  blossom: 32,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function seedParticles(kind: ParticleKind, w: number, h: number): Particle[] {
  const n = PARTICLE_CAPS[kind];
  const list: Particle[] = [];
  for (let i = 0; i < n; i++) {
    if (kind === "rain" || kind === "storm") {
      const heavy = kind === "storm";
      list.push({
        x: rand(0, w),
        y: rand(0, h),
        vx: heavy ? -70 : -40,
        vy: heavy ? 420 : 300,
        size: rand(8, 15),
        phase: 0,
      });
    } else if (kind === "snow") {
      list.push({ x: rand(0, w), y: rand(0, h), vx: 0, vy: rand(16, 32), size: rand(1.2, 2.6), phase: rand(0, Math.PI * 2) });
    } else {
      list.push({ x: rand(0, w), y: rand(0, h), vx: rand(6, 16), vy: rand(18, 30), size: rand(2, 3.4), phase: rand(0, Math.PI * 2) });
    }
  }
  return list;
}

let particles: Particle[] = [];
let particleKind: ParticleKind | null = null;
let particleW = 0;
let particleH = 0;

function ensureParticles(kind: ParticleKind, w: number, h: number): void {
  if (particleKind === kind && particleW === w && particleH === h) return;
  particleKind = kind;
  particleW = w;
  particleH = h;
  particles = seedParticles(kind, w, h);
}

function stepAndDrawRain(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number, reduced: boolean, storm: boolean): void {
  ensureParticles(storm ? "storm" : "rain", w, h);
  ctx.save();
  ctx.strokeStyle = storm ? "rgba(190, 210, 235, 0.55)" : "rgba(200, 216, 232, 0.45)";
  ctx.lineWidth = 1;
  particles.forEach((p) => {
    if (!reduced) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > h) {
        p.y = -10;
        p.x = rand(0, w);
      }
      if (p.x < -10) p.x = w + 10;
    }
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 0.04, p.y - p.size);
    ctx.stroke();
  });
  ctx.restore();
}

function stepAndDrawSnow(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number, reduced: boolean): void {
  ensureParticles("snow", w, h);
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  particles.forEach((p) => {
    if (!reduced) {
      p.phase += dt * 1.4;
      p.y += p.vy * dt;
      p.x += Math.sin(p.phase) * 10 * dt;
      if (p.y > h) {
        p.y = -6;
        p.x = rand(0, w);
      }
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function stepAndDrawBlossom(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number, reduced: boolean): void {
  ensureParticles("blossom", w, h);
  ctx.save();
  ctx.fillStyle = "rgba(255, 200, 214, 0.85)";
  particles.forEach((p) => {
    if (!reduced) {
      p.phase += dt * 1.1;
      p.x += (p.vx + Math.sin(p.phase) * 14) * dt;
      p.y += p.vy * dt;
      if (p.y > h) {
        p.y = -6;
        p.x = rand(0, w);
      }
      if (p.x > w + 10) p.x = -10;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.phase);
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

interface FogBand {
  yFrac: number;
  h: number;
  alphaBase: number;
}
const FOG_BANDS: FogBand[] = [
  { yFrac: 0.25, h: 46, alphaBase: 0.16 },
  { yFrac: 0.52, h: 54, alphaBase: 0.12 },
  { yFrac: 0.8, h: 40, alphaBase: 0.14 },
];
let fogT = 0;

function stepAndDrawFog(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number, reduced: boolean): void {
  if (!reduced) fogT += dt;
  ctx.save();
  FOG_BANDS.forEach((band, i) => {
    const y = h * band.yFrac;
    const pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(fogT * 0.35 + i * 1.7);
    const alpha = band.alphaBase * pulse;
    const grad = ctx.createLinearGradient(0, y - band.h / 2, 0, y + band.h / 2);
    grad.addColorStop(0, "rgba(214, 220, 226, 0)");
    grad.addColorStop(0.5, `rgba(214, 220, 226, ${alpha.toFixed(3)})`);
    grad.addColorStop(1, "rgba(214, 220, 226, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - band.h / 2, w, band.h);
  });
  ctx.restore();
}

// Storm: rain plus an occasional flash — a brief, decaying full-viewport
// wash scheduled at a random interval, skipped entirely under
// prefers-reduced-motion.
let nextFlashAt = 0;
let flashStart = -Infinity;
const FLASH_DURATION_MS = 160;

function stormFlashAlpha(nowMs: number, reduced: boolean): number {
  if (reduced) return 0;
  if (nextFlashAt === 0) nextFlashAt = nowMs + rand(2500, 6000);
  if (nowMs >= nextFlashAt && nowMs > flashStart + FLASH_DURATION_MS + 500) {
    flashStart = nowMs;
    nextFlashAt = nowMs + rand(4000, 9000);
  }
  const elapsed = nowMs - flashStart;
  if (elapsed < 0 || elapsed > FLASH_DURATION_MS) return 0;
  return 0.35 * (1 - elapsed / FLASH_DURATION_MS);
}

/** Draws `weather`'s particles for one frame, in screen space — call from
 * within the caller's own world-space save()/translate(-camX,-camY)/
 * restore() block (see this file's doc comment); this function undoes that
 * translate internally so particle density stays constant regardless of
 * camera pan/zoom. No-op for undefined/"clear". `reducedMotion` freezes
 * particles in place (no drift, no storm flash) rather than hiding them
 * outright, per prefers-reduced-motion's "static or much-reduced". `speedMul`
 * is Feature 2's breathe oscillator (~0.8x-1.3x, see drawWorldEffects below)
 * — applied only to the streaming/falling kinds (rain/storm/snow/blossom) by
 * scaling the dt they step with, not to fog's ambient pulse. */
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  weather: WeatherId | undefined,
  camX: number,
  camY: number,
  viewW: number,
  viewH: number,
  dt: number,
  nowMs: number,
  reducedMotion: boolean,
  speedMul = 1,
): void {
  if (!weather || weather === "clear") return;
  ctx.save();
  ctx.translate(camX, camY);
  ctx.beginPath();
  ctx.rect(0, 0, viewW, viewH);
  ctx.clip();
  const particleDt = dt * speedMul;

  switch (weather) {
    case "rain":
      stepAndDrawRain(ctx, viewW, viewH, particleDt, reducedMotion, false);
      break;
    case "storm": {
      stepAndDrawRain(ctx, viewW, viewH, particleDt, reducedMotion, true);
      const alpha = stormFlashAlpha(nowMs, reducedMotion);
      if (alpha > 0) {
        ctx.fillStyle = `rgba(226, 236, 255, ${alpha.toFixed(3)})`;
        ctx.fillRect(0, 0, viewW, viewH);
      }
      break;
    }
    case "snow":
      stepAndDrawSnow(ctx, viewW, viewH, particleDt, reducedMotion);
      break;
    case "blossom":
      stepAndDrawBlossom(ctx, viewW, viewH, particleDt, reducedMotion);
      break;
    case "fog":
      stepAndDrawFog(ctx, viewW, viewH, dt, reducedMotion);
      break;
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Combined world-effects pass — the tint/glows/weather sequence
// src/main.ts's renderVillage and renderDistrict each used to run inline,
// now shared here so the two stay in lock-step as new effects are added.
// ---------------------------------------------------------------------------

/** What differs between renderVillage's and renderDistrict's call —
 * everything else (time-of-day, weather, lighting) is read once inside
 * drawWorldEffects itself via world-state.ts, since both callers want the
 * same value. `w`/`h` size the tint wash (a scene's full background, not
 * just the viewport); `camX`/`camY`/`viewW`/`viewH` are drawWeather's/
 * drawLighting's own camera/viewport args. `view` picks the light pool's
 * base radius — village anchors are close together on one shared map,
 * district.home is the only point in a much larger per-district bg (see
 * VILLAGE_POOL_RADIUS/DISTRICT_POOL_RADIUS above). `lightCandidates`
 * replaces the old glowCandidates now that lighting punches pools instead of
 * drawing per-point glows. */
export interface WorldEffectsScene {
  w: number;
  h: number;
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
  view: "village" | "district";
  lightCandidates: LightCandidate[];
}

/** Runs one frame's world-effects draw for `scene`: time-of-day tint
 * (dawn/dusk color only now — see TIME_TINTS), then the lighting layer
 * (darkness curve punched with light pools, folding in the old night glows
 * and ACTIVITY_TREATMENT's dormant/quiet darkening — see this file's top
 * doc comment), then weather particles (sped up/slowed by the breathe
 * oscillator) on top of all of it — same order src/main.ts's renderVillage/
 * renderDistrict each ran this sequence in before this was pulled out (see
 * this file's top doc comment for why: called inside the caller's own
 * world-space save()/translate(-camX,-camY)/restore() block). Budget: this
 * draws at most 2 full-viewport washes (dawn/dusk tint, lighting) — the
 * mood tint is a third, separate wash drawn by src/residents.ts's
 * drawMoodTint at the caller's own call site, not here. */
export function drawWorldEffects(ctx: CanvasRenderingContext2D, scene: WorldEffectsScene, env: WorldEnv): void {
  const timeOfDay = getTimeOfDay();
  drawTimeOfDayTint(ctx, timeOfDay, scene.w, scene.h);

  const nowPlayingSlotId = getLiveNowPlaying()?.slotId ?? null;
  const baseRadius = scene.view === "village" ? VILLAGE_POOL_RADIUS : DISTRICT_POOL_RADIUS;
  const pools = buildLightPools(scene.lightCandidates, baseRadius, env, nowPlayingSlotId);
  drawLighting(ctx, scene.camX, scene.camY, env.hour, pools);

  const speedMul = 0.8 + (env.reduced ? 0.5 : env.breathe) * 0.5; // ~0.8x-1.3x, Feature 2
  drawWeather(ctx, getWeather(), scene.camX, scene.camY, scene.viewW, scene.viewH, env.dt, env.ts, env.reduced, speedMul);
}
