#!/usr/bin/env node
// Validates data/*.json (ported from prototypes/konoha-demo/verify.js), split
// into two tiers:
//
//  - Data-only checks: every frame rect (anims/idle/specials) fits within its
//    sheet's *declared* size (assets.json's own w/h — no PNG file needed),
//    every district/village reference resolves, all 17 slots are present, and
//    every slot has exactly one village anchor. These always run, so this
//    script is CI-safe even without the (copyrighted, gitignored) PNGs.
//  - Local-only PNG check: if public/assets/ has been populated by
//    `npm run assets:sync`, also verifies each file actually exists and its
//    real PNG dimensions match what assets.json declares (catches drift if
//    the source rip ever changes). Skipped — not failed — when the PNGs
//    aren't present locally.
//
// Usage: npm run check:data
"use strict";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { syncAssets } from "./sync-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(ROOT, "public", "assets");

const EXPECTED_SLOT_COUNT = 17;

async function loadJson(name) {
  return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8"));
}

function checkRectInSize(errors, label, w, h, rect) {
  const [x0, y0, x1, y1] = rect;
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > w || y1 > h) {
    errors.push(`${label}: rect [${rect.join(",")}] out of bounds for a ${w}x${h} sheet`);
  }
}

/** Tier 1 — pure data checks, never touches the filesystem for PNGs. */
function checkDataOnly({ characters, districts, village, assets }) {
  const errors = [];
  let checks = 0;

  function assetSize(key, label) {
    checks++;
    const entry = assets[key];
    if (!entry || typeof entry.w !== "number" || typeof entry.h !== "number") {
      errors.push(`${label}: asset key '${key}' is missing from assets.json (or has no w/h)`);
      return null;
    }
    return [entry.w, entry.h];
  }

  // Every character's anim/idle/special rects are within their sheet's declared bounds.
  for (const def of characters) {
    const sheetSize = assetSize(def.sheet, `${def.id}.sheet`);
    for (const animName of Object.keys(def.anims)) {
      def.anims[animName].forEach((rect, i) => {
        checks++;
        if (sheetSize) checkRectInSize(errors, `${def.id}.${animName}[${i}]`, ...sheetSize, rect);
      });
    }
    checks++;
    if (sheetSize) checkRectInSize(errors, `${def.id}.idle`, ...sheetSize, def.idle);

    const battleSize = assetSize(def.battleSheet, `${def.id}.battleSheet`);
    (def.specials || []).forEach((rect, i) => {
      checks++;
      if (battleSize) checkRectInSize(errors, `${def.id}.specials[${i}]`, ...battleSize, rect);
    });
  }

  // Every district's bg resolves. (Home's walkable-cell check — which
  // subsumes bounds-checking — lives in checkWalkability below, replacing
  // the old patrol-bounds check now that patrol is gone; see SPEC.md Phase 4.)
  for (const def of districts) {
    assetSize(def.bg, `${def.id}.bg`);
  }

  // Exactly 17 slots, one character per district, no duplicate genres.
  checks++;
  if (characters.length !== EXPECTED_SLOT_COUNT) {
    errors.push(`expected ${EXPECTED_SLOT_COUNT} characters, found ${characters.length}`);
  }
  checks++;
  if (districts.length !== EXPECTED_SLOT_COUNT) {
    errors.push(`expected ${EXPECTED_SLOT_COUNT} districts, found ${districts.length}`);
  }
  const characterIds = new Set(characters.map((c) => c.id));
  for (const d of districts) {
    checks++;
    if (!characterIds.has(d.id)) {
      errors.push(`district '${d.id}' has no matching character in characters.json`);
    }
  }
  const seenGenres = new Set();
  for (const d of districts) {
    checks++;
    if (seenGenres.has(d.genre)) errors.push(`duplicate genre district: ${d.genre}`);
    seenGenres.add(d.genre);
  }

  // Village: map resolves, and every slot has exactly one anchor inside it.
  const mapSize = assetSize(village.mapImage, "village.mapImage");
  const anchorIds = new Set(Object.keys(village.anchors));
  for (const id of characterIds) {
    checks++;
    if (!anchorIds.has(id)) errors.push(`village.anchors is missing an entry for slot '${id}'`);
  }
  for (const id of anchorIds) {
    checks++;
    if (!characterIds.has(id)) errors.push(`village.anchors has an entry for unknown slot '${id}'`);
  }
  for (const [id, p] of Object.entries(village.anchors)) {
    checks++;
    if (!mapSize) continue;
    const [w, h] = mapSize;
    if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) {
      errors.push(`village anchor '${id}' (${p.x},${p.y}) is outside the ${w}x${h} map`);
    }
  }

  // Village doors (Phase 2.5): same one-per-slot, in-bounds rules as anchors.
  const doorIds = new Set(Object.keys(village.doors || {}));
  for (const id of characterIds) {
    checks++;
    if (!doorIds.has(id)) errors.push(`village.doors is missing an entry for slot '${id}'`);
  }
  for (const id of doorIds) {
    checks++;
    if (!characterIds.has(id)) errors.push(`village.doors has an entry for unknown slot '${id}'`);
  }
  for (const [id, p] of Object.entries(village.doors || {})) {
    checks++;
    if (!mapSize) continue;
    const [w, h] = mapSize;
    if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) {
      errors.push(`village door '${id}' (${p.x},${p.y}) is outside the ${w}x${h} map`);
    }
  }

  return { errors, checks };
}

