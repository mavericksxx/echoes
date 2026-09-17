// Image loading and canvas drawing. Ported from prototypes/konoha-demo/main.js.

import type { CharacterAnims, Rect } from "../data/types";
import type { Direction, Npc } from "./npc";
import { drawOrigin, getSpecialScale, resolvePivot } from "./sprite";

/** A loaded sprite/map image, or a pre-baked recolored copy of one (see
 * src/recolor.ts) — both are valid CanvasRenderingContext2D.drawImage sources. */
export type DrawableImage = HTMLImageElement | HTMLCanvasElement;
export type ImageMap = Record<string, DrawableImage>;

/** Loads every asset key -> URL pair, resolving once all images have settled
 * (loaded or failed — a failed load is logged but does not block the app). */
export function loadImages(urlsByKey: Record<string, string>): Promise<ImageMap> {
  const keys = Object.keys(urlsByKey);
  const images: ImageMap = {};
  return new Promise((resolve) => {
    let settled = 0;
    if (keys.length === 0) {
      resolve(images);
      return;
    }
    keys.forEach((key) => {
      const img = new Image();
      img.onload = () => {
        settled++;
        if (settled === keys.length) resolve(images);
      };
      img.onerror = () => {
        console.error(`Failed to load image for key "${key}": ${urlsByKey[key]}`);
        settled++;
        if (settled === keys.length) resolve(images);
      };
      img.src = urlsByKey[key]!;
      images[key] = img;
    });
  });
}

export function getWalkFrames(anims: CharacterAnims, dir: Direction): Rect[] {
  switch (dir) {
    case "down":
      return anims.walk_down;
    case "left":
      return anims.walk_left;
    case "right":
      return anims.walk_right;
    case "up":
      return anims.walk_up;
  }
}

/** The visible camera rect in world space, used to clamp on-screen overlays
 * (like caption bubbles) so they never draw outside the viewport. */
export interface ViewRect {
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
}

/** The sprite rect an NPC is currently showing, independent of which sheet
 * image it comes from — shared by drawNpc (which also needs the image) and
 * captionAnchor (which only needs the rect's height). */
function currentSprite(npc: Npc): { rect: Rect; label: string; scale: number; sheet: string } {
  const { character } = npc;
  if (npc.state === "performing") {
    const i = npc.performFrame % Math.max(1, character.specials.length);
    const special = character.specials[i];
    if (special) {
      return { rect: special, label: `specials[${i}]`, scale: getSpecialScale(character), sheet: character.battleSheet };
    }
    return { rect: character.idle, label: "idle", scale: 1, sheet: character.sheet };
  }
  if (npc.state === "idle") {
    return { rect: character.idle, label: "idle", scale: 1, sheet: character.sheet };
  }
  const frames = getWalkFrames(character.anims, npc.dir);
  const i = npc.frame % frames.length;
  const frame = frames[i];
  return frame
    ? { rect: frame, label: `walk_${npc.dir}[${i}]`, scale: 1, sheet: character.sheet }
    : { rect: character.idle, label: "idle", scale: 1, sheet: character.sheet };
}

function currentSpriteRect(npc: Npc): Rect {
  return currentSprite(npc).rect;
}

/** Draws one NPC's sprite onto ctx (world space), anchored at its pivot (feet).
 * Caption bubbles are drawn separately, in a screen-space overlay pass — see drawCaptions().
 *
 * If `npc.character.mirrorDirs` includes the NPC's current direction (rigs
 * with only one side pose — see data/npcRigs.json / src/residents.ts), the
 * frame is flipped horizontally within its own destination box instead of
 * drawn as-is.
 *
 * `opts.opacity` (default 1) draws the sprite faded — used for a resident
 * who's stopped charting this range (see src/residents.ts's Resident.faded
 * and SPEC.md's Phase 3 "faded/asleep" requirement). */
export function drawNpc(
  ctx: CanvasRenderingContext2D,
  images: ImageMap,
  npc: Npc,
  _view: ViewRect,
  opts: { opacity?: number } = {},
): void {
  const { rect, label, scale, sheet } = currentSprite(npc);
  const img: DrawableImage = images[sheet]!;
  const [sx, sy, rx1, ry1] = rect;
  const sw = rx1 - sx;
  const sh = ry1 - sy;
  const pivot = resolvePivot(npc.character, label, rect);
  const { dx, dy, dw, dh } = drawOrigin(rect, pivot, npc.x, npc.y, scale);
  const mirror =
    npc.state !== "performing" && (npc.character.mirrorDirs?.some((d) => d === npc.dir) ?? false);
  const opacity = opts.opacity ?? 1;
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (mirror) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  ctx.restore();
}

/** World-space position of the top-center of an NPC's current sprite —
 * where its caption bubble should anchor above. */
export function captionAnchor(npc: Npc): { x: number; y: number } {
  const rect = currentSpriteRect(npc);
  const sh = rect[3] - rect[1];
  return { x: npc.x, y: npc.y - sh };
}

/** The camera state needed to convert world coordinates to screen (CSS px)
 * coordinates for the caption overlay. */
export interface ScreenView {
  camX: number;
  camY: number;
  zoom: number;
}

/** One label to draw in the caption overlay: an NPC's transient "now playing"
 * caption, or (district view — see src/residents.ts) a resident's persistent
 * name label. Both share the same screen-space pass so they can be laid out
 * (and de-collided) against each other, not just within their own kind. */
export interface CaptionLabel {
  npc: Npc;
  text: string;
}

interface PlacedBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// How many times a colliding label is nudged upward (in its own box-height
// steps) before it's given up on and simply not drawn — see drawCaptions'
// "stagger or hide on collision" requirement (Phase 2.5: several persistent
// resident name labels can share a small interior).
const MAX_STAGGER_TIERS = 3;

