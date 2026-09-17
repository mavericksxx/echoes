-- Phase 2: auth + rate-limit plumbing. Kept minimal — later phases add
-- genre_slot_map, daily_snapshot, play_event, world_state, agent_event,
-- llm_cache (see SPEC.md's Data model).

-- Single-row table: the owner's Spotify refresh token, encrypted at rest
-- (AES-GCM, see worker/crypto.ts + scripts/spotify-crypto.mjs). `id` is
-- always 1 — there is exactly one owner, never a multi-user table.
CREATE TABLE spotify_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-artist cache (name/genres/art keyed by Spotify artist id), so later
-- phases (genre mapping, mood tagging) don't re-fetch or re-infer per
-- artist every time. Phase 2 only creates the table; Phase 3+ populates the
-- slot/mood/npc_text side of it via ALTER TABLE.
CREATE TABLE artist_cache (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genres TEXT NOT NULL, -- JSON array of strings
  image_url TEXT,
  cached_at TEXT NOT NULL
);

-- One row per real Spotify HTTP call (including retries), so rate limits
-- can be measured (Phase 6) and abuse spotted.
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  status INTEGER NOT NULL,
  retry_429_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_usage_log_created_at ON usage_log (created_at);
