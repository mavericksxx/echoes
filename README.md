# Echoes

A pixel village driven by Spotify listening. Each music genre is one Naruto
character living in its own district; Phase 1 renders the village with
hard-coded sample listening data — no Spotify connection yet. The default
view is the whole village (everyone at once); tap any character to open their
genre sidebar. See `IDEA.md` for the concept and `SPEC.md` for the full
phased build plan.

## Setup

```sh
npm install
npm run assets:sync   # copies the ripped sprite/map PNGs into public/assets/
npm run dev           # http://localhost:5173
```

`assets:sync` also runs `scripts/clean-assets.py` (Python + Pillow/numpy —
`pip install pillow numpy`) to key out ripper watermarks/border colors left
in a few of the source PNGs. It's optional: if Python or those packages
aren't available, sync still succeeds and just leaves those PNGs as-is.

Other scripts:

```sh
npm run typecheck        # tsc, frontend + worker
npm run check:data       # validates data/*.json (works without PNGs; verifies synced PNGs if present)
npm run build            # vite build -> dist/
npm run deploy           # check:data, then build, then wrangler deploy
npm run db:migrate:local   # applies migrations/*.sql to the local D1 (wrangler dev / testing)
npm run db:migrate:remote  # applies migrations/*.sql to the real remote D1
npm run spotify:connect    # one-time local PKCE login — see "Connect your Spotify account" below
npm run spotify:disconnect # deletes all stored Spotify data (refresh token + caches + usage log)
npm run gemini:smoke       # GEMINI_API_KEY=... npm run gemini:smoke — real Gemini call, run by hand only
```

## Assets are not in this repo

The sprite and map PNGs are ripped from *Naruto: Path of the Ninja* / *Path of
the Ninja 2* (Nintendo DS), via The Spriters Resource. They're copyrighted, so
they're **git-ignored and never committed** — see `.gitignore`
(`public/assets/`, and the original rip in `prototypes/konoha-demo/assets/`).

`npm run assets:sync` copies them from a local folder into `public/assets/`
(gitignored, populated at dev/build time) so Vite can serve them:

```sh
ASSETS_SRC=/path/to/your/ripped/pngs npm run assets:sync
```

If `ASSETS_SRC` is unset it defaults to the folder used while building this
app, on this machine. Without the source PNGs present somewhere, the app has
no art to load — `npm run check:data` will report exactly which files are
missing.

The Naruto art itself is fixed for this project, not a user-swappable
feature — see SPEC.md's "Art direction" section.

## Connect your Spotify account

There is no login page — visitors never authenticate, and the site always
renders from data the *owner* connected once, locally. Connecting seeds the
remote D1 with an encrypted refresh token; the Worker refreshes access
tokens itself from then on.

**1. Generate a `TOKEN_KEY` and set it as a Worker secret.** This is a
base64-encoded 256-bit AES key used to encrypt the stored refresh token
(AES-GCM via WebCrypto — see `worker/crypto.ts`). Generate one and set it:

```sh
export TOKEN_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
echo "$TOKEN_KEY" | npx wrangler secret put TOKEN_KEY
```

