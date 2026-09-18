-- Phase 8a: the play-event log starts. Worker cron (worker/history.ts)
-- polls GET /me/player/recently-played every 15 min and appends here.
-- Purely additive — no existing table is dropped or has a column removed.
--
-- Scope note: this is the *logging* half of Phase 8 only (SPEC.md's 8a/8b
-- split). daily_snapshot rollups, history-driven activity levels, the
-- sidebar History section, and the era/time-range toggle are Phase 8b, on
-- top of the rows this migration lets Phase 8a start collecting today.

-- One row per Spotify play. `played_at` (Spotify's own timestamp, ms
-- precision, unique per play) is the primary key rather than a separate
-- autoincrement id: it's already a unique, monotonic-ish value we'd index
-- anyway for range scans, so making it the rowid-aliased PK means
-- `WHERE played_at >= ?` (Phase 8b's era buckets, Phase 8.5's arbitrary
-- ranges) is a direct btree range scan with no secondary index. IDs and
-- facts only — no denormalized artist/track names here, matching
-- artist_cache's existing convention (names live in track_cache/
-- artist_cache, joined at query time, so a later rename/typo fix in
-- Spotify's own data isn't duplicated across every play row it ever
-- generated).
--
-- Deviation from SPEC.md line 83 ("play_event (derived: timestamp, artist
-- id, slot)"): deliberately NO slot_id column. A slot is a re-classifiable
-- inference, not a fact about the play — worker/genre-resolution.ts already
-- treats a fallback guess as too provisional to persist to artist_cache (see
-- its doc comment), and freezing one per play here would bake in whatever
-- guess (possibly a low-confidence fallback, possibly later corrected by a
-- real Gemini classification) existed at cron time, forever. Phase 8b joins
-- through artist_cache.slot_id at query time instead, so every play always
-- reflects the *current* best classification of its artist, not the one
-- that happened to be cached 15 minutes after it aired.
CREATE TABLE play_event (
  played_at INTEGER PRIMARY KEY, -- epoch ms, from Spotify's own `played_at`
  track_id TEXT NOT NULL,
  primary_artist_id TEXT NOT NULL,
  artist_ids TEXT NOT NULL, -- JSON array of every artist id on the track (D1 has JSON1 — json_each works in 8b)
  duration_ms INTEGER NOT NULL, -- track length, not time actually listened (see worker/history.ts)
  context_uri TEXT -- e.g. "spotify:playlist:..." — nullable, free, wanted by Phase 8.6
);

-- Keyed by track_id, populated at cron time straight from the inline
-- `track` object recently-played already returns for each item — zero extra
-- Spotify calls. Not optional: Spotify removed the batch GET /tracks
-- endpoint in Feb 2026 (SPEC.md's "Spotify API constraints"), so re-resolving
-- names at display time would cost one single-item call per row, and any
-- play_event row logged before this table existed would be a permanent hole
-- in Wrapped (Phase 8.5). Same category and justification as artist_cache
-- (migrations/0001_init.sql), which has stored Spotify names/art in D1 since
-- Phase 1.
CREATE TABLE track_cache (
  track_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  artist_names TEXT NOT NULL, -- comma-joined display string, same convention as worker/tracks.ts's TrackOut.artist
  album_name TEXT NOT NULL,
  image_url TEXT,
  spotify_url TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  cached_at TEXT NOT NULL
);

-- Append-only run log for the cron (worker/history.ts) — one row per
-- invocation, whether or not it actually called Spotify. This is where
-- /api/history/stats gets a real lastSyncAt and where gap detection has
-- somewhere durable to live, rather than only ever existing as a
-- console.error nobody's watching (the cron runs with nobody watching in
-- real time, per SPEC.md's rate-limit research).
CREATE TABLE history_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL, -- 0/1 — false for a skipped-due-to-ban run or a caught error
  fetched INTEGER NOT NULL DEFAULT 0, -- items returned by recently-played this run
  inserted INTEGER NOT NULL DEFAULT 0, -- rows actually new (INSERT OR IGNORE's effective count)
  gap_suspected INTEGER NOT NULL DEFAULT 0, -- 1 if inserted == fetched on a non-first run (see worker/history.ts)
  error TEXT
);
