// Phase 9: the weekly notice board (SPEC.md's "Snapshot diff → Gemini
// weekly brief (1/week, cached) → in-world notice board UI"). Generation
// rides the existing 15-min cron (worker/index.ts's scheduled(), right after
// worker/history.ts's runHistorySync) — no new cron trigger. GET
// /api/weekly-brief (also this file) just reads whatever's already in
// `weekly_brief` (migrations/0009_weekly_brief.sql).
//
// "Last complete week" is a Monday-Sunday owner-local week (wrangler.jsonc's
// OWNER_TZ var) that has already fully ended — never the in-progress one.
// Like worker/history-daily.ts, this deliberately avoids expressing
// "owner-local midnight" as a precise epoch-ms SQL boundary: instead, a
// generously padded window of raw play_event rows is fetched once and every
// row is bucketed by its own owner-local calendar-day string (Intl-derived),
// compared against the target week's known day strings. Simpler than exact
// timezone-offset math, and correct to the day, which is all a weekly digest
// needs.
//
// Generation is gated so it fires at most once per week, with a bounded
// retry on failure — see runWeeklyBrief's doc comment below for the exact
// rule. The prompt sent to Gemini carries only derived counts, slot genres,
// and artist names (SPEC.md's AI policy) — never a raw Spotify payload, and
// the persisted `stats` JSON stores artist ids + counts only, never names
// (see migrations/0009_weekly_brief.sql's doc comment) — names are always
// joined fresh from artist_cache, both when building the Gemini prompt here
// and when serving GET /api/weekly-brief.

import type { Env } from "./index";
import { generateJson } from "./gemini";
import { geminiQuotaAvailable, logGeminiCall } from "./rate-limit";
import { SLOTS } from "../data/loader";

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.district.id, s]));

const DAY_MS = 24 * 60 * 60 * 1000;
// Raw play_event rows are fetched back this many days from "now" (plus the
// margin below) — enough to cover the in-progress week, the last complete
// week, and the week before that (needed for the diff), however the cron
// happens to land within the current week.
const WINDOW_DAYS_BACK = 21;
// Same role as worker/history-daily.ts's FETCH_SAFETY_MARGIN_DAYS: a play
// right at the fetch window's edge can still land in-window once bucketed to
// the owner's timezone (which may be hours ahead/behind this Worker's own
// clock).
const FETCH_SAFETY_MARGIN_DAYS = 2;

// Below this many raw plays in the target week, a real narrated brief would
// be reading tea leaves out of a handful of plays — SPEC.md's "if the week
// has too little data ... store a stats-only row with a template headline
// and no Gemini call". Counts every play in the window, classified or not,
// same convention as worker/wrapped.ts's MIN_HISTORY_PLAYS.
const MIN_WEEK_PLAYS = 20;

// A failed/quota-capped Gemini attempt is retried on a later cron tick, but
// never sooner than this — SPEC.md's "retry ... but at most every few
// hours". A week that resolves via the low-data template path above is never
// retried at all (see runWeeklyBriefInner): more data can't retroactively
// appear once the cron has already looked at a fully-elapsed week.
const RETRY_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// A brief for "the latest complete week" is only actually safe to compute
// once owner-local Monday has been underway a little while — right at
// Monday 00:00, the cron would already consider Sunday's week "complete"
// even though worker/history.ts's own 15-min cron may not have synced
// Sunday's last plays yet. Skipping the first BRIEF_GRACE_HOURS of Monday
// gives history a few cron ticks to catch up before the week's numbers are
// computed.
const BRIEF_GRACE_HOURS = 6;

const MAX_NEW_ARTISTS = 5;
const MAX_HEADLINE_CHARS = 160;
const MAX_NOTE_CHARS = 120;
const MAX_NOTES = 4;
const MAX_SLOT_NOTE_CHARS = 120;

const CACHE_TTL_SECONDS = 30 * 60; // same convention as village.ts/wrapped.ts/playlists.ts

const TEMPLATE_HEADLINE = "Not enough listening logged this week to say much yet — check back after a fuller week.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Owner-local week math (see this file's doc comment on why this buckets by
// formatted day string instead of computing exact epoch boundaries).
// ---------------------------------------------------------------------------

