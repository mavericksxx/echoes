// DS-style iris scene wipe — a state machine redrawn every frame in canvas
// pixel space (see main.ts's frame(), called after the world/caption render
// passes restore). Deliberately outlives a mid-transition canvas resize:
// centers are stored as fractions of the canvas (0..1), not pixel
// coordinates, so applyDistrictScene's fitCanvas() call (which changes
// canvas.width/height and clears everything) can't desync the wipe's math —
// see main.ts's enterDistrict/exitToVillage for the sequencing that calls
// into this module.
//
// Timing is entirely self-contained (performance.now(), read fresh on every
// call) rather than threaded through frame()'s rAF timestamp — the two
// clocks share an origin in practice, but there's no reason for this module
// to depend on that being exactly true, and it keeps drawSceneWipe callable
// with nothing but a context and a size.

/** A wipe center, as a fraction of the canvas's current width/height —
 * survives a resize because it's re-multiplied by the live canvas size on
 * every draw, unlike a pixel coordinate captured once. */
export interface WipeCenter {
  x: number;
  y: number;
}

type WipePhase = "closing" | "opening";

interface WipeState {
  phase: WipePhase;
  startTs: number;
  center: WipeCenter;
  /** Runs once, the instant the closing iris fully covers the screen — does
   * the actual scene swap and returns where the opening iris should grow
   * from (e.g. the district leader's now-current screen position). */
  onCovered: (() => WipeCenter) | null;
}

let wipe: WipeState | null = null;

const WIPE_MS = 260; // each phase (close, open) — roughly SCENE_TRANSITION_MS

function easeInCubic(t: number): number {
  return t * t * t;
}
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** True while either phase (closing or opening) is in flight — main.ts uses
 * this to keep its re-entrancy guard held until the whole wipe (not just the
 * covering half) has finished. */
export function isSceneWiping(): boolean {
  return wipe !== null;
}

/** Debug/self-check accessor (see main.ts's frame() and BACKLOG-adjacent
 * console.debug tracing) — not used by any rendering or state-machine logic
 * itself, just a window into "what phase is the wipe actually in right now"
 * from outside this module, since the state above is otherwise private. */
export function getWipePhase(): WipePhase | null {
  return wipe ? wipe.phase : null;
}

/** Starts the wipe: a circle centered on `closeCenter` shrinks to nothing
 * (fully covering the canvas in black), then `onCovered` runs — swap the
 * scene and hand back where the reveal should grow open from — then a
 * second circle grows from that point back out to nothing (fully
 * revealing). */
export function startSceneWipe(closeCenter: WipeCenter, onCovered: () => WipeCenter): void {
  wipe = { phase: "closing", startTs: performance.now(), center: closeCenter, onCovered };
  console.debug("[scene-wipe] closing", closeCenter);
}

/** Forcibly abandons any in-flight wipe without running `onCovered` — an
 * escape hatch for main.ts's transition watchdog (see its doc comment) so a
 * bug in the state machine can never leave input permanently locked, even if
 * it leaves the visible scene in a slightly odd spot. Never called in the
 * normal (working) path. */
export function cancelSceneWipe(): void {
  if (wipe) console.debug("[scene-wipe] cancelled from phase", wipe.phase);
  wipe = null;
}

function maxRadius(cx: number, cy: number, w: number, h: number): number {
  const corners: Array<[number, number]> = [[0, 0], [w, 0], [0, h], [w, h]];
  return Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)));
}

function drawIris(ctx: CanvasRenderingContext2D, cx: number, cy: number, holeR: number, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "#0a0a0a";
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  if (holeR > 0.5) {
    // A separate subpath (moveTo, not a lineTo continuing from rect's last
    // point) so evenodd fill cuts a clean hole instead of a thin connecting
    // seam between the rect's corner and the circle.
    ctx.moveTo(cx + holeR, cy);
    ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
  }
  ctx.fill("evenodd");
  ctx.restore();
}

/** Draws the current wipe frame (a no-op if none is in flight) onto the
 * given canvas-pixel-space context — call last, every frame, after the
 * world/caption render passes have already restore()'d back to identity
 * transform. `w`/`h` are the canvas's live backing-store size (canvas.width/
 * height), read fresh each call so a resize mid-wipe is picked up
 * automatically. */
export function drawSceneWipe(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (!wipe) return;
  const cx = wipe.center.x * w;
  const cy = wipe.center.y * h;
  const maxR = maxRadius(cx, cy, w, h);
  const now = performance.now();
  const t = Math.max(0, Math.min(1, (now - wipe.startTs) / WIPE_MS));

  if (wipe.phase === "closing") {
    const r = maxR * (1 - easeInCubic(t));
    drawIris(ctx, cx, cy, Math.max(0, r), w, h);
    if (t >= 1) {
      const onCovered = wipe.onCovered!;
      const openCenter = onCovered();
      wipe = { phase: "opening", startTs: now, center: openCenter, onCovered: null };
      console.debug("[scene-wipe] covered — swap ran, opening", openCenter);
    }
    return;
  }

  const r = maxR * easeOutCubic(t);
  drawIris(ctx, cx, cy, r, w, h);
  if (t >= 1) {
    wipe = null;
    console.debug("[scene-wipe] done");
  }
}
