#!/usr/bin/env node
// Copies the ripped Naruto PNGs from a local, gitignored source folder into
// public/assets/ so Vite can serve them. The PNGs themselves are copyrighted
// rips and are never committed — see .gitignore and README.md.
//
// Source folder: $ASSETS_SRC, defaulting to the sibling prototype's assets/
// folder used while building this app.
//
// Usage: npm run assets:sync
"use strict";

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_SRC =
  "/Users/maverick/Developer/spotify-pixel-town/prototypes/konoha-demo/assets";
const SRC = process.env.ASSETS_SRC || DEFAULT_SRC;
const DEST = path.join(ROOT, "public", "assets");

export async function syncAssets() {
  if (!existsSync(SRC)) {
    console.error(`ASSETS_SRC not found: ${SRC}`);
    console.error(
      "Set ASSETS_SRC to the folder containing the ripped Naruto PNGs, or place them at the default path above.",
    );
    process.exitCode = 1;
    return { copied: 0, missing: [] };
  }

  mkdirSync(DEST, { recursive: true });

  const manifestPath = path.join(ROOT, "data", "assets.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const wantedFiles = Object.values(manifest);

  const available = new Set(readdirSync(SRC));
  const missing = [];
  let copied = 0;

  for (const filename of wantedFiles) {
    if (!available.has(filename)) {
      missing.push(filename);
      continue;
    }
    copyFileSync(path.join(SRC, filename), path.join(DEST, filename));
    copied++;
  }

  console.log(`Synced ${copied}/${wantedFiles.length} asset(s) from ${SRC} to ${DEST}`);
  if (missing.length) {
    console.warn(`Missing from source (not copied): ${missing.join(", ")}`);
  }
  return { copied, missing };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { missing } = await syncAssets();
  if (missing.length) process.exitCode = 1;
}
