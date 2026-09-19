// Per-IP rate limiting + the Gemini daily cost cap (SPEC.md's "Hosting" and
// "AI cost control" sections).
//
// Choice of storage: D1, not the Cache API. Counters need to be read back
// exactly (the daily Gemini cap must not silently under-count), and D1 rows
// are trivial to inspect/test with `wrangler d1 execute --local` — Cache API
// entries are best-effort per-colo and awkward to assert against in a
// migration-driven test. Traffic here is a single personal app, not a
// high-QPS API, so D1's per-request latency is a non-issue; the tradeoff is
// unbounded row growth over time, accepted for now and swept opportunistically
// (see cleanupOldWindows) rather than by a dedicated cron.

import type { Env } from "./index";

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super("Rate limit exceeded");
  }
}

interface RateLimitRule {
  /** Fixed window size, in seconds. */
  windowSeconds: number;
  /** Max requests allowed per IP within one window. */
  max: number;
}

/** General per-IP limits, applied to every request before it's routed.
 * `village` is stricter than `topArtists`/`health` because it's the only
 * endpoint that can trigger a Gemini call (see AI_ endpoint gemini quota
 * below, which caps that separately and more tightly). */
export const RATE_LIMIT_RULES: Record<string, RateLimitRule> = {
  health: { windowSeconds: 60, max: 120 },
  topArtists: { windowSeconds: 60, max: 60 },
  village: { windowSeconds: 60, max: 20 },
  // Polled adaptively (~10s while playing) by every open tab — this is the
  // one endpoint expected to be hit the most per visitor, but the shared
  // ~10s caches.default cache in worker/now-playing.ts is what actually
  // bounds real Spotify calls; this is just per-IP abuse protection on top.
  nowPlaying: { windowSeconds: 60, max: 60 },
  // D1-only reads of two small tables (worker/history.ts's
  // handleHistoryStats) — no Spotify call it could ever burn, so the same
  // generous limit as topArtists/health.
  historyStats: { windowSeconds: 60, max: 60 },
};

function bucketKey(ip: string, bucket: string, windowStart: number): string {
  return `${ip}:${bucket}:${windowStart}`;
}

// Sweeps windows older than this on a small fraction of requests, so the
// table doesn't grow forever without needing its own cron.
const CLEANUP_RETENTION_SECONDS = 3600;
const CLEANUP_SAMPLE_RATE = 0.05;

async function cleanupOldWindows(env: Env, nowSeconds: number): Promise<void> {
  if (Math.random() >= CLEANUP_SAMPLE_RATE) return;
  try {
    await env.DB.prepare("DELETE FROM rate_limit_window WHERE window_start < ?")
      .bind(nowSeconds - CLEANUP_RETENTION_SECONDS)
      .run();
  } catch {
    // Cleanup is best-effort — never let it fail the request it rode in on.
  }
}

/** Throws `RateLimitError` once `ip` has made more than `rule.max` requests
 * to `bucket` within the current fixed window. */
