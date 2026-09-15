// Pivot-anchored sprite placement. Frame rects in data/characters.json are
// tight bounding boxes of varying width/height (a raised arm, spiky hair, a
// weapon), so anchoring on the rect's own center/bottom (as a naive
// `x - w/2, y - h`) makes the sprite drift sideways or bob vertically as the
// animation cycles between differently-sized frames. Anchoring on an
// explicit pivot — the character's feet point, fixed relative to the art —
// keeps the sprite planted at the NPC's world position across every frame.
//
// Kept separate from render.ts (owned by a concurrent branch) so this logic
// has a single, low-conflict home; render.ts just calls into it.

import type { CharacterDef, Rect } from "../data/types";

/** Default pivot when a frame has no override: bottom-center of its rect —
 * a reasonable "feet point" for a tight bbox. */
export function defaultPivot(rect: Rect): [number, number] {
  return [(rect[0] + rect[2]) / 2, rect[3]];
}

/** Resolves the pivot for a labeled frame (see CharacterDef.pivots for the
 * label format), falling back to bottom-center. */
export function resolvePivot(character: CharacterDef, label: string, rect: Rect): [number, number] {
  const override = character.pivots?.[label];
  if (override) return [override.x, override.y];
  return defaultPivot(rect);
}

/** Where to draw a sheet rect (top-left, in destination/world space) so that
 * its pivot lands exactly on (anchorX, anchorY). World coords are floats
 * (sub-pixel movement); the result is rounded to an integer pixel so the
 * sheet is never drawn on a blurry half-pixel boundary. `scale` (default 1)
 * uniformly resizes the frame around its pivot — see getSpecialScale. */
export function drawOrigin(
  rect: Rect,
  pivot: [number, number],
  anchorX: number,
  anchorY: number,
  scale = 1,
): { dx: number; dy: number; dw: number; dh: number } {
  const [sx, sy, ex, ey] = rect;
  const sw = ex - sx;
  const sh = ey - sy;
  const [px, py] = pivot;
  const offsetX = (px - sx) * scale;
  const offsetY = (py - sy) * scale;
  return {
    dx: Math.round(anchorX - offsetX),
    dy: Math.round(anchorY - offsetY),
    dw: sw * scale,
    dh: sh * scale,
  };
}

const specialScaleCache = new WeakMap<CharacterDef, number>();

/**
 * Battle-sheet "specials" art is drawn at a visibly larger native pixel
 * scale than the overworld walk sprites (see BACKLOG/report — the two rips
 * come from different in-game screens). Drawing both at 1:1 makes a
 * character visibly grow the moment it performs. Rather than pick from a
 * mismatched battle sheet inconsistently or drop the feature outright, this
 * computes one fixed scale factor per character — from the ratio of its
 * idle height to its specials' average height — and applies it to every
 * special frame equally, so the character's size never changes between
 * consecutive frames of its own special (only once, consistently, relative
 * to its walk sprite). Characters whose specials come from the overworld
 * sheet itself (naruto/sakura/kakashi — see characters.json) already match
 * scale, so this resolves to ~1 for them.
 */
export function getSpecialScale(character: CharacterDef): number {
  const cached = specialScaleCache.get(character);
  if (cached !== undefined) return cached;

  let scale = 1;
  if (character.specials.length > 0) {
    const idleH = character.idle[3] - character.idle[1];
    const meanSpecialH =
      character.specials.reduce((sum, r) => sum + (r[3] - r[1]), 0) / character.specials.length;
    if (meanSpecialH > 0) scale = idleH / meanSpecialH;
  }
  specialScaleCache.set(character, scale);
  return scale;
}