/** The 7 owner-local day strings ("YYYY-MM-DD") for the Monday-Sunday week
 * `weeksAgo` weeks before the current (possibly in-progress) one — 0 is this
 * week, 1 is the last *complete* week, 2 is the week before that.
 *
 * Pure calendar arithmetic on `dayFmt`'s formatted date parts, not epoch-ms
 * subtraction — `nowMs - N*DAY_MS` can land on the wrong owner-local
 * calendar day across a DST transition (a 23h or 25h owner-local day means
 * "7 days ago" isn't always exactly 7*86400000 ms ago). Rebuilding "today"
 * as a UTC-anchored date (Date.UTC on the *parts*, not the instant) and
 * stepping by whole days from there sidesteps the DST question entirely —
 * every step is a clean calendar day, never a fractional one. */
function weekDayStrings(dayFmt: Intl.DateTimeFormat, nowMs: number, weeksAgo: number): string[] {
  const [y, m, d] = dayFmt.format(new Date(nowMs)).split("-").map(Number);
  const todayUtc = Date.UTC(y!, m! - 1, d!);
  const daysSinceMonday = (new Date(todayUtc).getUTCDay() + 6) % 7;
  const monday = todayUtc - (daysSinceMonday + weeksAgo * 7) * DAY_MS;
  return Array.from({ length: 7 }, (_, i) => new Date(monday + i * DAY_MS).toISOString().slice(0, 10));
}

// ---------------------------------------------------------------------------
// Snapshot diff — play_event joined to artist_cache for the target week vs
// the week before it, plus this week's brand-new (never-played-before)
// artists.
// ---------------------------------------------------------------------------
interface RawPlayRow {
  played_at: number;
  artist_id: string;
  slot_id: string | null;
  name: string | null;
}

export interface WeeklyBriefMoverStat {
  slotId: string;
  playsThisWeek: number;
  playsLastWeek: number;
}

interface NewArtistCandidate {
  artistId: string;
  name: string;
  slotId: string | null;
  plays: number;
}

interface SnapshotDiff {
  totalPlaysThisWeek: number;
  movers: WeeklyBriefMoverStat[];
  newArtists: NewArtistCandidate[];
}

