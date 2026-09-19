// Phase 10: "Talk to the Hokage" (SPEC.md — "Chat UI + Gemini function
// calling with tools get_top_artists/get_recent_plays/get_slot_history/
// get_weekly_brief/find_artist; daily chat limit. Camera pans to the
// district a tool call is about."). POST /api/hokage — the Worker's first
// POST route.
//
// This file owns everything specific to the Hokage: the fixed in-character
// system prompt, the tool declarations Gemini sees, and the tool
// implementations themselves (read-only D1 queries only — no live Spotify
// call this route can ever trigger, and no data leaves this file that isn't
// already trimmed to display-sized fields). worker/gemini.ts's
// chatWithTools owns the actual Gemini request/response/tool-call loop
// mechanics and stays the only file that calls Gemini — same division of
// labor as every other Gemini-backed feature in this Worker.
//
// Caching exception: unlike every other LLM output in this app (SPEC.md's
// "all LLM outputs cached"), a Hokage reply is never cached. It's answering
// a question a visitor just typed, not something loaded with the page — two
// visitors asking "what have I been listening to" a minute apart could get
// different answers anyway (new plays landing in between), and there's
// nothing to key a cache on besides the full conversation itself. This is
// the one accepted exception to that rule.
//
// Cost control (SPEC.md's "AI cost control" + this phase's task):
//  - Gemini quota: worker/rate-limit.ts's "chat" GeminiCallKind — non-core
//    (backs off from the shared reserve like brief/persona), its own global
//    80-steps/day sub-cap, and exempt from the shared per-IP Gemini cap
//    (see that file's doc comment for why — one chatty visitor shouldn't be
//    able to starve every other Gemini feature for their own IP). Checked
//    per model step inside worker/gemini.ts's chatWithTools.
//  - Question cap: a *separate* concern from the Gemini quota above — how
//    many times one IP may hit this endpoint per day, win or lose. Recorded
//    as its own usage_log endpoint ('hokage:question', QUESTION_DAILY_CAP =
//    10/IP/day) and enforced right here in the handler, not via
//    worker/rate-limit.ts's generic enforceRateLimit()/RATE_LIMIT_RULES
//    bucket — that mechanism deliberately *fails open* on a D1 hiccup
//    (worker/index.ts's fetch(), "rate limiting itself is abuse protection,
//    not core functionality"), which is the wrong failure direction for a
//    cap whose whole job is bounding Gemini cost. The 'hokage' RATE_LIMIT_RULES
//    entry still exists alongside this (burst protection within a minute);
//    this handler's own check is the hard daily ceiling.
//  - Over *any* cap (the question cap here, or the Gemini quota inside
//    chatWithTools), the response is still HTTP 200 with an in-character
//    canned reply and `limited: true` — never an error status, so the chat
//    UI always has something to show.

import type { Env } from "./index";
import { chatWithTools, type ChatMessage, type ChatToolDef } from "./gemini";
import { clientIp, startOfUtcDayIso } from "./rate-limit";
import { loadLatestReadyBrief } from "./weekly-brief";
import { SLOTS } from "../data/loader";

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.district.id, s]));
const DAY_MS = 24 * 60 * 60 * 1000;

function slotGenre(slotId: string): string | null {
  return SLOT_BY_ID.get(slotId)?.district.genre ?? null;
}

// ---------------------------------------------------------------------------
// Request validation — {messages: [{role, text}]}, at most MAX_MESSAGES
// entries, each text at most MAX_TEXT_CHARS, last one always the visitor's
// own turn. Anything else is a 400, not a best-effort coercion — this is a
// user-typed POST body, not a trusted internal payload.
// ---------------------------------------------------------------------------
const MAX_BODY_BYTES = 8 * 1024;
const MAX_MESSAGES = 8;
const MAX_TEXT_CHARS = 500;

/** Reads the request body capped at MAX_BODY_BYTES, checked both via
 * Content-Length (cheap, but absent/spoofable) and the actual decoded byte
 * length (the real guard) — `null` means "too large or unreadable", which
 * the caller turns into a 400 without ever handing the text to JSON.parse. */
async function readCappedBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  return text;
}

/** `null` for anything malformed — the caller turns that into a 400. Every
 * field is checked explicitly rather than defaulted, same philosophy as
 * worker/gemini.ts's generateJson response parsing: a bad shape here should
 * be an obvious 400, not a silently-coerced request sent on to Gemini. */
