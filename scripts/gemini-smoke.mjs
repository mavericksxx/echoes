#!/usr/bin/env node
// Standalone smoke test for the Gemini REST call worker/gemini.ts makes —
// run this locally (never automatically, never in CI) after touching the
// prompt/schema/model to confirm Gemini still accepts the current request
// shape, without needing a full wrangler deploy to find out. Mirrors
// classifyArtistNames's request/response handling exactly (same model,
// endpoint, schema, prompt, and response-shape checks) but as a plain Node
// script — like scripts/spotify-connect.mjs — rather than importing the
// Worker TS directly. Reads the 17 slots from data/districts.json (the same
// source of truth worker/gemini.ts reads via data/loader.ts) so the two
// never drift apart.
//
// Usage:
//   GEMINI_API_KEY=... node scripts/gemini-smoke.mjs
//
// (This script makes a real, billable-to-free-tier Gemini call. Not run as
// part of `npm run typecheck`/`build`/`check:data`, and not run by the
// agent that wrote it — only by a human, on purpose.)
"use strict";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const MODEL_ID = "gemini-3.5-flash-lite";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

// The same 3 artists the production bug report used (Kanye West -> Pop,
// Metallica -> Classical, Martin Garrix -> Hip-Hop via the hash fallback),
// so a passing run here directly confirms those specific mappings are sane.
const TEST_ARTISTS = ["Kanye West", "Metallica", "Martin Garrix"];

async function loadSlots() {
  const raw = await readFile(path.join(ROOT, "data", "districts.json"), "utf8");
  const districts = JSON.parse(raw);
  return districts.map((d) => ({ id: d.id, genre: d.genre }));
}

function resultSchema(slotIds) {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        artist: { type: "STRING" },
        slot: { type: "STRING", enum: slotIds },
        confidence: {
          type: "NUMBER",
          description: "0..1 — how confident this mapping is. Use a value below 0.4 for a guess.",
        },
      },
      required: ["artist", "slot", "confidence"],
    },
  };
}

function buildPrompt(slots, names) {
  const slotLines = slots.map((s) => `- "${s.id}": ${s.genre}`).join("\n");
  return [
    "You are placing musical artists into a fixed set of 17 genre buckets, using only their name — no other data is available.",
    "Buckets (id: representative genre):",
    slotLines,
    "",
    "For each artist name below, infer their most likely genre from general knowledge and pick the single closest bucket id.",
    "If you don't recognize the artist, pick your best guess anyway and give it a low confidence (below 0.4).",
    'Respond with a JSON array with one object per artist name, each with exactly the fields "artist" (the input name, unchanged), "slot" (one of the bucket ids above), and "confidence" (0..1).',
    "Artist names (JSON array):",
    JSON.stringify(names),
  ].join("\n");
}

function failWithBody(message, rawBodyOrObj) {
  console.error(`FAILED — ${message}`);
  console.error(
    "Raw response body:\n",
    typeof rawBodyOrObj === "string" ? rawBodyOrObj : JSON.stringify(rawBodyOrObj, null, 2),
  );
  process.exitCode = 1;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Set GEMINI_API_KEY in the environment first (the same value stored as the Worker secret):");
    console.error("  GEMINI_API_KEY=... node scripts/gemini-smoke.mjs");
    process.exitCode = 1;
    return;
  }

  const slots = await loadSlots();
  if (slots.length !== 17) {
    console.error(`Warning: expected 17 slots from data/districts.json, got ${slots.length}.`);
  }

  const prompt = buildPrompt(slots, TEST_ARTISTS);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: resultSchema(slots.map((s) => s.id)),
    },
  };

  console.log(`Model: ${MODEL_ID}`);
  console.log(`POST ${API_URL}`);
  console.log(`Classifying: ${TEST_ARTISTS.join(", ")}\n`);

  let res;
  try {
    res = await fetch(`${API_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("FAILED — network error calling Gemini:", err.message);
    process.exitCode = 1;
    return;
  }

  const rawBody = await res.text();

  if (!res.ok) {
    failWithBody(`HTTP ${res.status} ${res.statusText}`, rawBody);
    return;
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    failWithBody(`response was not valid JSON (${err.message})`, rawBody);
    return;
  }

  if (data.promptFeedback?.blockReason) {
    failWithBody(`prompt was blocked (${data.promptFeedback.blockReason})`, data);
    return;
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    failWithBody("no candidates in the response", data);
    return;
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    failWithBody(`finishReason was "${candidate.finishReason}", not STOP`, data);
    return;
  }

  const parts = candidate.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text ?? "").join("") : "";
  if (!text) {
    failWithBody("no text content in the response", data);
    return;
  }

  console.log("Raw text from Gemini:\n", text, "\n");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("FAILED — Gemini's text was not valid JSON:", err.message);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(parsed) || parsed.length !== TEST_ARTISTS.length) {
    console.error(`FAILED — expected an array of ${TEST_ARTISTS.length} objects, got:`, parsed);
    process.exitCode = 1;
    return;
  }

  console.log("Parsed classifications:");
  for (const row of parsed) {
    console.log(`  ${row.artist} -> ${row.slot} (confidence ${row.confidence})`);
  }
  console.log("\nPASSED — Gemini accepted the request and returned a usable classification.");
}

main().catch((err) => {
  console.error("\ngemini-smoke failed unexpectedly:", err);
  process.exitCode = 1;
});
