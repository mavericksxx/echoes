-- Phase 8b, Stage 1: token cache in D1. `worker/token.ts`'s access-token
-- cache used to be per-isolate memory only (BACKLOG.md's "known exposure" —
-- Phase 8a's 15-min cron lands on a cold isolate almost every run, so it was
-- refreshing roughly every run instead of ~once per the token's real ~50min
-- TTL). Persisting the encrypted access token + its expiry here lets
-- getAccessToken read a still-valid token straight from D1 before ever
-- calling Spotify's token endpoint again. Purely additive — no existing
-- column is dropped or changed.

-- The access token itself, encrypted the same way (AES-GCM via TOKEN_KEY,
-- worker/crypto.ts) as encrypted_refresh_token.
ALTER TABLE spotify_token ADD COLUMN encrypted_access_token TEXT;
-- Epoch ms — when the cached access token stops being safely usable
-- (worker/token.ts applies the same 60s safety margin it always has).
ALTER TABLE spotify_token ADD COLUMN access_expires_at INTEGER;
-- Compare-and-swap guard: every refresh that writes a new access/refresh
-- token pair bumps this in the same UPDATE, gated by `WHERE version = ?`, so
-- when two isolates refresh concurrently exactly one write wins and the
-- other discards its result and re-reads instead of clobbering the winner's
-- (possibly rotated) refresh token. Defaults to 0 so the existing row (and
-- any future reconnect via scripts/spotify-connect.mjs, which only ever
-- writes encrypted_refresh_token/scope/updated_at) starts a fresh CAS
-- sequence rather than needing a backfill.
ALTER TABLE spotify_token ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