function parseMessages(bodyText: string): ChatMessage[] | null {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rawMessages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) return null;

  const messages: ChatMessage[] = [];
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const text = (m as { text?: unknown }).text;
    if (role !== "user" && role !== "model") return null;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_TEXT_CHARS) return null;
    messages.push({ role, text });
  }
  if (messages[messages.length - 1]!.role !== "user") return null; // must end on the visitor's own turn
  return messages;
}

// ---------------------------------------------------------------------------
// Question cap — see this file's top doc comment for why this is enforced
// here rather than via worker/rate-limit.ts's generic per-minute buckets.
// ---------------------------------------------------------------------------
const QUESTION_DAILY_CAP = 10;
const CANNED_DAILY_LIMIT_REPLY =
  "The Hokage has already answered plenty of questions today and needs to rest. Come back tomorrow for more.";

async function questionsAskedToday(env: Env, ip: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_log WHERE endpoint = 'hokage:question' AND ip = ? AND created_at >= ?")
    .bind(ip, startOfUtcDayIso())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function logQuestion(env: Env, ip: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO usage_log (endpoint, status, retry_429_count, created_at, ip) VALUES ('hokage:question', 200, 0, ?, ?)")
      .bind(new Date().toISOString(), ip)
      .run();
  } catch {
    // Logging must never break the actual request — same convention as
    // worker/rate-limit.ts's logGeminiCall.
  }
}

// ---------------------------------------------------------------------------
// System prompt — fixed, in character. Never invents data: every fact it
// states about the owner's listening has to come from a tool call, never
// from the model's own guess.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  'You are the Hokage: the wise, dryly warm leader of a pixel-art ninja village where every music genre the owner listens to on Spotify is one of the village\'s districts, each led by a character from the show.',
  'Speak IN CHARACTER, always in terms of "the village" and its districts — never say "Spotify", "app", "database", "API", or anything that breaks the illusion.',
  "A visitor is asking you about the owner's real listening. You have no knowledge of it except what your tools tell you — call a tool whenever a question needs a fact you don't already have from this conversation, and NEVER invent an artist, song, number, or trend a tool hasn't actually given you. If a tool comes back empty or the question is about something outside what your tools can see, say so plainly instead of guessing.",
  "The village's records begin 2026-09-18 — nothing is known from before that date; say so if a question reaches further back.",
  "Keep answers SHORT: two or three sentences, like a busy leader giving a visitor a quick word between duties.",
].join("\n");

// ---------------------------------------------------------------------------
// Tools — every one a read-only D1 query, no live Spotify call. Each
// implementation returns only trimmed, derived fields (names, genres, play
// counts, dates) for the functionResponse Gemini sees, plus (separately)
// which district it's "about" — worker/hokage.ts's own handler collects
// these into the response's focusSlots, which the frontend uses to pan the
// camera; Gemini itself never sees or needs a raw slot id.
// ---------------------------------------------------------------------------
interface ToolResult {
  data: unknown;
  /** The one district this call is most "about", for focusSlots — null when
   * the call found nothing, or found something with no single district to
   * point at. */
  slotId: string | null;
}

function numArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = args[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function strArg(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/** get_top_artists(days): same play_event x artist_cache GROUP BY shape as
 * worker/history-query.ts's slotPlaysBetween, aggregated per artist instead
 * of per slot — `days` is a plain lookback window (not a Spotify-style
 * range enum), since this is a D1 read over play_event, not a Spotify call. */
async function toolGetTopArtists(env: Env, args: Record<string, unknown>): Promise<ToolResult> {
  const days = numArg(args, "days", 30, 1, 3650);
  const fromMs = Date.now() - days * DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT ac.name AS name, ac.slot_id AS slot_id, COUNT(*) AS plays
     FROM play_event pe
     JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
     WHERE pe.played_at >= ?
     GROUP BY pe.primary_artist_id
     ORDER BY plays DESC
     LIMIT 10`,
  )
    .bind(fromMs)
    .all<{ name: string; slot_id: string | null; plays: number }>();

  const artists = results.map((r) => ({ name: r.name, genre: r.slot_id ? slotGenre(r.slot_id) : null, plays: r.plays }));
  return { data: { days, artists }, slotId: results[0]?.slot_id ?? null };
}

/** get_recent_plays(limit <= 20): most recent plays first, joined to
 * track_cache/artist_cache for display names (never a raw play_event row —
 * see this file's top doc comment on trimmed fields). */
async function toolGetRecentPlays(env: Env, args: Record<string, unknown>): Promise<ToolResult> {
  const limit = numArg(args, "limit", 10, 1, 20);
  const { results } = await env.DB.prepare(
    `SELECT pe.played_at AS played_at, tc.name AS track_name, ac.name AS artist_name, ac.slot_id AS slot_id
     FROM play_event pe
     LEFT JOIN track_cache tc ON tc.track_id = pe.track_id
     LEFT JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
     ORDER BY pe.played_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ played_at: number; track_name: string | null; artist_name: string | null; slot_id: string | null }>();

  const plays = results.map((r) => ({
    track: r.track_name ?? "an unknown track",
    artist: r.artist_name ?? "an unknown artist",
    playedAt: new Date(r.played_at).toISOString(),
  }));
  return { data: { plays }, slotId: results[0]?.slot_id ?? null };
}

// A play right at the fetch window's edge can still land in-window once
// bucketed to the owner's timezone — same margin/reasoning as
// worker/history-daily.ts's FETCH_SAFETY_MARGIN_DAYS.
const SLOT_HISTORY_MARGIN_DAYS = 2;

/** get_slot_history(slot, days): per-day play counts for one of the 17
 * roster slots — reuses worker/history-daily.ts's own technique (a
 * generously padded window of raw play_event rows, bucketed to the owner's
 * own calendar day in JS via Intl.DateTimeFormat, rather than exact SQL
 * midnight math), scoped to one slot and an arbitrary day count instead of
 * that route's fixed "every slot, last 30 days". */
async function toolGetSlotHistory(env: Env, args: Record<string, unknown>): Promise<ToolResult> {
  const slotId = strArg(args, "slot");
  if (!SLOT_IDS.includes(slotId)) {
    return { data: { error: `"${slotId}" isn't one of the village's districts.` }, slotId: null };
  }
  const days = numArg(args, "days", 7, 1, 60);

  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: env.OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const now = Date.now();
  const dayStrings: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayStrings.push(dayFmt.format(new Date(now - i * DAY_MS)));
  const dayIndex = new Map(dayStrings.map((d, i) => [d, i]));

  const fromMs = now - (days + SLOT_HISTORY_MARGIN_DAYS) * DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT pe.played_at AS played_at
     FROM play_event pe
     JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
     WHERE ac.slot_id = ? AND pe.played_at >= ?`,
  )
    .bind(slotId, fromMs)
    .all<{ played_at: number }>();

  const counts = new Array(days).fill(0) as number[];
  for (const row of results) {
    const idx = dayIndex.get(dayFmt.format(new Date(row.played_at)));
    if (idx !== undefined) counts[idx]!++;
  }

  return {
    data: { slot: slotId, genre: slotGenre(slotId), days: dayStrings.map((day, i) => ({ day, plays: counts[i] })) },
    slotId,
  };
}

/** get_weekly_brief(): the latest ready weekly_brief row (Phase 9), reusing
 * worker/weekly-brief.ts's own loadLatestReadyBrief so the names-joined-at-
 * read-time rule (see that file's doc comment) isn't duplicated here. Points
 * focusSlots at this week's single biggest mover, if there is one. */
async function toolGetWeeklyBrief(env: Env): Promise<ToolResult> {
  const brief = await loadLatestReadyBrief(env);
  if (!brief) return { data: { message: "No weekly notice-board post exists yet." }, slotId: null };

  const topMover = [...brief.movers].sort(
    (a, b) => Math.abs(b.playsThisWeek - b.playsLastWeek) - Math.abs(a.playsThisWeek - a.playsLastWeek),
  )[0];

  return {
    data: {
      weekStart: brief.weekStart,
      headline: brief.headline,
      notes: brief.notes,
      movers: brief.movers.map((m) => ({ genre: slotGenre(m.slotId), playsThisWeek: m.playsThisWeek, playsLastWeek: m.playsLastWeek })),
      newArtists: brief.topNewArtists.map((a) => ({ name: a.name, genre: a.slotId ? slotGenre(a.slotId) : null, plays: a.plays })),
    },
    slotId: topMover?.slotId ?? null,
  };
}

/** find_artist(name): fuzzy match over artist_cache. A case-insensitive
 * substring LIKE, ranked by shortest-name-first as a cheap relevance
 * heuristic — not a real fuzzy-distance/FTS search, but this app's whole
 * artist_cache is one personal account's history, easily small enough for a
 * LIKE scan (same "D1 is fine at this scale" tradeoff as
 * worker/rate-limit.ts's own D1-vs-Cache-API doc comment). */
async function toolFindArtist(env: Env, args: Record<string, unknown>): Promise<ToolResult> {
  const query = strArg(args, "name");
  if (!query) return { data: { error: "No artist name given." }, slotId: null };

  const { results } = await env.DB.prepare(`SELECT artist_id, name, slot_id FROM artist_cache WHERE LOWER(name) LIKE ? ORDER BY LENGTH(name) ASC LIMIT 5`)
    .bind(`%${query.toLowerCase()}%`)
    .all<{ artist_id: string; name: string; slot_id: string | null }>();

  if (results.length === 0) {
    return { data: { message: `No artist matching "${query}" was found in the owner's listening history.` }, slotId: null };
  }

  const best = results[0]!;
  const statsRow = await env.DB.prepare(`SELECT COUNT(*) AS plays, MAX(played_at) AS last_played FROM play_event WHERE primary_artist_id = ?`)
    .bind(best.artist_id)
    .first<{ plays: number; last_played: number | null }>();

  return {
    data: {
      name: best.name,
      genre: best.slot_id ? slotGenre(best.slot_id) : null,
      plays: statsRow?.plays ?? 0,
      lastPlayed: statsRow?.last_played ? new Date(statsRow.last_played).toISOString() : null,
      otherMatches: results.slice(1).map((r) => r.name),
    },
    slotId: best.slot_id,
  };
}

