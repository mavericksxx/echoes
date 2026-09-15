// Shared types for the internal sprite/map data (data/*.json).
//
// This data is internal organization only — it is not a user-facing
// sprite-swap feature. See SPEC.md ("Sprite & map data").

/** Pixel rect [x0, y0, x1, y1] into a sprite sheet, exclusive of x1/y1. */
export type Rect = [number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface CharacterAnims {
  walk_down: Rect[];
  walk_left: Rect[];
  walk_right: Rect[];
  walk_up: Rect[];
}

/** One genre's Naruto character: sprite sheet, animations, battle pose. */
export interface CharacterDef {
  id: string;
  name: string;
  /** Key into assets.json for the overworld sheet (or a shared district bg, e.g. "sand"). */
  sheet: string;
  fps: number;
  anims: CharacterAnims;
  idle: Rect;
  /** Key into assets.json for the battle/special-pose sheet. */
  battleSheet: string;
  specials: Rect[];
  /**
   * Per-frame anchor overrides — the "feet point" a frame is drawn at, in
   * absolute sheet-pixel coordinates. Keyed by "idle", "specials[i]", or
   * "<animName>[i]" (matching scripts/detect-frames.py's labels). Frames not
   * listed here anchor at the bottom-center of their rect by default — see
   * src/sprite.ts. Only needed when that default misplaces a frame (e.g. an
   * asymmetric lunge whose tight bbox isn't centered on the actual feet).
   */
  pivots?: Record<string, Point>;
}

/** One genre's district: where the character stands. Listening data (artist,
 * song, now-playing) lives in src/sample-data.ts instead — this is map/sprite
 * placement only. */
export interface DistrictDef {
  /** Matches a CharacterDef.id. */
  id: string;
  genre: string;
  location: string;
  /** Key into assets.json for the background image; its pixel size is
   * assets.json's own w/h, not duplicated here. */
  bg: string;
  /** CSS canvas ctx.filter string applied when this district recolors the Konoha map. */
  recolorFilter?: string;
  recolored?: boolean;
  home: Point;
  patrol: Point[];
  note?: string;
}

/** Whole-village view: shared map + one anchor spot per character. */
export interface VillageDef {
  /** Key into assets.json for the village map. */
  mapImage: string;
  /** One anchor point per CharacterDef/DistrictDef id — every slot must have one. */
  anchors: Record<string, Point>;
}

/** One entry per asset key (used by CharacterDef.sheet/battleSheet,
 * DistrictDef.bg, VillageDef.mapImage): its filename under public/assets/ and
 * its pixel size, so frame-rect/bounds checks don't need the PNG on disk. */
export interface AssetEntry {
  file: string;
  w: number;
  h: number;
}
export type AssetManifest = Record<string, AssetEntry>;
