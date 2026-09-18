// Echoes Worker — serves the Vite build as static assets and exposes a
// small API surface. Phase 2 adds the Spotify token manager (token.ts), the
// rate-aware fetch wrapper (spotify-fetch.ts), and /api/top-artists
// (top-artists.ts). Phase 3 adds /api/village (village.ts, genre resolution
// via Gemini) and per-IP rate limiting (rate-limit.ts), applied here to
// every /api/* route before it's dispatched. Phase 3.5 adds real top tracks
// to /api/village (worker/tracks.ts). Its CSP (the sidebar now hotlinks
// Spotify album art) lives in public/_headers, not here — wrangler.jsonc's
// `assets` config has no `run_worker_first`, so a request for "/" is served
// straight off Cloudflare's static-asset layer without this fetch handler
// running at all; a header set here on env.ASSETS.fetch()'s result would be
// dead code for exactly the response it needs to reach (fix pass, 2026-09-17
// — a first attempt tried exactly that and it silently never fired). Phase
// 5a adds /api/now-playing (now-playing.ts) for the display-only now-playing
// card. Phase 8a adds a `scheduled()` export (wrangler.jsonc's
// `triggers.crons`) driving worker/history.ts's play-event log, plus
// /api/history/stats for its small frontend readout.

import { handleTopArtists } from "./top-artists";
import { handleVillage } from "./village";
import { handleNowPlaying } from "./now-playing";
import { runHistorySync, handleHistoryStats } from "./history";
import { clientIp, enforceRateLimit, RateLimitError, RATE_LIMIT_RULES } from "./rate-limit";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Public PKCE client id (no client secret exists) — set in wrangler.jsonc's `vars`. */
  SPOTIFY_CLIENT_ID: string;
  /** Base64 AES-256 key encrypting the stored refresh token — a Worker secret (`wrangler secret put TOKEN_KEY`). */
  TOKEN_KEY: string;
  /** Gemini API key (free tier) — a Worker secret (`wrangler secret put GEMINI_API_KEY`). Used only by worker/gemini.ts. */
  GEMINI_API_KEY: string;
}

/** Maps a route to its rate-limit bucket — every /api/* route is limited
 * (SPEC.md's "Hosting"); /api/village is stricter since it's the only one
 * that can trigger a Gemini call (its own daily cap is separate, see
 * rate-limit.ts's geminiQuotaAvailable). */
const ROUTE_BUCKETS: Record<string, keyof typeof RATE_LIMIT_RULES> = {
  "/api/health": "health",
  "/api/top-artists": "topArtists",
  "/api/village": "village",
  "/api/now-playing": "nowPlaying",
  "/api/history/stats": "historyStats",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bucket = ROUTE_BUCKETS[url.pathname];

    if (bucket) {
      try {
        await enforceRateLimit(env, clientIp(request), bucket, RATE_LIMIT_RULES[bucket]);
      } catch (err) {
        if (err instanceof RateLimitError) {
          return Response.json(
            { error: "Too many requests" },
            { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } },
          );
        }
        // Rate limiting itself is abuse protection, not core functionality —
        // if its D1 counter fails for some unrelated reason, fail *open*
        // (let the request through) rather than 500ing every route.
        console.error(`[rate-limit] enforcement failed for ${bucket}, failing open:`, err);
      }
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/top-artists") {
      return handleTopArtists(request, env);
    }

    if (url.pathname === "/api/village") {
      return handleVillage(request, env);
    }

    if (url.pathname === "/api/now-playing") {
      return handleNowPlaying(env);
    }

    if (url.pathname === "/api/history/stats") {
      return handleHistoryStats(env);
    }

    // Reached only when a request matches neither a rate-limited /api/*
    // route above nor a real static file (those are served directly off
    // Cloudflare's asset layer without invoking this handler at all) — i.e.
    // effectively just the "asset not found" fallthrough. See public/_headers
    // for the CSP that used to be (incorrectly) applied here.
    return env.ASSETS.fetch(request);
  },

  // Phase 8a: 15-min play-event log (wrangler.jsonc's `triggers.crons`).
  // `runHistorySync` never throws (every failure path logs a `history_sync`
  // row and returns instead) — `waitUntil` just makes sure the isolate stays
  // alive until its D1 writes land rather than being torn down the instant
  // this handler returns.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runHistorySync(env));
  },
} satisfies ExportedHandler<Env>;
