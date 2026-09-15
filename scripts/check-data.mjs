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
  if (hasLocalAssets) {
    local = checkLocalPngs(assets);
    console.log(
      `[local] Checked ${local.checks} PNG file(s) in public/assets/ against assets.json.`,
    );
  } else {
    console.log(
      "[local] No PNGs found in public/assets/ — skipping local PNG size check (this is fine in CI).",
    );
  }

  const errors = [...dataOnly.errors, ...local.errors];
  if (errors.length) {
    console.error(`\nFAILED (${errors.length} problem(s)):`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  } else {
    console.log("All data checks passed" + (hasLocalAssets ? " (including local PNGs)." : "."));
  }
}

await main();
