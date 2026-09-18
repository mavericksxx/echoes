-- Phase 7c: AI live captions. Rides the existing /api/now-playing poll
-- (worker/now-playing.ts already resolves slotId from artist_cache on every
-- cache-window refresh, ~once per 10s, at zero extra Spotify calls) — this
-- table is what keeps a single song from costing more than one Gemini call,
-- no matter how many of those ~10s windows it plays through. See
-- worker/captions.ts. Purely additive — no existing table is touched.

-- One row per (artist, track) pair ever captioned, forever — a caption is
-- flavor text about the song itself, not a fact that goes stale, so unlike
-- artist_cache/genre_slot_map there is no re-inference path or TTL.
CREATE TABLE caption_cache (
  artist_id TEXT NOT NULL, -- the track's primary artist (same id worker/now-playing.ts resolves slotId from)
  track_id TEXT NOT NULL,
  lines TEXT NOT NULL, -- JSON array of a few short in-world caption strings
  generated_at TEXT NOT NULL,
  PRIMARY KEY (artist_id, track_id)
);
