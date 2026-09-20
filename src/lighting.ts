// Feature 1 (real lighting): a single darkness layer that replaces three
// things that used to stack — src/world-render.ts's old "night" time-of-day
// tint, its per-point night-glow gradients, and src/residents.ts's
// ACTIVITY_TREATMENT dormant/quiet full-bg overlay (all deleted at their own
// call sites; see world-render.ts's drawWorldEffects for how this is wired
// in). One offscreen canvas, sized to the main canvas's backing store and
// reused every frame instead of allocated per frame, filled with darkness
// whose alpha comes from a smooth hour curve (not the four discrete
// TimeOfDayId buckets — smooth is what lets a future time-lapse sweep it
// across a day), then punched with a pre-baked light-pool blob via
// destination-out, then drawImage'd onto the caller's context in screen
// space. No createRadialGradient/createLinearGradient, no ctx.filter (some
// WebKit builds silently no-op it — see src/recolor.ts), no getImageData,
// and no per-frame canvas allocation anywhere in this file's per-frame path.

import type { Point } from "../data/types";

// ---------------------------------------------------------------------------
// Darkness curve
// ---------------------------------------------------------------------------
const MAX_DARK_ALPHA = 0.6;

/** 0 (full daylight) .. 1 (full night) from a fractional owner-local hour
 * (world-state.ts's getSceneHour(), 0..24) — smoothstep centered on noon/
 * midnight, so daylight stays bright and night stays dark with a soft
 * dawn/dusk ramp between rather than either the old four-bucket snap or a
 * plain triangular lerp. Expected shape (before the *MAX_DARK_ALPHA scale
 * this feeds into drawLighting):
 *   0h  -> 1.0   (midnight, darkest)
 *   6h  -> ~0.5
 *   12h -> 0.0   (noon, brightest)
 *   18h -> ~0.5
 *   24h -> 1.0   (back to midnight)
 * `distFromMidnight` is 0 at midnight and 12 at noon (the nearest of the
 * distances to the 0h and 24h wrap-around points) — `t` then inverts that
 * into "how dark", not "how far from noon". */
export function darknessForHour(hour: number): number {
  const distFromMidnight = Math.min(hour, 24 - hour); // 0 (midnight) .. 12 (noon)
  const t = 1 - distFromMidnight / 12; // 1 (midnight) .. 0 (noon)
  return t * t * (3 - 2 * t); // smoothstep
}

// ---------------------------------------------------------------------------
// Pre-baked light-pool blob — built once (lazily, on first use) as concentric
// flat-alpha rings rather than a createRadialGradient, both because a
// gradient is forbidden in the per-frame path and because flat rings read as
// DS-style dithering over the pixel art instead of a smooth web gradient.
// Drawn outermost-faintest-first so each inner ring's fill sits on top.
// ---------------------------------------------------------------------------
const BLOB_SIZE = 128;
const BLOB_RADIUS = BLOB_SIZE / 2;
const BLOB_RINGS: { radiusFrac: number; alpha: number }[] = [
  { radiusFrac: 1.0, alpha: 0.22 },
  { radiusFrac: 0.72, alpha: 0.48 },
  { radiusFrac: 0.44, alpha: 0.75 },
  { radiusFrac: 0.2, alpha: 1.0 },
];

let blobCanvas: HTMLCanvasElement | null = null;

function bakeBlob(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = BLOB_SIZE;
  c.height = BLOB_SIZE;
  const bctx = c.getContext("2d")!;
  bctx.fillStyle = "#fff";
  BLOB_RINGS.forEach((ring) => {
    bctx.globalAlpha = ring.alpha;
    bctx.beginPath();
    bctx.arc(BLOB_RADIUS, BLOB_RADIUS, BLOB_RADIUS * ring.radiusFrac, 0, Math.PI * 2);
    bctx.fill();
  });
  return c;
}

// ---------------------------------------------------------------------------
// The darkness layer — one offscreen canvas, sized to the main canvas's
// backing store and resized only when that resizes (see resizeLighting,
// called from src/main.ts's applyCanvasSize), never allocated per frame.
// ---------------------------------------------------------------------------
let layer: HTMLCanvasElement | null = null;
let layerCtx: CanvasRenderingContext2D | null = null;
let layerW = 0;
let layerH = 0;

/** (Re)allocates the darkness layer to `w`x`h` — the main canvas's backing
 * store size. A no-op when already that size, so it's cheap to call from
 * applyCanvasSize on every resize, not just the ones that actually change
 * dimensions. */
export function resizeLighting(w: number, h: number): void {
  if (layer && layerW === w && layerH === h) return;
  layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  layerCtx = layer.getContext("2d");
  layerW = w;
  layerH = h;
}

/** One light pool for this frame: a world-space point, this frame's already-
 * lerped intensity (0..1 — see lerpTowards below), and a world-pixel radius
 * (already "breathing" for the now-playing district — see src/main.ts's
 * frame() oscillator and world-render.ts's caller). */
export interface LightPool {
  point: Point;
  intensity: number;
  radius: number;
}

/** Lerps `current` toward `target` with roughly a `msConstant` time constant
 * (default ~150ms per SPEC) — an exponential approach, framerate-independent
 * via `dt` (seconds), so activity-level changes (and a future time-lapse's
 * steps) fade in/out instead of popping. */
export function lerpTowards(current: number, target: number, dt: number, msConstant = 150): number {
  const rate = 1 - Math.exp((-dt * 1000) / msConstant);
  return current + (target - current) * rate;
}

/** Draws this frame's darkness layer and composites it onto `ctx` in screen
 * space. `camX`/`camY` are the caller's world-space camera offset — used to
 * convert each pool's world-space point into the layer's own screen-space
 * coordinates (the layer is sized to the viewport, not the world map), and
 * to undo the caller's own world-space translate before the final
 * drawImage, the same trick src/world-render.ts's drawWeather already uses.
 * Call from within the caller's world-space transform. No-op until
 * resizeLighting has been called at least once. */
export function drawLighting(ctx: CanvasRenderingContext2D, camX: number, camY: number, hour: number, pools: LightPool[]): void {
  if (!layer || !layerCtx) return;
  const darkness = darknessForHour(hour) * MAX_DARK_ALPHA;
  if (darkness <= 0.003) return; // nothing to draw — skip the fill, punch, and composite entirely

  if (!blobCanvas) blobCanvas = bakeBlob();
  const lctx = layerCtx;
  lctx.clearRect(0, 0, layerW, layerH);
  lctx.globalCompositeOperation = "source-over";
  lctx.fillStyle = `rgba(6, 10, 24, ${darkness.toFixed(3)})`;
  lctx.fillRect(0, 0, layerW, layerH);

  lctx.globalCompositeOperation = "destination-out";
  pools.forEach((pool) => {
    if (pool.intensity <= 0.01) return;
    const sx = pool.point.x - camX;
    const sy = pool.point.y - camY;
    const d = pool.radius * 2;
    lctx.globalAlpha = Math.min(1, pool.intensity);
    lctx.drawImage(blobCanvas!, sx - pool.radius, sy - pool.radius, d, d);
  });
  lctx.globalAlpha = 1;
  lctx.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.translate(camX, camY); // undo the caller's world-space translate — layer is already screen space
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}
