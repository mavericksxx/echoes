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
(`spotify_token`, `artist_cache`, `usage_log`) from the remote D1. The site
goes back to the **Not connected** state until `spotify:connect` runs again.

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
  `not connected` / `live paused` status chip in the topbar. Independent of
  the genre sidebar's Overview/Songs/Artists tabs, which still run on
  `src/sample-data.ts` until Phase 3.
- **D1** (`migrations/0001_init.sql`) — `spotify_token` (single row, the
  encrypted refresh token), `artist_cache` (per-artist metadata, populated
  starting Phase 3), and `usage_log` (one row per real Spotify HTTP call:
  endpoint, status, 429 count, timestamp — used for the Phase 6 rate-limit
  test). `npm run db:migrate:local` / `db:migrate:remote` apply it.
