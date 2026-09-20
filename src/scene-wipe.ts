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
// Bumped on every startSceneWipe call (accepted or rejected) and stamped on
// every debug log this module prints — Chrome's console collapses repeated
// *identical* consecutive log lines into one row with a small counter
// badge, which would make a real re-entrant-call bug (something calling
// startSceneWipe every frame, each time resetting startTs and keeping t
// pinned near 0) look, at a glance, like a single harmless log. A changing
// number defeats that: if this bug recurs, the sequence visibly climbs.
let wipeSeq = 0;
// Bumped every drawSceneWipe call — used only to throttle the periodic
// phase/t trace below (see main.ts's frame()/coordinator's request for
// visibility into whether t is advancing, frozen, or resetting).
let drawCount = 0;

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
 * revealing).
 *
 * Refuses to start a second wipe on top of an in-flight one (logs a warning
 * and keeps the existing one running) rather than silently overwriting
 * `wipe` — overwriting would reset `startTs` to "now" every time it
 * happened, which is exactly what a re-entrant caller (a bug elsewhere)
 * would look like: `t` pinned near 0 forever, no visible progress, no
 * `onCovered`, indistinguishable from the wipe simply never having started.
 * main.ts's own state (pendingDistrictEnter cleared before this is called,
 * sceneTransitionActive as a re-entrancy guard) should already prevent that
 * caller from existing, but this module shouldn't depend on getting that
 * right elsewhere for its own internal invariant (never two wipes at once)
 * to hold. */
export function startSceneWipe(closeCenter: WipeCenter, onCovered: () => WipeCenter): void {
  wipeSeq++;
  if (wipe) {
    console.warn("[scene-wipe]", wipeSeq, "startSceneWipe called while already wiping — ignoring", {
      inFlightPhase: wipe.phase,
      inFlightStartTs: wipe.startTs,
    });
    return;
  }
  wipe = { phase: "closing", startTs: performance.now(), center: closeCenter, onCovered };
  drawCount = 0;
  console.debug("[scene-wipe]", wipeSeq, "closing", closeCenter);
}

/** Forcibly abandons any in-flight wipe without running `onCovered` — an
 * escape hatch for main.ts's transition watchdog (see its doc comment) so a
 * bug in the state machine can never leave input permanently locked, even if
 * it leaves the visible scene in a slightly odd spot. Never called in the
 * normal (working) path. */
export function cancelSceneWipe(): void {
  if (wipe) console.debug("[scene-wipe]", wipeSeq, "cancelled from phase", wipe.phase);
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

  // Roughly every 10 frames while a wipe is active — shows directly whether
  // t is climbing toward 1 (working), frozen at some value (stuck: this
  // drawSceneWipe call isn't the one advancing time, or startTs is wrong),
  // or repeatedly resetting near 0 (something is re-entering startSceneWipe
  // — see its own guard/warning above).
  drawCount++;
  if (drawCount % 10 === 1) {
    console.debug("[scene-wipe]", wipeSeq, "tick", { phase: wipe.phase, t: t.toFixed(3), now, startTs: wipe.startTs });
  }

  if (wipe.phase === "closing") {
    const r = maxR * (1 - easeInCubic(t));
    drawIris(ctx, cx, cy, Math.max(0, r), w, h);
    if (t >= 1) {
      const onCovered = wipe.onCovered!;
      const openCenter = onCovered();
      wipe = { phase: "opening", startTs: now, center: openCenter, onCovered: null };
      drawCount = 0;
      console.debug("[scene-wipe]", wipeSeq, "covered — swap ran, opening", openCenter);
    }
    return;
  }

  const r = maxR * easeOutCubic(t);
  drawIris(ctx, cx, cy, r, w, h);
  if (t >= 1) {
    wipe = null;
    console.debug("[scene-wipe]", wipeSeq, "done");
  }
}
