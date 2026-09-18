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
  /**
   * Directions that should be drawn horizontally mirrored from the *other*
   * horizontal direction's frames, rather than from their own art — for
   * sheets with only one side pose (see data/npcRigs.json / src/residents.ts).
   * Not used by the 17 roster characters, which already have real art (or an
   * explicit walk_up-mirrors-walk_down note) for every direction.
   */
  mirrorDirs?: ("left" | "right")[];
  /**
   * True when this sheet has no genuine back-facing pose — walk_up is a
   * byte-identical duplicate of walk_down (see scripts/check-data.mjs's
   * KNOWN_DUPLICATE_DIRECTIONS, which reads this flag instead of hard-coding
   * the set). A wander leg that resolves "up" doesn't turn these characters
   * around — it slides their front-facing art backwards ("moonwalking") — so
   * src/npc.ts only ever gives them an up leg merged into a side-facing
   * diagonal (see SPEC.md Phase 4).
   */
  lacksBackArt?: boolean;
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
  note?: string;
}

/** Whole-village view: shared map + one anchor spot per character. */
export interface VillageDef {
  /** Key into assets.json for the village map. */
  mapImage: string;
  /** One anchor point per CharacterDef/DistrictDef id — every slot must have one. */
  anchors: Record<string, Point>;
  /**
   * One "door" point per slot — on/near the matching building where one
   * exists (e.g. Ichiraku Ramen for Naruto/Hip-Hop) — where the "Enter
   * district" action (Phase 2.5) conceptually enters from, and where Phase
   * 4's walk-to-door pathing will eventually send the camera. Every slot
   * must have one, same as anchors.
   */
  doors: Record<string, Point>;
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

/**
 * One map's walkability grid (data/walkability.json), keyed by asset key —
 * not district id, since `town` is both the village map and Naruto's
 * district bg, so one grid serves both. `.` = walkable, `#` = blocked;
 * `cols`/`rows` are `ceil(w/cell)`/`ceil(h/cell)` against that asset's
 * declared size in assets.json. See src/pathfinding.ts for the consumers and
 * scripts/check-data.mjs for validation.
 */
export interface WalkGrid {
  cell: number;
  cols: number;
  rows: number;
  grid: string[];
}
export type WalkabilityManifest = Record<string, WalkGrid>;

/**
 * One generic NPC rig (see raw/hiddenleafninja_79019.png): a 3-frame walk
 * cycle for down/side/up only — there's no separate left/right art, so
 * src/residents.ts builds a CharacterDef whose walk_left and walk_right both
 * point at `side`, with `facing` telling the renderer (CharacterDef.mirrorDirs)
 * which of the two to flip. Used only for district resident NPCs (Phase 2.5),
 * never for the 17 roster characters.
 */
export interface NpcRigDef {
  /** Key into assets.json for the rig sheet. */
  sheet: string;
  down: Rect[];
  side: Rect[];
  up: Rect[];
  /** Which horizontal direction `side`'s art faces natively. */
  facing: "left" | "right";
}
export type NpcRigManifest = Record<string, NpcRigDef>;