const TOOL_DEFS: ChatToolDef[] = [
  {
    name: "get_top_artists",
    description: "The owner's most-played artists over the last N days, each with their district (genre) and play count.",
    parameters: {
      type: "OBJECT",
      properties: { days: { type: "NUMBER", description: "How many days back to look, e.g. 7 for this week, 30 for this month." } },
      required: ["days"],
    },
  },
  {
    name: "get_recent_plays",
    description: "The owner's most recently played tracks, most recent first.",
    parameters: {
      type: "OBJECT",
      properties: { limit: { type: "NUMBER", description: "How many recent plays to return, up to 20." } },
      required: ["limit"],
    },
  },
  {
    name: "get_slot_history",
    description: "Per-day play counts for one specific village district over the last N days.",
    parameters: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS, description: "The district's id." },
        days: { type: "NUMBER", description: "How many days back, e.g. 7 or 30." },
      },
      required: ["slot", "days"],
    },
  },
  {
    name: "get_weekly_brief",
    description: "The village's latest weekly notice-board post: this week's biggest movers and any brand-new artists.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "find_artist",
    description: "Look up one specific artist by name: their district, total plays, and when they were last played.",
    parameters: {
      type: "OBJECT",
      properties: { name: { type: "STRING", description: "The artist's name, as best you can spell it." } },
      required: ["name"],
    },
  },
];

const TOOL_IMPLS: Record<string, (env: Env, args: Record<string, unknown>) => Promise<ToolResult>> = {
  get_top_artists: toolGetTopArtists,
  get_recent_plays: toolGetRecentPlays,
  get_slot_history: toolGetSlotHistory,
  get_weekly_brief: (env) => toolGetWeeklyBrief(env),
  find_artist: toolFindArtist,
};

function dedupeFocusSlots(slots: string[]): string[] {
  return Array.from(new Set(slots));
}

// ---------------------------------------------------------------------------
// Response — never cached (see this file's top doc comment).
// ---------------------------------------------------------------------------
interface HokageResponsePayload {
  reply: string;
  focusSlots: string[];
  remaining: number;
  limited?: boolean;
}

function jsonReply(reply: string, focusSlots: string[], remaining: number, limited: boolean): Response {
  const body: HokageResponsePayload = { reply, focusSlots, remaining };
  if (limited) body.limited = true;
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function handleHokage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const bodyText = await readCappedBody(request);
  if (bodyText === null) return Response.json({ error: "Request body too large" }, { status: 400 });

  const messages = parseMessages(bodyText);
  if (!messages) return Response.json({ error: "Malformed request" }, { status: 400 });

  const ip = clientIp(request);
  const askedToday = await questionsAskedToday(env, ip);
  if (askedToday >= QUESTION_DAILY_CAP) {
    return jsonReply(CANNED_DAILY_LIMIT_REPLY, [], 0, true);
  }

  const focusSlots: string[] = [];
  const runTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const impl = TOOL_IMPLS[name];
    if (!impl) return { error: `Unknown tool "${name}".` };
    const result = await impl(env, args);
    if (result.slotId) focusSlots.push(result.slotId);
    return result.data;
  };

  const outcome = await chatWithTools(env, ip, SYSTEM_PROMPT, messages, TOOL_DEFS, runTool);
  await logQuestion(env, ip);
  const remaining = Math.max(0, QUESTION_DAILY_CAP - askedToday - 1);

  return jsonReply(outcome.reply, dedupeFocusSlots(focusSlots), remaining, outcome.limited);
}