/** Resident NPC rigs (Phase 2.5, data/npcRigs.json): each rig's down/side/up
 * frame rects must be 3-long and fit within its sheet's declared bounds. */
function checkNpcRigs(npcRigs, assets) {
  const errors = [];
  let checks = 0;

  for (const [rigId, rig] of Object.entries(npcRigs)) {
    checks++;
    const entry = assets[rig.sheet];
    if (!entry || typeof entry.w !== "number" || typeof entry.h !== "number") {
      errors.push(`npcRigs.${rigId}: asset key '${rig.sheet}' is missing from assets.json (or has no w/h)`);
      continue;
    }
    for (const dir of ["down", "side", "up"]) {
      checks++;
      const frames = rig[dir] || [];
      if (frames.length !== 3) {
        errors.push(`npcRigs.${rigId}.${dir}: expected 3 frames, found ${frames.length}`);
      }
      frames.forEach((rect, i) => {
        checks++;
        checkRectInSize(errors, `npcRigs.${rigId}.${dir}[${i}]`, entry.w, entry.h, rect);
      });
    }
    checks++;
    if (rig.facing !== "left" && rig.facing !== "right") {
      errors.push(`npcRigs.${rigId}.facing: expected "left" or "right", found ${JSON.stringify(rig.facing)}`);
    }
  }

  return { errors, checks };
}

// ---------------------------------------------------------------------------
// Walkability (data/walkability.json): still tier 1 (data-only, no PNGs) —
// see SPEC.md Phase 4. The BFS/flood-fill helpers below duplicate
// src/pathfinding.ts's isWalkable/reachableWithin logic (~30 lines): this is
// a plain-Node script with no bundler, so it can't import that TS module.
// ---------------------------------------------------------------------------

const WALK_CELL_SIZES = new Set([8, 16]);

// Radii mirror src/npc.ts's per-role wander radii (village leader 5,
// district leader 4, resident 2-3), so "is there room to wander" matches
// what actually happens at runtime. village.doors has no wander logic of
// its own (that's Phase 5's walk-to-door pathing) — it gets the smallest
// (resident-floor) radius as a "not a one-cell closet" sanity floor.
const HOME_WANDER_RADIUS = 4;
const ANCHOR_WANDER_RADIUS = 5;
const DOOR_WANDER_RADIUS = 2;
const MIN_WANDER_ROOM = 6;

const WALK_NEIGHBOR_OFFSETS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function isWalkableCell(grid, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return false;
  return grid.grid[cy][cx] === ".";
}

/** BFS in path steps (not Euclidean distance) — how many walkable cells
 * (including the start) are reachable within `radius` steps. */
function bfsReachableCount(grid, startCx, startCy, radius) {
  if (!isWalkableCell(grid, startCx, startCy)) return 0;
  const dist = new Map([[`${startCx},${startCy}`, 0]]);
  const queue = [[startCx, startCy]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    const d = dist.get(`${cx},${cy}`);
    if (d >= radius) continue;
    for (const [dx, dy] of WALK_NEIGHBOR_OFFSETS) {
      const ncx = cx + dx;
      const ncy = cy + dy;
      const key = `${ncx},${ncy}`;
      if (dist.has(key) || !isWalkableCell(grid, ncx, ncy)) continue;
      dist.set(key, d + 1);
      queue.push([ncx, ncy]);
    }
  }
  return dist.size;
}