/** Draws every label (leaders' transient "now playing" captions, residents'
 * persistent name labels) as a glass pill, in screen space, onto a dedicated
 * overlay canvas (see main.ts's captionLayer). Kept separate from the
 * pixel-art canvas so the text renders at full device-pixel resolution —
 * crisp, not pixelated — using the loaded Archivo webfont. `cssW`/`cssH` are
 * the overlay's size in CSS px (its context is expected to already be
 * transform-scaled to the device pixel ratio by the caller).
 *
 * Labels whose boxes would overlap an already-placed one are nudged upward a
 * few times, then skipped entirely if still colliding — small interiors can
 * pack a leader plus several residents close together. */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  labels: CaptionLabel[],
  view: ScreenView,
  cssW: number,
  cssH: number,
): void {
  ctx.clearRect(0, 0, cssW, cssH);
  const placed: PlacedBox[] = [];
  labels.forEach(({ npc, text }) => {
    const anchor = captionAnchor(npc);
    const screenX = (anchor.x - view.camX) * view.zoom;
    const screenTopY = (anchor.y - view.camY) * view.zoom;
    drawCaptionBubble(ctx, text, screenX, screenTopY, cssW, placed);
  });
}

function drawCaptionBubble(
  ctx: CanvasRenderingContext2D,
  text: string,
  anchorX: number,
  topY: number,
  cssW: number,
  placed: PlacedBox[],
): void {
  ctx.save();
  ctx.font = "500 12px Archivo, -apple-system, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const dotR = 3;
  const paddingX = 10;
  const gapAfterDot = 6;
  const boxH = 24;

  // Ellipsize rather than overflow a narrow phone viewport.
  const maxTextW = Math.max(40, cssW - 64);
  let label = text;
  if (ctx.measureText(label).width > maxTextW) {
    while (label.length > 1 && ctx.measureText(`${label}…`).width > maxTextW) {
      label = label.slice(0, -1);
    }
    label = `${label}…`;
  }
  const textW = ctx.measureText(label).width;
  const boxW = paddingX * 2 + dotR * 2 + gapAfterDot + textW;

  const minX = boxW / 2 + 4;
  const maxX = cssW - boxW / 2 - 4;
  const bx = minX > maxX ? cssW / 2 : Math.max(minX, Math.min(maxX, anchorX));
  const baseBy = Math.max(boxH / 2 + 4, topY - 10 - boxH / 2);
  const tierStep = boxH + 4;

  // Try progressively higher tiers until the box clears every already-placed
  // label, giving up (drawing nothing) past MAX_STAGGER_TIERS — see
  // drawCaptions' doc comment.
  let by = baseBy;
  let box: PlacedBox = { x0: bx - boxW / 2, x1: bx + boxW / 2, y0: by - boxH / 2, y1: by + boxH / 2 };
  let tier = 0;
  while (placed.some((p) => overlaps(p, box))) {
    tier++;
    if (tier > MAX_STAGGER_TIERS) {
      ctx.restore();
      return;
    }
    by = Math.max(boxH / 2 + 4, baseBy - tier * tierStep);
    box = { x0: bx - boxW / 2, x1: bx + boxW / 2, y0: by - boxH / 2, y1: by + boxH / 2 };
  }
  placed.push(box);

  const left = bx - boxW / 2;
  const top = by - boxH / 2;
  const radius = boxH / 2;

  ctx.beginPath();
  ctx.moveTo(left + radius, top);
  ctx.arcTo(left + boxW, top, left + boxW, top + boxH, radius);
  ctx.arcTo(left + boxW, top + boxH, left, top + boxH, radius);
  ctx.arcTo(left, top + boxH, left, top, radius);
  ctx.arcTo(left, top, left + boxW, top, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(18, 26, 36, 0.86)";
  ctx.fill();
  ctx.strokeStyle = "rgba(231, 238, 244, 0.20)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = "#55C2CE";
  ctx.shadowColor = "#55C2CE";
  ctx.shadowBlur = 6;
  ctx.arc(left + paddingX + dotR, by, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#E7EEF4";
  ctx.fillText(label, left + paddingX + dotR * 2 + gapAfterDot, by + 1);
  ctx.restore();
}

/** Hit-tests a world-space point against an NPC's on-screen sprite footprint. */
export function hitTestNpc(npc: Npc, wx: number, wy: number): boolean {
  const half = 22;
  return wx > npc.x - half && wx < npc.x + half && wy > npc.y - 40 && wy < npc.y + 10;
}

/** A soft ground ring under the selected NPC (the one whose sidebar is open). */
export function drawSelectionRing(ctx: CanvasRenderingContext2D, npc: Npc): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(npc.x, npc.y + 2, 16, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(85, 194, 206, 0.35)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(85, 194, 206, 0.85)";
  ctx.stroke();
  ctx.restore();
}

/** Draws a character's idle frame centered into a small square canvas, for
 * the sidebar header portrait. Pixelated, unscaled beyond an integer factor. */
export function drawPortrait(
  ctx: CanvasRenderingContext2D,
  images: ImageMap,
  character: { sheet: string; idle: Rect },
): void {
  const { width, height } = ctx.canvas;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  const img = images[character.sheet];
  if (!img) return;
  const [sx, sy, ex, ey] = character.idle;
  const sw = ex - sx;
  const sh = ey - sy;
  const k = Math.max(1, Math.floor(Math.min(width / sw, height / sh)));
  const dw = sw * k;
  const dh = sh * k;
  ctx.drawImage(img, sx, sy, sw, sh, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
}