Keep that `TOKEN_KEY` value exported in your shell (or saved somewhere you
can re-export it) — `spotify:connect` needs the *same* value locally to
encrypt the refresh token before writing it to D1. Losing it means the
Worker can no longer decrypt the stored token (rerun `spotify:connect` to
fix that; the value itself isn't recoverable from Cloudflare after `secret
put`).

**1b. Set a `GEMINI_API_KEY` Worker secret** (Phase 3 — needed for
`/api/village`'s genre classification; a free-tier
[Google AI Studio](https://aistudio.google.com/) key is enough, since
everything runs on Flash-Lite and is cached in D1 — see SPEC.md's "AI cost
control"):

```sh
npx wrangler secret put GEMINI_API_KEY
```

**1c. (Optional) Set an `AGENT_TRIGGER_TOKEN` Worker secret** (Phase 11 —
lets you manually trigger the daily village-evolution agent instead of
waiting for the next cron tick, e.g. while testing):

```sh
npx wrangler secret put AGENT_TRIGGER_TOKEN
```

With it set, `POST /api/world/run` (header `X-Agent-Token: <that value>`,
optionally `?force=1` to bypass the once-a-day gate) runs the agent inline
and returns its result. Without it, that route always 404s.

**2. Apply the D1 schema to the remote database** (only needed once, or
after a new migration is added):

```sh
npm run db:migrate:remote
```

**3. Run the connect script:**

```sh
npm run spotify:connect
```

It prints a `https://accounts.spotify.com/authorize` URL and tries to open
it in a browser, then waits for the redirect back to
`http://127.0.0.1:8888/callback`. Log in and approve access; the script
exchanges the code, encrypts the refresh token, and writes it to the
**remote** D1 (`wrangler d1 execute --remote`).

**If the browser doing the login is on a different device** (e.g. this
machine is headless, or you'd rather log in on your phone): run the plain
command above first — it prints the URL and remembers the PKCE state
locally — open that URL wherever the browser is, log in, and copy the URL
it redirects to (it will fail to load there, since `127.0.0.1:8888` is
*this* machine, but the address bar still has the `code`). Then, back here:

```sh
npm run spotify:connect -- --code "<paste the full redirect URL here>"
```

(A bare code also works in place of the full URL.)

Once connected, the site's topbar shows a **Connected** status chip and a
**Top artists** button; if a later refresh ever fails (revoked access,
Spotify down), the chip switches to **Live paused** and visitors still see
the app, just without fresh data.

### Disconnect

```sh
npm run spotify:disconnect
```

Deletes the stored refresh token and everything derived from it
(`spotify_token`, `artist_cache`, `usage_log`, `genre_slot_map`) from the
remote D1. The site goes back to the **Not connected** state until
`spotify:connect` runs again.

## Architecture (Phase 1–2)

- **Frontend** — Vite + TypeScript (strict), plain canvas 2D (no PixiJS).
  `src/main.ts` wires together the whole-village view (default), the
  single-district view, and the all-characters roster on top of `src/npc.ts`
  (wander/perform state machine), `src/render.ts` (image loading + sprite
  drawing), and `src/recolor.ts` (pre-baked district recolors). The camera
  (integer-zoom canvas backing store + `ctx.translate`) lives in `main.ts`
  alongside pointer drag-pan/tap and keyboard pan/navigation.
- **Sidebar** — `src/sidebar.ts` renders the genre panel opened by tapping a
  character (a right-side panel on desktop, a full-height sheet on phone) as
  plain DOM. Its sections are data-driven (`SECTIONS: {id, label, render}[]`)
  so later phases add tabs without restructuring it. `src/cover-art.ts`
  generates the placeholder gradient shown in a song row until Phase 2 fills
  in real Spotify artwork.
- **Data** — the prototype's hard-coded sprite/map arrays live in
  `data/*.json` (`characters.json`, `districts.json`, `village.json`,
  `assets.json`), typed by `data/types.ts` and joined by `data/loader.ts`.
  This is internal data organization, not a user-facing sprite-swap feature.
  `npm run check:data` (ported from `prototypes/konoha-demo/verify.js`) has a
  data-only tier that needs no PNGs (safe in CI) and a local-only tier that
  verifies the synced PNGs' real dimensions when present.
- **Worker** — `worker/index.ts` + `wrangler.jsonc` serve the Vite build as
  Cloudflare Workers static assets and expose `/api/health` and (Phase 2)
  `/api/top-artists`. Gemini calls land in a later phase.
- **Sample data** — `src/sample-data.ts` hard-codes a per-slot play share and
  a song list (with fake plays/lastPlayed), shown in the sidebar and used to
  weight which character performs next in the whole-village view. It keeps
  driving the village itself through Phase 2 — real per-genre listening data
  replaces it in Phase 3; Phase 2 only adds the standalone top-artists panel.
- **Auth & tokens (Phase 2)** — `worker/crypto.ts` (AES-GCM via WebCrypto)
  and `scripts/spotify-crypto.mjs` implement the *same* encryption scheme
  (documented inline in both files) so a refresh token encrypted by
  `spotify-connect.mjs` can be decrypted by the Worker. `worker/token.ts`
  loads + decrypts the stored refresh token, exchanges it for an access
  token, caches that in memory until ~60s before expiry, and persists a
  rotated refresh token back to D1 when Spotify issues one.
  `worker/spotify-fetch.ts` is the only thing allowed to call
  `api.spotify.com`: it honors `Retry-After` on 429s, backs off
  exponentially with jitter on 429/5xx (up to 4 retries), and logs every
  real HTTP attempt to `usage_log`.
- **`GET /api/top-artists?range=...`** (`worker/top-artists.ts`) returns only
  derived fields (id, name, genres, image, rank) — never a raw Spotify
  payload — cached ~30 min via the Workers Cache API. Not connected or a
  failed refresh both come back as a plain `200` with a `connected`/`live`
  flag rather than an error, so the UI can show a clear state.
- **Top artists panel + status chip** (`src/top-artists.ts`) — a small
  floating panel (topbar "Top artists" button, hidden until connected) with
  a range switcher (Recent / 6 months / All time), plus a `connected` /
  `Sample data` / `Live paused` status chip in the topbar. Independent of
  the genre sidebar's Overview/Songs/Artists tabs, which still run on
  `src/sample-data.ts` until Phase 3.
- **D1** (`migrations/0001_init.sql`) — `spotify_token` (single row, the
  encrypted refresh token), `artist_cache` (per-artist metadata, populated
  starting Phase 3), and `usage_log` (one row per real Spotify HTTP call:
  endpoint, status, 429 count, timestamp — used for the Phase 6 rate-limit
  test). `npm run db:migrate:local` / `db:migrate:remote` apply it.

## Architecture (Phase 3 additions)

- **Genre resolution** (`worker/genre-resolution.ts` + `worker/gemini.ts`) —
  for each top artist: reuse `artist_cache` if already resolved; else, if
  Spotify gave genres, resolve each genre string via `genre_slot_map`
  (itself cached per genre string, one batched Gemini Flash-Lite call for
  whatever's still unseen); else (the common case for this account — Spotify
  returns empty `genres` here) batch the artist *names* straight to Gemini.
  Every real classification is written back to D1 so a given artist or
  genre string only ever costs one Gemini call, ever. Only artist
  names/genre strings/counts are ever sent to Gemini — never a raw Spotify
  payload, user id, or token (SPEC.md's AI policy). Pinned model:
  `gemini-3.5-flash-lite`, called via a plain `fetch` to the REST
  `generateContent` endpoint (not the `@google/genai` SDK — see CHANGELOG's
  Phase 3 fix pass). `resolveArtistSlots` never throws: a Gemini call
  failure degrades to the same deterministic fallback slot as a quota cap
  and is reported via `/api/village`'s `geminiError` (distinct from
  `geminiLimited`), so a Gemini outage never breaks the endpoint. The
  response parser checks every documented step of Gemini's shape explicitly
  (`promptFeedback.blockReason`, `candidates[0]`, `finishReason !== "STOP"`,
  `content.parts`) rather than defaulting silently through optional
  chaining, so any mismatch throws with the HTTP status and a body snippet
  — self-explanatory from `geminiError` alone. `npm run gemini:smoke`
  (`scripts/gemini-smoke.mjs`) exercises the exact same request/response
  shape by hand, outside the Worker, for whenever the prompt/schema/model
  changes.
- **`GET /api/village`** (`worker/village.ts`) — the derived world: every
  roster slot's activity level (dormant/quiet/active/festival, from its
  share of a rank-derived score across up to 50 top artists), share %, and
  its real artists (ordered highest-scoring first). Artists present in the
  long_term baseline but missing from the requested range come back with
  `faded: true` instead of being dropped. Cached ~30 min via the Workers
  Cache API, same pattern as `/api/top-artists`; `{connected:false}` with no
  token, a "live paused" dormant payload if a live Spotify/token call fails.
- **Rate limiting** (`worker/rate-limit.ts`) — a fixed-window per-IP counter
  **in D1** (`rate_limit_window`), applied centrally in `worker/index.ts`
  before any route runs, stricter on `/api/village` (the only Gemini-
  touching endpoint) than `/api/health`/`/api/top-artists`. Chose D1 over the
  Cache API so counts are exact and inspectable with
  `wrangler d1 execute --local` rather than best-effort per-colo; the
  tradeoff (rows accumulate over time) is swept opportunistically on a
  random sample of requests rather than needing a dedicated cron. Separately,
  a **daily Gemini cap** (global + per-IP, counted from `usage_log` rows
  logged as `gemini:genres`/`gemini:artists`) hard-stops Gemini calls; once
  hit, genre resolution falls back to a deterministic (not Gemini, not
  persisted) nearest-slot guess and `/api/village` reports `geminiLimited: true`.
- **`src/listening-source.ts`** — the one place that picks between
  `/api/village`'s real data and `src/sample-data.ts`'s fallback, split by
  sidebar tab: Overview/Artists switch to real artists + activity once
  connected and live; Songs (no per-track fetch yet) and "now playing" (real
  currently-playing polling is Phase 5) stay sample-only regardless. The
  topbar status chip says **Sample data** / **Connected** / **Live paused**
  accordingly.
- **District "activity treatment"** (`src/residents.ts`'s
  `drawActivityTreatment`, driven by `shared/activity.ts`'s
  `ACTIVITY_TREATMENT`) — entering a district shows its activity level, not
  just its sidebar: a dormant/quiet district gets a dim wash, an
  active/festival one gets extra background villagers (festival also gets a
  bunting overlay), and the leader's spontaneous "vibing" chance scales with
  the level. A resident whose artist dropped out of the current range (vs.
  the long_term baseline) renders faded and stands still instead of
  wandering — placement otherwise puts the highest-scoring resident closest
  to the leader and lower-scoring ones further out.