/** 4-connected flood fill: labels every walkable cell with a component id. */
function floodFillComponents(grid) {
  const componentOf = new Map();
  let count = 0;
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const key = `${cx},${cy}`;
      if (!isWalkableCell(grid, cx, cy) || componentOf.has(key)) continue;
      count++;
      const queue = [[cx, cy]];
      componentOf.set(key, count);
      let head = 0;
      while (head < queue.length) {
        const [qx, qy] = queue[head++];
        for (const [dx, dy] of WALK_NEIGHBOR_OFFSETS) {
          const ncx = qx + dx;
          const ncy = qy + dy;
          const nkey = `${ncx},${ncy}`;
          if (componentOf.has(nkey) || !isWalkableCell(grid, ncx, ncy)) continue;
          componentOf.set(nkey, count);
          queue.push([ncx, ncy]);
        }
      }
    }
  }
  return { componentOf, count };
}

/** Validates data/walkability.json's shape, that every district.home,
 * village.anchors[id], and village.doors[id] sits on a walkable cell with
 * enough room to wander, and that each map's walkable cells relevant to
 * those points form one connected component. */
function checkWalkability({ districts, village, assets, walkability }) {
  const errors = [];
  const warnings = [];
  let checks = 0;

  const referencedKeys = new Set(districts.map((d) => d.bg));
  referencedKeys.add(village.mapImage);

  for (const key of referencedKeys) {
    checks++;
    if (!walkability[key]) {
      errors.push(`walkability.json is missing an entry for '${key}' (used as a district bg or village.mapImage)`);
    }
  }
  for (const key of Object.keys(walkability)) {
    checks++;
    if (!assets[key]) {
      errors.push(`walkability.json has an entry for unknown asset key '${key}'`);
    } else if (!referencedKeys.has(key)) {
      warnings.push(
        `walkability.json has an entry for '${key}', which no district.bg or village.mapImage references`,
      );
    }
  }

  // Points to validate, grouped by the map they live on.
  const pointsByMap = new Map();
  function addPoint(mapKey, label, point, radius) {
    if (!pointsByMap.has(mapKey)) pointsByMap.set(mapKey, []);
    pointsByMap.get(mapKey).push({ label, point, radius });
  }
  for (const d of districts) addPoint(d.bg, `${d.id}.home`, d.home, HOME_WANDER_RADIUS);
  for (const [id, p] of Object.entries(village.anchors || {})) {
    addPoint(village.mapImage, `village.anchors.${id}`, p, ANCHOR_WANDER_RADIUS);
  }
  for (const [id, p] of Object.entries(village.doors || {})) {
    addPoint(village.mapImage, `village.doors.${id}`, p, DOOR_WANDER_RADIUS);
  }

  for (const [mapKey, grid] of Object.entries(walkability)) {
    checks++;
    if (!WALK_CELL_SIZES.has(grid.cell)) {
      errors.push(`${mapKey}.cell: expected 8 or 16, found ${grid.cell}`);
      continue;
    }
    const assetEntry = assets[mapKey];
    if (!assetEntry) continue; // already reported above as an unknown key

    const expectedCols = Math.ceil(assetEntry.w / grid.cell);
    const expectedRows = Math.ceil(assetEntry.h / grid.cell);
    checks++;
    if (grid.cols !== expectedCols) {
      errors.push(`${mapKey}.cols: expected ${expectedCols} (ceil(${assetEntry.w}/${grid.cell})), found ${grid.cols}`);
    }
    checks++;
    if (grid.rows !== expectedRows) {
      errors.push(`${mapKey}.rows: expected ${expectedRows} (ceil(${assetEntry.h}/${grid.cell})), found ${grid.rows}`);
    }
    checks++;
    let malformed = grid.grid.length !== grid.rows;
    if (malformed) errors.push(`${mapKey}.grid: expected ${grid.rows} row(s), found ${grid.grid.length}`);

    grid.grid.forEach((row, i) => {
      checks++;
      if (row.length !== grid.cols) {
        errors.push(`${mapKey}.grid[${i}]: expected length ${grid.cols}, found ${row.length}`);
        malformed = true;
      }
      checks++;
      if (!/^[.#]*$/.test(row)) {
        errors.push(`${mapKey}.grid[${i}]: contains characters other than '.' and '#'`);
        malformed = true;
      }
    });
    if (malformed) continue; // can't safely flood-fill/BFS a ragged or corrupt grid

    let walkableCount = 0;
    for (const row of grid.grid) for (const ch of row) if (ch === ".") walkableCount++;
    const total = grid.rows * grid.cols;
    const fraction = total > 0 ? walkableCount / total : 0;
    checks++;
    if (fraction === 0) {
      warnings.push(`${mapKey}: walkable fraction is 0% (grid looks unpainted)`);
    } else if (fraction > 0.9) {
      warnings.push(
        `${mapKey}: walkable fraction is ${(fraction * 100).toFixed(0)}% (grid looks over-painted, or is still a placeholder)`,
      );
    }

    const points = pointsByMap.get(mapKey) || [];
    const validCells = [];
    for (const { label, point, radius } of points) {
      checks++;
      const cx = Math.floor(point.x / grid.cell);
      const cy = Math.floor(point.y / grid.cell);
      if (!isWalkableCell(grid, cx, cy)) {
        errors.push(`${label} (${point.x},${point.y}) is not on a walkable cell of '${mapKey}'`);
        continue;
      }
      validCells.push({ label, cx, cy });

      checks++;
      const room = bfsReachableCount(grid, cx, cy, radius);
      if (room < MIN_WANDER_ROOM) {
        errors.push(
          `${label}: only ${room} walkable cell(s) reachable within radius ${radius} on '${mapKey}' — needs ` +
            `at least ${MIN_WANDER_ROOM} (a home in a one-cell closet produces a statue)`,
        );
      }
    }

    checks++;
    const { componentOf, count: componentCount } = floodFillComponents(grid);
    if (componentCount > 1) {
      warnings.push(`${mapKey}: ${componentCount} disconnected walkable region(s) found — check for painting slips (islands)`);
    }
    if (validCells.length > 1) {
      const [first, ...rest] = validCells;
      const firstComp = componentOf.get(`${first.cx},${first.cy}`);
      const stray = rest.filter((v) => componentOf.get(`${v.cx},${v.cy}`) !== firstComp);
      checks++;
      if (stray.length > 0) {
        errors.push(
          `${mapKey}: ${stray.map((v) => v.label).join(", ")} ${stray.length === 1 ? "is" : "are"} not reachable ` +
            `from ${first.label} (disconnected walkable region)`,
        );
      }
    }
  }

  return { errors, warnings, checks };
}

/** Tier 2 — only runs against PNGs actually present in public/assets/. */
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkLocalPngs(assets) {
  const errors = [];
  let checks = 0;
  for (const [key, entry] of Object.entries(assets)) {
    checks++;
    const p = path.join(ASSETS_DIR, entry.file);
    if (!existsSync(p)) {
      errors.push(`MISSING local asset file: public/assets/${entry.file} (key=${key})`);
      continue;
    }
    const actual = pngSize(p);
    if (actual.width !== entry.w || actual.height !== entry.h) {
      errors.push(
        `${key}: assets.json declares ${entry.w}x${entry.h} but public/assets/${entry.file} is ` +
          `actually ${actual.width}x${actual.height}`,
      );
    }
  }
  return { errors, checks };
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced only — which is all
 * these ripped sheets use) so the sprite-content checks below don't need an
 * image library dependency. Returns {width, height, data} with `data` as
 * flat RGBA bytes. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNGs are not supported by this checker");
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let rawOffset = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val = row[x];
      switch (filterType) {
        case 0:
          break;
        case 1:
          val = (val + a) & 0xff;
          break;
        case 2:
          val = (val + b) & 0xff;
          break;
        case 3:
          val = (val + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = (val + pr) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filterType}`);
      }
      cur[x] = val;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      out[di] = cur[si];
      out[di + 1] = cur[si + 1];
      out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

const ALPHA_THRESHOLD = 24;

function alphaAt(png, x, y) {
  return png.data[(y * png.width + x) * 4 + 3];
}

/** Every frame must have real sprite content, and the sprite should not
 * continue past the rect's boundary. A tight bbox always has opaque pixels
 * ON its own edge (that's what makes it tight) — the actual clip signal is
 * opaque pixels just OUTSIDE it, meaning the rect cuts through the sprite
 * instead of fully containing it.
 *
 * This is only a heuristic: several sheets pack adjacent frames just 2-4px
 * apart, so "opaque just outside the rect" can equally mean the *next*
 * frame's own sprite starts right there rather than this one being clipped
 * — the two are visually indistinguishable from pixels alone. So an empty
 * frame is a hard error, but a possible clip is reported as a warning for a
 * human to look at (see the sprite-quality pass report for characters where
 * this was checked and is expected padding, not a real clip). */
function checkFrameContent(errors, warnings, label, png, rect) {
  const [x0, y0, x1, y1] = rect;
  let anyOpaque = false;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (alphaAt(png, x, y) > ALPHA_THRESHOLD) anyOpaque = true;
    }
  }
  if (!anyOpaque) {
    errors.push(`${label}: frame rect [${rect.join(",")}] has no non-transparent pixels`);
    return;
  }

  let clipped = false;
  for (let x = x0; x < x1 && !clipped; x++) {
    if (y0 > 0 && alphaAt(png, x, y0 - 1) > ALPHA_THRESHOLD) clipped = true;
    if (y1 < png.height && alphaAt(png, x, y1) > ALPHA_THRESHOLD) clipped = true;
  }
  for (let y = y0; y < y1 && !clipped; y++) {
    if (x0 > 0 && alphaAt(png, x0 - 1, y) > ALPHA_THRESHOLD) clipped = true;
    if (x1 < png.width && alphaAt(png, x1, y) > ALPHA_THRESHOLD) clipped = true;
  }
  if (clipped) {
    warnings.push(`${label}: sprite content continues past rect edge [${rect.join(",")}] (possibly clipped)`);
  }
}

function frameBytes(png, rect) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = Buffer.alloc(w * h * 4);
  let i = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = (y * png.width + x) * 4;
      out[i++] = png.data[si];
      out[i++] = png.data[si + 1];
      out[i++] = png.data[si + 2];
      out[i++] = png.data[si + 3];
    }
  }
  return out;
}

function animPixelsIdentical(png, framesA, framesB) {
  if (framesA.length !== framesB.length) return false;
  return framesA.every((rect, i) => frameBytes(png, rect).equals(frameBytes(png, framesB[i])));
}

// Sheets this rip is missing genuine back-facing art for — walk_up
// intentionally reuses walk_down's coordinates rather than pointing at
// something wrong. See BACKLOG.md / the sprite-quality pass report. Reads
// characters.json's `lacksBackArt` flag (Phase 4) instead of hard-coding the
// id set a second time, so it can't drift from what src/npc.ts checks.
function knownDuplicateDirectionsFor(characters) {
  const known = {};
  for (const c of characters) {
    if (c.lacksBackArt) known[c.id] = [["walk_down", "walk_up"]];
  }
  return known;
}

// "left" <-> "right" so a character whose data mirrors one direction from
// the other (mirrorDirs) doesn't get flagged for having identical rects —
// that's the point, the flip happens at render time (see src/render.ts's
// drawNpc). "up"/"down" mirroring isn't meaningful (a sideways flip can't
// turn a front pose into a back one), so it's intentionally not handled here.
const OPPOSITE_DIR = { walk_left: "walk_right", walk_right: "walk_left" };

function checkDirectionsDistinct(errors, warnings, id, png, anims, mirrorDirs, knownDuplicateDirections) {
  const dirs = ["walk_down", "walk_left", "walk_right", "walk_up"];
  const known = knownDuplicateDirections[id] || [];
  const mirrored = (mirrorDirs || []).map((d) => `walk_${d}`);
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const a = dirs[i];
      const b = dirs[j];
      if (!animPixelsIdentical(png, anims[a], anims[b])) continue;
      const isKnown = known.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      const isMirror =
        (mirrored.includes(a) && OPPOSITE_DIR[a] === b) ||
        (mirrored.includes(b) && OPPOSITE_DIR[b] === a);
      const msg = `${id}: ${a} and ${b} render identical pixels (not a distinct direction)`;
      if (isMirror) {
        warnings.push(`${msg} — expected, mirrorDirs flips one from the other at render time`);
      } else if (isKnown) {
        warnings.push(`${msg} — known limitation, no back-facing art in this rip`);
      } else {
        errors.push(msg);
      }
    }
  }
}

/** Tier 2 continued — decodes actual sprite-sheet pixels to catch clipped
 * frame rects, empty frames, and directions that silently reuse another
 * direction's art. Only runs against sheets present locally. */
function checkLocalSpriteContent(characters, assets) {
  const errors = [];
  const warnings = [];
  let checks = 0;
  const knownDuplicateDirections = knownDuplicateDirectionsFor(characters);
  const pngCache = new Map();
  function loadSheet(key) {
    if (pngCache.has(key)) return pngCache.get(key);
    const entry = assets[key];
    const p = entry && path.join(ASSETS_DIR, entry.file);
    let png = null;
    if (p && existsSync(p)) {
      try {
        png = decodePng(readFileSync(p));
      } catch (e) {
        errors.push(`${key}: failed to decode public/assets/${entry.file} (${e.message})`);
      }
    }
    pngCache.set(key, png);
    return png;
  }

  for (const c of characters) {
    const sheetPng = loadSheet(c.sheet);
    if (sheetPng) {
      for (const [animName, frames] of Object.entries(c.anims)) {
        frames.forEach((rect, i) => {
          checks++;
          checkFrameContent(errors, warnings, `${c.id}.${animName}[${i}]`, sheetPng, rect);
        });
      }
      checks++;
      checkFrameContent(errors, warnings, `${c.id}.idle`, sheetPng, c.idle);
      checks++;
      checkDirectionsDistinct(errors, warnings, c.id, sheetPng, c.anims, c.mirrorDirs, knownDuplicateDirections);
    }

    const battlePng = loadSheet(c.battleSheet);
    if (battlePng) {
      (c.specials || []).forEach((rect, i) => {
        checks++;
        checkFrameContent(errors, warnings, `${c.id}.specials[${i}]`, battlePng, rect);
      });
    }
  }
  return { errors, warnings, checks };
}

async function main() {
  const characters = await loadJson("characters.json");
  const districts = await loadJson("districts.json");
  const village = await loadJson("village.json");
  const assets = await loadJson("assets.json");
  const npcRigs = await loadJson("npcRigs.json");
  const walkability = await loadJson("walkability.json");

  const dataOnly = checkDataOnly({ characters, districts, village, assets });
  console.log(
    `[data] Checked ${dataOnly.checks} assertions across ${districts.length} districts, ` +
      `${characters.length} characters, and ${Object.keys(assets).length} asset entries.`,
  );

  const rigs = checkNpcRigs(npcRigs, assets);
  console.log(
    `[data] Checked ${rigs.checks} assertion(s) across ${Object.keys(npcRigs).length} resident NPC rig(s).`,
  );

  const walk = checkWalkability({ districts, village, assets, walkability });
  console.log(
    `[data] Checked ${walk.checks} walkability assertion(s) across ${Object.keys(walkability).length} map(s).`,
  );
  walk.warnings.forEach((w) => console.log(`  ! ${w}`));

  await syncAssets().catch(() => {});
  const hasLocalAssets = existsSync(ASSETS_DIR) && readdirSync(ASSETS_DIR).length > 0;

  let local = { errors: [], checks: 0 };
  let content = { errors: [], warnings: [], checks: 0 };
  if (hasLocalAssets) {
    local = checkLocalPngs(assets);
    console.log(
      `[local] Checked ${local.checks} PNG file(s) in public/assets/ against assets.json.`,
    );
    content = checkLocalSpriteContent(characters, assets);
    console.log(
      `[local] Checked ${content.checks} sprite-frame assertion(s) (alpha content, edge clipping, ` +
        `direction distinctness) against decoded PNG pixels.`,
    );
    content.warnings.forEach((w) => console.log(`  ! ${w}`));
  } else {
    console.log(
      "[local] No PNGs found in public/assets/ — skipping local PNG size/content checks (this is fine in CI).",
    );
  }

  const errors = [...dataOnly.errors, ...rigs.errors, ...walk.errors, ...local.errors, ...content.errors];
  if (errors.length) {
    console.error(`\nFAILED (${errors.length} problem(s)):`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  } else {
    console.log("All data checks passed" + (hasLocalAssets ? " (including local PNGs)." : "."));
  }
}

await main();
