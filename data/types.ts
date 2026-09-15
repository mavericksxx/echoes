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
}

/** One genre's district: where the character stands and what plays there. */
export interface DistrictDef {
  /** Matches a CharacterDef.id. */
  id: string;
  genre: string;
  artist: string;
  song: string;
  location: string;
  /** Key into assets.json for the background image. */
  bg: string;
  bgSize: [number, number];
  /** CSS canvas ctx.filter string applied when this district recolors the Konoha map. */
  recolorFilter?: string;
  recolored?: boolean;
  home: Point;
  patrol: Point[];
  note?: string;
}

/** Whole-village view: shared map + anchor spots for every character. */
export interface VillageDef {
  /** Key into assets.json for the village map. */
  mapImage: string;
  mapSize: [number, number];
  anchors: [number, number][];
}

/** Maps an asset key (used by CharacterDef.sheet/battleSheet, DistrictDef.bg,
 * VillageDef.mapImage) to its filename under public/assets/. */
export type AssetManifest = Record<string, string>;
