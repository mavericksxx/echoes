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

  // Every district's bg resolves, and every patrol/home waypoint falls within it.
  for (const def of districts) {
    const bgSize = assetSize(def.bg, `${def.id}.bg`);
    const points = [...def.patrol, def.home];
    points.forEach((p, i) => {
      checks++;
      if (!bgSize) return;
      const [w, h] = bgSize;
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) {
        errors.push(
          `${def.id}: waypoint[${i}] (${p.x},${p.y}) is outside its ${w}x${h} background '${def.bg}'`,
        );
      }
    });
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

  return { errors, checks };
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
// something wrong. See BACKLOG.md / the sprite-quality pass report.
const KNOWN_DUPLICATE_DIRECTIONS = {
  naruto: [["walk_down", "walk_up"]],
  kankuro: [["walk_down", "walk_up"]],
  neji: [["walk_down", "walk_up"]],
  tenten: [["walk_down", "walk_up"]],
};

function checkDirectionsDistinct(errors, warnings, id, png, anims) {
  const dirs = ["walk_down", "walk_left", "walk_right", "walk_up"];
  const known = KNOWN_DUPLICATE_DIRECTIONS[id] || [];
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const a = dirs[i];
      const b = dirs[j];
      if (!animPixelsIdentical(png, anims[a], anims[b])) continue;
      const isKnown = known.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      const msg = `${id}: ${a} and ${b} render identical pixels (not a distinct direction)`;
      if (isKnown) {
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
      checkDirectionsDistinct(errors, warnings, c.id, sheetPng, c.anims);
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

  const dataOnly = checkDataOnly({ characters, districts, village, assets });
  console.log(
    `[data] Checked ${dataOnly.checks} assertions across ${districts.length} districts, ` +
      `${characters.length} characters, and ${Object.keys(assets).length} asset entries.`,
  );

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

  const errors = [...dataOnly.errors, ...local.errors, ...content.errors];
  if (errors.length) {
    console.error(`\nFAILED (${errors.length} problem(s)):`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  } else {
    console.log("All data checks passed" + (hasLocalAssets ? " (including local PNGs)." : "."));
  }
}

await main();
