// Image loading and canvas drawing. Ported from prototypes/konoha-demo/main.js.

import type { CharacterAnims, Rect } from "../data/types";
import type { Direction, Npc } from "./npc";

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
function currentSpriteRect(npc: Npc): Rect {
  const { character } = npc;
  if (npc.state === "performing") {
    return character.specials[npc.performFrame % character.specials.length] ?? character.idle;
  }
  if (npc.state === "idle") {
    return character.idle;
  }
  const frames = getWalkFrames(character.anims, npc.dir);
  return frames[npc.frame % frames.length] ?? character.idle;
}

/** Draws one NPC's sprite onto ctx (world space). Caption bubbles are drawn
 * separately, in a screen-space overlay pass — see drawCaptions(). */
export function drawNpc(ctx: CanvasRenderingContext2D, images: ImageMap, npc: Npc, _view: ViewRect): void {
  const { character } = npc;
  const img: DrawableImage = images[npc.state === "performing" ? character.battleSheet : character.sheet]!;
  const rect = currentSpriteRect(npc);

  const [sx, sy, rx1, ry1] = rect;
  const sw = rx1 - sx;
  const sh = ry1 - sy;
  const dx = Math.round(npc.x - sw / 2);
  const dy = Math.round(npc.y - sh);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
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

/** Draws every NPC's "now playing" caption as a glass pill, in screen space,
 * onto a dedicated overlay canvas (see main.ts's captionLayer). Kept separate
 * from the pixel-art canvas so the text renders at full device-pixel
 * resolution — crisp, not pixelated — using the loaded Archivo webfont.
 * `cssW`/`cssH` are the overlay's size in CSS px (its context is expected to
 * already be transform-scaled to the device pixel ratio by the caller). */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  npcs: Npc[],
  view: ScreenView,
  cssW: number,
  cssH: number,
): void {
  ctx.clearRect(0, 0, cssW, cssH);
  npcs.forEach((npc) => {
    if (!npc.caption) return;
    const anchor = captionAnchor(npc);
    const screenX = (anchor.x - view.camX) * view.zoom;
    const screenTopY = (anchor.y - view.camY) * view.zoom;
    drawCaptionBubble(ctx, npc.caption!, screenX, screenTopY, cssW);
  });
}

function drawCaptionBubble(ctx: CanvasRenderingContext2D, text: string, anchorX: number, topY: number, cssW: number): void {
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
  const by = Math.max(boxH / 2 + 4, topY - 10 - boxH / 2);
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