export async function enforceRateLimit(env: Env, ip: string, bucket: string, rule: RateLimitRule): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / rule.windowSeconds) * rule.windowSeconds;
  const key = bucketKey(ip, bucket, windowStart);

  const row = await env.DB.prepare(
    `INSERT INTO rate_limit_window (bucket_key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();

  void cleanupOldWindows(env, nowSeconds);

  const count = row?.count ?? 1;
  if (count > rule.max) {
    throw new RateLimitError(rule.windowSeconds);
  }
}

// ---------------------------------------------------------------------------
// Gemini daily cap — separate from the per-minute limits above. Genre
// resolution is cached (see worker/genre-resolution.ts), so under normal
// operation Gemini is called rarely (new artists/genres only); these caps
// exist purely as a hard ceiling on cost if something goes wrong (a cache
// miss loop, a burst of never-seen artists, etc).
//
// Not every "kind" gets the same slice of that ceiling. "genres"/"artists"
// are the core slot-resolution pipeline everything else in the village
// depends on (worker/genre-resolution.ts, worker/history.ts's cron) — they
// always get the full global/per-IP caps below. "moods"/"persona"/
// "captions" are all additive Phase 7 features layered on top, and unlike
// slot resolution, captions in particular scale with *listening volume*
// (one call per newly-seen track, not per artist) rather than with how many
// distinct artists/genres exist — a busy listening day could otherwise burn
// through the shared global cap and starve slot resolution for everyone.
// So those three kinds back off from a reserved slice instead of the raw
// cap, and captions additionally gets its own tighter sub-cap (below) on
// top of that shared backoff.
// ---------------------------------------------------------------------------
export const GEMINI_DAILY_GLOBAL_CAP = 300;
export const GEMINI_DAILY_PER_IP_CAP = 40;
// Headroom reserved for "genres"/"artists" (slot resolution) — non-core
// kinds ("moods"/"persona"/"captions") may only use the global cap down to
// GEMINI_DAILY_GLOBAL_CAP - GEMINI_DAILY_CORE_RESERVE, never past it.
export const GEMINI_DAILY_CORE_RESERVE = 100;
// Dedicated daily ceiling for "captions" specifically, on top of (not
// instead of) the reserve-adjusted global cap above — the one kind whose
// volume tracks listening activity rather than distinct-artist/genre count.
export const GEMINI_DAILY_CAPTIONS_CAP = 60;

export type GeminiCallKind = "genres" | "artists" | "moods" | "persona" | "captions";

const CORE_KINDS: ReadonlySet<GeminiCallKind> = new Set(["genres", "artists"]);

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Whether `ip` may trigger another Gemini call of this `kind` right now,
 * given today's usage_log rows (endpoint LIKE 'gemini:%'). Checked *before*
 * calling Gemini; callers that get `false` back must serve cached/fallback
 * results instead (see genre-resolution.ts) and say so in the response.
 *
 * `kind` decides which slice of the global cap applies (see this file's
 * doc comment above) and, for "captions" only, also checks a second,
 * dedicated sub-cap so a busy listening day can't eat into the shared
 * reserve moods/persona draw from too. */
export async function geminiQuotaAvailable(env: Env, ip: string, kind: GeminiCallKind): Promise<boolean> {
  const since = startOfUtcDayIso();
  const globalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM usage_log WHERE endpoint LIKE 'gemini:%' AND created_at >= ?",
  )
    .bind(since)
    .first<{ n: number }>();
  const globalCap = CORE_KINDS.has(kind) ? GEMINI_DAILY_GLOBAL_CAP : GEMINI_DAILY_GLOBAL_CAP - GEMINI_DAILY_CORE_RESERVE;
  if ((globalRow?.n ?? 0) >= globalCap) return false;

  const ipRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM usage_log WHERE endpoint LIKE 'gemini:%' AND ip = ? AND created_at >= ?",
  )
    .bind(ip, since)
    .first<{ n: number }>();
  if ((ipRow?.n ?? 0) >= GEMINI_DAILY_PER_IP_CAP) return false;

  if (kind === "captions") {
    const captionsRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM usage_log WHERE endpoint = 'gemini:captions' AND created_at >= ?",
    )
      .bind(since)
      .first<{ n: number }>();
    if ((captionsRow?.n ?? 0) >= GEMINI_DAILY_CAPTIONS_CAP) return false;
  }

  return true;
}

/** Records one Gemini API call (one batched classify-genres, classify-artists,
 * Phase 7a classify-moods, Phase 7b persona-generation, or Phase 7c caption-generation request, regardless of how many items were in
 * it) against both the global and per-IP daily caps. */
export async function logGeminiCall(env: Env, ip: string, kind: GeminiCallKind): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_log (endpoint, status, retry_429_count, created_at, ip) VALUES (?, 200, 0, ?, ?)",
    )
      .bind(`gemini:${kind}`, new Date().toISOString(), ip)
      .run();
  } catch {
    // Logging must never break the actual request.
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