async function computeSnapshotDiff(
  env: Env,
  dayFmt: Intl.DateTimeFormat,
  targetWeekDays: string[],
  priorWeekDays: string[],
  nowMs: number,
): Promise<SnapshotDiff> {
  const fromMs = nowMs - (WINDOW_DAYS_BACK + FETCH_SAFETY_MARGIN_DAYS) * DAY_MS;
  const [{ results: rows }, { results: firstPlayedRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT pe.played_at AS played_at, pe.primary_artist_id AS artist_id, ac.slot_id AS slot_id, ac.name AS name
       FROM play_event pe
       LEFT JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
       WHERE pe.played_at >= ?`,
    )
      .bind(fromMs)
      .all<RawPlayRow>(),
    // Whole-table (no time filter): the only reliable way to know an
    // artist's true first-ever play, needed below to tell "new this week"
    // from "just quiet for a while" — this Worker's play_event scale is a
    // single personal account's history, not a high-QPS table, so a full
    // GROUP BY here is cheap (same comfort level as worker/rate-limit.ts's
    // own D1-over-Cache-API tradeoff).
    env.DB.prepare(`SELECT primary_artist_id AS artist_id, MIN(played_at) AS first_played FROM play_event GROUP BY primary_artist_id`).all<{
      artist_id: string;
      first_played: number;
    }>(),
  ]);

  const targetWeekSet = new Set(targetWeekDays);
  const priorWeekSet = new Set(priorWeekDays);

  const bySlotThis: Record<string, number> = {};
  const bySlotLast: Record<string, number> = {};
  let totalPlaysThisWeek = 0;
  const perArtistThis = new Map<string, NewArtistCandidate>();

  for (const row of rows) {
    const dayStr = dayFmt.format(new Date(row.played_at));
    if (targetWeekSet.has(dayStr)) {
      totalPlaysThisWeek++;
      if (row.slot_id) bySlotThis[row.slot_id] = (bySlotThis[row.slot_id] ?? 0) + 1;
      const existing = perArtistThis.get(row.artist_id);
      if (existing) existing.plays++;
      else perArtistThis.set(row.artist_id, { artistId: row.artist_id, name: row.name ?? row.artist_id, slotId: row.slot_id, plays: 1 });
    } else if (priorWeekSet.has(dayStr)) {
      if (row.slot_id) bySlotLast[row.slot_id] = (bySlotLast[row.slot_id] ?? 0) + 1;
    }
  }

  const firstPlayedByArtist = new Map(firstPlayedRows.map((r) => [r.artist_id, r.first_played]));
  const newArtists = Array.from(perArtistThis.values())
    .filter((a) => {
      const firstPlayed = firstPlayedByArtist.get(a.artistId);
      return firstPlayed !== undefined && targetWeekSet.has(dayFmt.format(new Date(firstPlayed)));
    })
    .sort((a, b) => b.plays - a.plays)
    .slice(0, MAX_NEW_ARTISTS);

  const slotIdsWithData = new Set([...Object.keys(bySlotThis), ...Object.keys(bySlotLast)]);
  const movers: WeeklyBriefMoverStat[] = Array.from(slotIdsWithData).map((slotId) => ({
    slotId,
    playsThisWeek: bySlotThis[slotId] ?? 0,
    playsLastWeek: bySlotLast[slotId] ?? 0,
  }));

  return { totalPlaysThisWeek, movers, newArtists };
}

// ---------------------------------------------------------------------------
// Gemini call — one batched request per generation attempt, same
// request/response handling (generateJson) every other Gemini-calling file
// in this Worker reuses (worker/gemini.ts stays the only file that actually
// calls out to Gemini).
// ---------------------------------------------------------------------------
function briefSchema() {
  return {
    type: "OBJECT",
    properties: {
      headline: {
        type: "STRING",
        description: "One short, playful sentence narrating the week's overall listening shift, under 140 characters.",
      },
      notes: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "2 to 4 short observations (each under 100 characters) about notable overall movement this week.",
      },
      slotNotes: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            slot: { type: "STRING", enum: SLOT_IDS },
            note: { type: "STRING", description: "One short line (under 100 characters) this district's character might post about their own week." },
          },
          required: ["slot", "note"],
        },
        description: "One entry per district that had a genuinely interesting change this week — skip flat/quiet districts entirely.",
      },
    },
    required: ["headline", "notes", "slotNotes"],
  };
}

interface BriefPromptSlot {
  slotId: string;
  genre: string;
  thisWeek: number;
  lastWeek: number;
}
interface BriefPromptArtist {
  name: string;
  genre: string;
}

function buildPrompt(slots: BriefPromptSlot[], newArtists: BriefPromptArtist[]): string {
  const slotLines = slots.map((s) => `- "${s.slotId}" (${s.genre}): ${s.thisWeek} plays this week, ${s.lastWeek} last week`).join("\n");
  const artistLines = newArtists.length > 0 ? newArtists.map((a) => `- ${a.name} (${a.genre})`).join("\n") : "(none)";
  return [
    'You are writing a short weekly "notice board" post for a pixel-art village game where each music genre is a character with their own district.',
    "Below is this week's listening compared to last week, broken down by district, plus any brand-new artists (never heard before this week).",
    "Districts (id (genre): this week vs last week plays):",
    slotLines,
    "New artists this week (name (genre)):",
    artistLines,
    "Write one short playful headline (under 140 characters) narrating the week's overall listening shift.",
    "Write 2 to 4 short global notes (each under 100 characters) about notable overall movement — new artists, a genre picking up or fading, etc.",
    "Write one short line (under 100 characters) for each district that had a genuinely interesting change this week, in that character's voice — skip flat or quiet districts entirely, don't force one for every id.",
    "Never mention Spotify, any platform, or the listener by name.",
    'Respond with a JSON object: {"headline": string, "notes": string[], "slotNotes": [{"slot": id, "note": string}]}.',
  ].join("\n");
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ParsedBrief {
  headline: string;
  notes: string[];
  slotNotes: Record<string, string>;
}

/** Sanitizes one Gemini-returned brief: clamps string lengths, caps note
 * counts, drops any slotNotes entry with an unknown slot id or empty note.
 * Returns `null` if the result isn't usable (no headline at all) so the
 * caller treats the whole attempt as failed and retries later, same
 * "nothing usable -> fall back / retry" rule as worker/persona.ts's
 * sanitizePersona. */
function parseBriefResponse(text: string): ParsedBrief | null {
  const obj = safeParseObject(text);
  if (!obj) return null;

  const headline = typeof obj.headline === "string" ? obj.headline.trim().slice(0, MAX_HEADLINE_CHARS) : "";
  if (!headline) return null;

  const rawNotes = Array.isArray(obj.notes) ? obj.notes : [];
  const notes = rawNotes
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.trim().slice(0, MAX_NOTE_CHARS))
    .slice(0, MAX_NOTES);

  const rawSlotNotes = Array.isArray(obj.slotNotes) ? obj.slotNotes : [];
  const slotNotes: Record<string, string> = {};
  for (const entry of rawSlotNotes) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const slotId = typeof row.slot === "string" && SLOT_IDS.includes(row.slot) ? row.slot : null;
    const note = typeof row.note === "string" ? row.note.trim().slice(0, MAX_SLOT_NOTE_CHARS) : "";
    if (slotId && note) slotNotes[slotId] = note;
  }

  return { headline, notes, slotNotes };
}

// ---------------------------------------------------------------------------
// D1 read/write
// ---------------------------------------------------------------------------
interface StoredStats {
  movers: WeeklyBriefMoverStat[];
  topNewArtists: { artistId: string; plays: number }[];
}

interface ExistingBriefRow {
  status: string;
  last_attempt_at: string;
}

async function readExistingRow(env: Env, weekStart: string): Promise<ExistingBriefRow | null> {
  return env.DB.prepare("SELECT status, last_attempt_at FROM weekly_brief WHERE week_start = ?").bind(weekStart).first<ExistingBriefRow>();
}

async function upsertBrief(
  env: Env,
  weekStart: string,
  data: { status: "ready" | "pending"; headline: string; notes: string[]; slotNotes: Record<string, string>; stats: StoredStats },
  nowMs: number,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO weekly_brief (week_start, status, headline, notes, slot_notes, stats, generated_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET
       status = excluded.status,
       headline = excluded.headline,
       notes = excluded.notes,
       slot_notes = excluded.slot_notes,
       stats = excluded.stats,
       generated_at = excluded.generated_at,
       last_attempt_at = excluded.last_attempt_at`,
  )
    .bind(weekStart, data.status, data.headline, JSON.stringify(data.notes), JSON.stringify(data.slotNotes), JSON.stringify(data.stats), nowIso, nowIso)
    .run();
}

/**
 * Runs one cron cycle's worth of weekly-brief work. Gating (SPEC.md's Phase
 * 9 task):
 *  - Owner-local Monday, before BRIEF_GRACE_HOURS has elapsed -> too early,
 *    skip entirely (nothing written, not even for a prior week).
 *  - The latest complete week starts before the earliest logged play ->
 *    pre-history/partial week, skip entirely, no row ever written for it.
 *  - No row yet for the latest complete week -> generate (first attempt).
 *  - Row exists with status 'ready' -> nothing to do, this week is done.
 *  - Row exists with status 'pending' (a prior attempt failed or hit quota)
 *    -> retried only once RETRY_COOLDOWN_MS has passed since last_attempt_at.
 *
 * Never throws — every exit path either returns quietly or has already
 * logged, matching worker/history.ts's runHistorySync (this runs right after
 * it in worker/index.ts's scheduled(), so a Gemini/D1 hiccup here can never
 * take that down with it).
 */
export async function runWeeklyBrief(env: Env): Promise<void> {
  try {
    await runWeeklyBriefInner(env);
  } catch (err) {
    console.error("[weekly-brief] run failed:", err);
  }
}

async function runWeeklyBriefInner(env: Env): Promise<void> {
  const nowMs = Date.now();
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: env.OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  // Only used for the grace-window check below — weekDayStrings itself does
  // its own calendar arithmetic off dayFmt now (DST-safe, see its doc
  // comment), so this isn't needed there anymore.
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: env.OWNER_TZ, weekday: "short" });
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: env.OWNER_TZ, hour: "2-digit", hourCycle: "h23" });

  if (weekdayFmt.format(new Date(nowMs)) === "Mon" && Number(hourFmt.format(new Date(nowMs))) < BRIEF_GRACE_HOURS) {
    return; // see BRIEF_GRACE_HOURS's doc comment
  }

  const targetWeekDays = weekDayStrings(dayFmt, nowMs, 1); // the latest *complete* week
  const priorWeekDays = weekDayStrings(dayFmt, nowMs, 2); // the week before it, for the diff
  const weekStart = targetWeekDays[0]!;

  // History only started 2026-09-18 (Phase 8a) — a week that starts before
  // the very first logged play would get either an empty/near-empty
  // template brief (noise, not a real "first week" the owner would want to
  // see) or, worse, a partial first week whose numbers can never be
  // corrected once the cron has moved past it. Skip writing any row at all
  // for such a week; the first real brief lands for the first Monday-Sunday
  // week that's entirely within logged history.
  const earliestPlayRow = await env.DB.prepare("SELECT MIN(played_at) AS min_played FROM play_event").first<{ min_played: number | null }>();
  const earliestPlayedAt = earliestPlayRow?.min_played ?? null;
  if (earliestPlayedAt === null || weekStart < dayFmt.format(new Date(earliestPlayedAt))) return;

  const existing = await readExistingRow(env, weekStart);
  if (existing) {
    if (existing.status === "ready") return;
    const sinceAttemptMs = nowMs - Date.parse(existing.last_attempt_at);
    if (sinceAttemptMs < RETRY_COOLDOWN_MS) return;
  }

  const diff = await computeSnapshotDiff(env, dayFmt, targetWeekDays, priorWeekDays, nowMs);
  const stats: StoredStats = { movers: diff.movers, topNewArtists: diff.newArtists.map((a) => ({ artistId: a.artistId, plays: a.plays })) };

  if (diff.totalPlaysThisWeek < MIN_WEEK_PLAYS) {
    // Too little data to say anything real — a template row that's final
    // (status 'ready') for this week: more plays can't retroactively appear
    // once the cron has already looked at a week that's fully elapsed.
    await upsertBrief(env, weekStart, { status: "ready", headline: TEMPLATE_HEADLINE, notes: [], slotNotes: {}, stats }, nowMs);
    return;
  }

  if (!(await geminiQuotaAvailable(env, "cron", "brief"))) {
    await upsertBrief(env, weekStart, { status: "pending", headline: "", notes: [], slotNotes: {}, stats }, nowMs);
    return;
  }

  const promptSlots: BriefPromptSlot[] = diff.movers
    .filter((m) => m.playsThisWeek > 0 || m.playsLastWeek > 0)
    .map((m) => ({ slotId: m.slotId, genre: SLOT_BY_ID.get(m.slotId)?.district.genre ?? m.slotId, thisWeek: m.playsThisWeek, lastWeek: m.playsLastWeek }));
  const promptArtists: BriefPromptArtist[] = diff.newArtists.map((a) => ({
    name: a.name,
    genre: (a.slotId && SLOT_BY_ID.get(a.slotId)?.district.genre) || "unknown genre",
  }));

  let parsed: ParsedBrief | null = null;
  try {
    await logGeminiCall(env, "cron", "brief");
    const text = await generateJson(env, buildPrompt(promptSlots, promptArtists), briefSchema());
    parsed = parseBriefResponse(text);
  } catch (err) {
    console.error("[weekly-brief] gemini call failed:", errorMessage(err));
  }

  if (!parsed) {
    // Attempt made (and already logged against the Gemini cap above if it
    // got that far) but produced nothing usable — 'pending' so a later tick
    // retries, no sooner than RETRY_COOLDOWN_MS from now.
    await upsertBrief(env, weekStart, { status: "pending", headline: "", notes: [], slotNotes: {}, stats }, nowMs);
    return;
  }

  await upsertBrief(env, weekStart, { status: "ready", headline: parsed.headline, notes: parsed.notes, slotNotes: parsed.slotNotes, stats }, nowMs);
}

