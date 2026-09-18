// Rate-aware Spotify fetch wrapper — the *only* thing in this Worker that
// is allowed to call api.spotify.com. Honors 429 Retry-After, backs off
// exponentially with jitter on 429/5xx, logs every real HTTP attempt to
// `usage_log`, and never lets a raw Spotify error body reach the client
// (callers only ever see a `SpotifyRequestError` with a status code).

import type { Env } from "./index";

const API_BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

export class SpotifyRequestError extends Error {
  constructor(public status: number) {
    super(`Spotify request failed (status ${status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  return base + Math.random() * base * 0.3; // up to 30% jitter
}

/** Everything about a single Spotify HTTP attempt worth measuring passively
 * (SPEC.md's rate-limit research block, "before Phase 6's ramp test") beyond
 * endpoint/status/retry count — all optional since most attempts won't have
 * most of these (the X-RateLimit-* headers are undocumented and may never
 * appear at all; quotaReason only exists on a 429 body). */
interface UsageLogExtra {
  retryAfterRaw: string | null;
  rateLimitLimit: string | null;
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
  responseDate: string | null;
  quotaReason: string | null;
}

const NO_EXTRA: UsageLogExtra = {
  retryAfterRaw: null,
  rateLimitLimit: null,
  rateLimitRemaining: null,
  rateLimitReset: null,
  responseDate: null,
  quotaReason: null,
};

/** Reads the handful of response headers worth logging — never consumes the
 * body, so this is safe to call regardless of what the caller still needs
 * to do with `res`. */
function usageExtraFromHeaders(res: Response): UsageLogExtra {
  return {
    retryAfterRaw: res.headers.get("Retry-After"),
    rateLimitLimit: res.headers.get("X-RateLimit-Limit"),
    rateLimitRemaining: res.headers.get("X-RateLimit-Remaining"),
    rateLimitReset: res.headers.get("X-RateLimit-Reset"),
    responseDate: res.headers.get("Date"),
    quotaReason: null,
  };
}

/** A 429 body's `error.reason` (Spotify added `QUOTA_EXCEEDED` in 2026 to
 * distinguish the per-developer-account quota from the rolling-30s rate
 * limit — see SPEC.md). Read defensively: the body may not be JSON, and
 * this must never throw or block the retry that follows it. */
async function readQuotaReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { reason?: string } };
    return body.error?.reason ?? null;
  } catch {
    return null;
  }
}

async function logUsage(
  env: Env,
  endpoint: string,
  status: number,
  retry429Count: number,
  extra: UsageLogExtra = NO_EXTRA,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO usage_log
         (endpoint, status, retry_429_count, created_at, retry_after_raw, x_ratelimit_limit, x_ratelimit_remaining, x_ratelimit_reset, response_date, quota_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        endpoint,
        status,
        retry429Count,
        new Date().toISOString(),
        extra.retryAfterRaw,
        extra.rateLimitLimit,
        extra.rateLimitRemaining,
        extra.rateLimitReset,
        extra.responseDate,
        extra.quotaReason,
      )
      .run();
  } catch {
    // Logging must never break the actual request.
  }
}

/**
 * GETs `endpoint` (e.g. "/me/top/artists?time_range=medium_term&limit=10")
 * from the Spotify Web API with the given access token, retrying 429s
 * (honoring Retry-After when present) and 5xx with exponential backoff +
 * jitter, up to MAX_RETRIES. Every real HTTP attempt is logged. Throws
 * `SpotifyRequestError` on a non-retryable failure or exhausted retries —
 * callers must catch this rather than let it leak Spotify's response body.
 */
export async function spotifyGet<T>(env: Env, endpoint: string, accessToken: string): Promise<T> {
  let retry429Count = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 429) {
      retry429Count++;
      const extra = usageExtraFromHeaders(res);
      extra.quotaReason = await readQuotaReason(res);
      await logUsage(env, endpoint, res.status, retry429Count, extra);
      if (attempt === MAX_RETRIES) throw new SpotifyRequestError(429);
      const retryAfter = res.headers.get("Retry-After");
      await sleep(retryAfter ? Number(retryAfter) * 1000 : backoffMs(attempt));
      continue;
    }

    if (res.status >= 500) {
      await logUsage(env, endpoint, res.status, retry429Count, usageExtraFromHeaders(res));
      if (attempt === MAX_RETRIES) throw new SpotifyRequestError(res.status);
      await sleep(backoffMs(attempt));
      continue;
    }

    await logUsage(env, endpoint, res.status, retry429Count, usageExtraFromHeaders(res));
    if (!res.ok) throw new SpotifyRequestError(res.status);
    // 204 No Content (e.g. GET /me/player/currently-playing when nothing is
    // playing) has no body — res.json() would throw on it. Callers that can
    // receive a 204 pass a nullable T (see worker/now-playing.ts).
    if (res.status === 204) return null as T;
    return (await res.json()) as T;
  }

  // Unreachable — the loop above always returns or throws — but keeps
  // control flow analysis (and TypeScript) happy.
  throw new SpotifyRequestError(599);
}
