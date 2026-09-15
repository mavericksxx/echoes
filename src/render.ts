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

/** Draws one NPC (sprite + caption bubble, if any) onto ctx. */
export function drawNpc(
  ctx: CanvasRenderingContext2D,
  images: ImageMap,
  npc: Npc,
  canvasWidth: number,
): void {
  const { character } = npc;
  let img: DrawableImage;
  let rect: Rect;
  let label: string;
  let scale = 1;

  if (npc.state === "performing") {
    img = images[character.battleSheet]!;
    const i = npc.performFrame % character.specials.length;
    rect = character.specials[i] ?? character.idle;
    label = character.specials[i] ? `specials[${i}]` : "idle";
    scale = getSpecialScale(character);
  } else if (npc.state === "idle") {
    img = images[character.sheet]!;
    rect = character.idle;
    label = "idle";
  } else {
    img = images[character.sheet]!;
    const frames = getWalkFrames(character.anims, npc.dir);
    const i = npc.frame % frames.length;
    rect = frames[i] ?? character.idle;
    label = frames[i] ? `walk_${npc.dir}[${i}]` : "idle";
  }

  const [sx, sy, rx1, ry1] = rect;
  const sw = rx1 - sx;
  const sh = ry1 - sy;
  const pivot = resolvePivot(character, label, rect);
  const { dx, dy, dw, dh } = drawOrigin(rect, pivot, npc.x, npc.y, scale);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);

  if (npc.caption) drawCaption(ctx, npc.caption, npc.x, dy, canvasWidth);
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  anchorX: number,
  spriteTopY: number,
  canvasWidth: number,
): void {
  ctx.save();
  ctx.font = "9px monospace";
  ctx.textAlign = "center";
  const maxW = Math.min(150, canvasWidth - 12);
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  words.forEach((w) => {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);

  const boxW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 10;
  const boxH = lines.length * 11 + 6;
  const bx = Math.max(boxW / 2 + 2, Math.min(canvasWidth - boxW / 2 - 2, anchorX));
  const by = Math.max(2, spriteTopY - boxH - 6);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(bx - boxW / 2, by, boxW, boxH);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#111";
  lines.forEach((l, i) => ctx.fillText(l, bx, by + 4 + i * 11));
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
  ctx.fillStyle = "rgba(255, 157, 61, 0.35)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 157, 61, 0.85)";
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
