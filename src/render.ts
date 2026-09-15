// Image loading and canvas drawing. Ported from prototypes/konoha-demo/main.js.

import type { CharacterAnims, Rect } from "../data/types";
import type { Direction, Npc } from "./npc";

export type ImageMap = Record<string, HTMLImageElement>;

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
  let img: HTMLImageElement;
  let rect: Rect;

  if (npc.state === "performing") {
    img = images[character.battleSheet]!;
    rect = character.specials[npc.performFrame % character.specials.length] ?? character.idle;
  } else if (npc.state === "idle") {
    img = images[character.sheet]!;
    rect = character.idle;
  } else {
    img = images[character.sheet]!;
    const frames = getWalkFrames(character.anims, npc.dir);
    rect = frames[npc.frame % frames.length] ?? character.idle;
  }

  const [sx, sy, rx1, ry1] = rect;
  const sw = rx1 - sx;
  const sh = ry1 - sy;
  const dx = Math.round(npc.x - sw / 2);
  const dy = Math.round(npc.y - sh);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);

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
