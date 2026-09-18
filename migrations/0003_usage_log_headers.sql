-- Phase 5a: capture more of Spotify's rate-limit response signal per HTTP
-- attempt (worker/spotify-fetch.ts's logUsage), not just endpoint/status/
-- retry count. SPEC.md's rate-limit research block asks for this before
-- Phase 6's ramp test — it's how headroom gets measured passively instead
-- of by provoking failures. Purely additive, all nullable: existing rows
-- predate these columns, and most attempts (anything that isn't a 429, or a
-- 429/200 Spotify never decorated with these headers) will leave most of
-- them NULL too.
ALTER TABLE usage_log ADD COLUMN retry_after_raw TEXT; -- raw Retry-After header (429s) — seconds, an HTTP-date, or absent
ALTER TABLE usage_log ADD COLUMN x_ratelimit_limit TEXT; -- undocumented; logged only if Spotify ever sends it
ALTER TABLE usage_log ADD COLUMN x_ratelimit_remaining TEXT;
ALTER TABLE usage_log ADD COLUMN x_ratelimit_reset TEXT;
ALTER TABLE usage_log ADD COLUMN response_date TEXT; -- the standard Date response header
ALTER TABLE usage_log ADD COLUMN quota_reason TEXT; -- 429 body's error.reason, e.g. "QUOTA_EXCEEDED" vs a plain rate limit