// ---------------------------------------------------------------------------
// GET /api/weekly-brief
// ---------------------------------------------------------------------------
export interface WeeklyBriefMoverOut {
  slotId: string;
  playsThisWeek: number;
  playsLastWeek: number;
}
export interface WeeklyBriefNewArtistOut {
  id: string;
  name: string;
  slotId: string | null;
  plays: number;
}
export interface WeeklyBriefOut {
  weekStart: string;
  headline: string;
  notes: string[];
  slotNotes: Record<string, string>;
  movers: WeeklyBriefMoverOut[];
  topNewArtists: WeeklyBriefNewArtistOut[];
  generatedAt: string;
}
export interface WeeklyBriefResponse {
  brief: WeeklyBriefOut | null;
}

interface BriefRow {
  week_start: string;
  headline: string;
  notes: string;
  slot_notes: string;
  stats: string;
  generated_at: string;
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The most recent 'ready' brief, or null before the first one exists.
 * Deliberately not "the latest complete week's row regardless of status" —
 * a 'pending' week (still retrying) falls through to the last real brief
 * instead of the notice board going blank while a retry is outstanding. */
async function loadLatestReadyBrief(env: Env): Promise<WeeklyBriefOut | null> {
  const row = await env.DB.prepare(
    "SELECT week_start, headline, notes, slot_notes, stats, generated_at FROM weekly_brief WHERE status = 'ready' ORDER BY week_start DESC LIMIT 1",
  ).first<BriefRow>();
  if (!row) return null;

  const stats = safeParseJson<Partial<StoredStats>>(row.stats, {});
  const movers = Array.isArray(stats.movers) ? stats.movers : [];
  const topNewArtistIds = Array.isArray(stats.topNewArtists) ? stats.topNewArtists : [];

  let namesById = new Map<string, { name: string; slot_id: string | null }>();
  if (topNewArtistIds.length > 0) {
    const placeholders = topNewArtistIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT artist_id, name, slot_id FROM artist_cache WHERE artist_id IN (${placeholders})`)
      .bind(...topNewArtistIds.map((a) => a.artistId))
      .all<{ artist_id: string; name: string; slot_id: string | null }>();
    namesById = new Map(results.map((r) => [r.artist_id, { name: r.name, slot_id: r.slot_id }]));
  }
  const topNewArtists: WeeklyBriefNewArtistOut[] = topNewArtistIds.map((a) => {
    const info = namesById.get(a.artistId);
    return { id: a.artistId, name: info?.name ?? a.artistId, slotId: info?.slot_id ?? null, plays: a.plays };
  });

  return {
    weekStart: row.week_start,
    headline: row.headline,
    notes: safeParseJson<string[]>(row.notes, []),
    slotNotes: safeParseJson<Record<string, string>>(row.slot_notes, {}),
    movers,
    topNewArtists,
    generatedAt: row.generated_at,
  };
}

function cacheKeyFor(): Request {
  return new Request("https://echoes-cache.internal/weekly-brief");
}

async function readCache(key: Request): Promise<WeeklyBriefResponse | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as WeeklyBriefResponse;
}

async function writeCache(key: Request, payload: WeeklyBriefResponse): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

/** D1-only, no Spotify/Gemini call ever happens on this path — generation is
 * entirely the cron's job (runWeeklyBrief above). Still cached in
 * caches.default (SPEC.md's task), same 30-min convention as every other
 * endpoint here, since it's read far more often than it ever changes. */
export async function handleWeeklyBrief(env: Env): Promise<Response> {
  const cacheKey = cacheKeyFor();
  try {
    const cached = await readCache(cacheKey);
    if (cached) return Response.json(cached);
  } catch (err) {
    console.error("[weekly-brief] cache read failed, rebuilding:", err);
  }

  const payload: WeeklyBriefResponse = { brief: await loadLatestReadyBrief(env) };
  await writeCache(cacheKey, payload);
  return Response.json(payload);
}
