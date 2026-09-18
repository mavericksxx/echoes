-- Phase 7a: per-artist mood/energy tagging (SPEC.md's "Phase 7 — Moods and
-- personalities"). Purely additive — no existing column is dropped or
-- changed. Same shape as Phase 3's slot columns on artist_cache (slot_id/
-- slot_source/slot_confidence/inferred_at): only a real Gemini classification
-- is ever persisted here (see worker/genre-resolution.ts's resolveArtistMoods
-- — a degraded/no-mood artist just leaves these columns NULL, never a
-- fallback guess written in as if it were real).

-- One of a fixed 5-value enum (calm/melancholy/upbeat/intense/dreamy — see
-- worker/gemini.ts's MOOD_IDS) describing this artist's dominant vibe. NULL
-- until tagged (or if tagging has degraded — quota cap / Gemini failure).
ALTER TABLE artist_cache ADD COLUMN mood TEXT;
-- 0..1 — how high-energy this artist reads, alongside `mood`'s more
-- qualitative read. NULL alongside `mood` until tagged.
ALTER TABLE artist_cache ADD COLUMN energy REAL;
-- When `mood`/`energy` were last set by a real Gemini call — distinct from
-- `inferred_at` (the slot classification's own timestamp), since mood
-- tagging runs as its own pass and can lag slot resolution by a request or
-- two (see resolveArtistMoods: it only tags artists whose artist_cache row
-- already exists).
ALTER TABLE artist_cache ADD COLUMN mood_tagged_at TEXT;
