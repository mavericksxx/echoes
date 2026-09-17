-- Phase 3: genre → slot resolution + its caching, and the rate-limit
-- counters that ship alongside the first Gemini call. Purely additive — no
-- existing table is dropped or has a column removed.

-- Maps one raw genre/tag string (as Spotify returns it, lowercased) to one
-- of the 17 roster slot ids. Populated lazily: the first time a genre is
-- seen, worker/genre-resolution.ts resolves it once (Spotify's own genres
-- need no AI; anything left over goes through a single batched Gemini call)
-- and every later artist with that same genre reuses the row for free.
CREATE TABLE genre_slot_map (
  genre TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  source TEXT NOT NULL, -- 'gemini' (only real classifications are persisted here)
  confidence REAL NOT NULL, -- 0..1
  created_at TEXT NOT NULL
);

-- Phase 2 created artist_cache with just name/genres/art. Phase 3 adds the
-- resolved slot so /api/village never re-derives (or re-asks Gemini for) an
-- artist it has already placed.
ALTER TABLE artist_cache ADD COLUMN slot_id TEXT;
ALTER TABLE artist_cache ADD COLUMN slot_source TEXT; -- 'gemini' (a 'fallback' guess is never persisted — see worker/genre-resolution.ts)
ALTER TABLE artist_cache ADD COLUMN slot_confidence REAL;
ALTER TABLE artist_cache ADD COLUMN inferred_at TEXT;

-- Per-IP request counters for the rate limiter (see worker/rate-limit.ts —
-- a fixed-window D1 counter, documented there). One row per (ip, endpoint
-- bucket, window); rows outside the current window are cleaned up
-- opportunistically on write rather than by a separate job.
CREATE TABLE rate_limit_window (
  bucket_key TEXT PRIMARY KEY, -- `${ip}:${bucketName}:${windowStart}`
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL -- epoch seconds, floored to the bucket's window size
);

CREATE INDEX idx_rate_limit_window_start ON rate_limit_window (window_start);

-- Lets the Gemini daily cap (worker/rate-limit.ts) count both global and
-- per-IP Gemini-call volume straight out of the existing usage_log table
-- (per SPEC.md: "recorded in usage_log"), without a second log table.
-- NULL for the pre-existing Spotify rows this table already had.
ALTER TABLE usage_log ADD COLUMN ip TEXT;
