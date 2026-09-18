# Echoes (working name; formerly spotify-pixel-town)

See `IDEA.md` for the concept. This spec breaks the build into **vertical slices**: every phase ships something you can open and see working end to end (data → logic → AI → pixels). No "backend-only" or "AI-only" phases.

**Rule for every phase:** it ends with a runnable demo and a short "what you'll see" check. If a phase can't be demoed, it's scoped wrong.

## Spotify API constraints (researched 2026-09)
- **Feb 2026 Dev Mode rules:** app owner needs active Premium; max 5 users. Owner has Premium Student (confirmed 2026-09-15).
- **Storage:** no databases of Spotify content. Store track/artist **IDs + derived counts** only; names/art ride live, inline in the derived `/api/village` payload (built fresh from `/me/top/artists` and `/me/top/tracks` each cache miss) and live only in that 30-minute `caches.default` entry — never written to D1. **Correction (Phase 3.5, 2026-09-17):** the original plan here ("fetch names/art live via the batch `/tracks` endpoint") is stale — Spotify removed the batch `GET /tracks`, `/artists`, and `/albums` endpoints in Feb 2026. See this file's Phase 3.5 section. Delete everything within 5 days of disconnect.
- **Dev Mode forever:** max 5 allowlisted users; Extended Quota needs 250k+ MAU. Fine for personal use; public sharing = images/read-only views, not logins.
- **Redirect URI:** `localhost` is banned — use `http://127.0.0.1:PORT/callback`.
- **Artist `genres` is deprecated and often empty.** Genre source = Spotify genres when present → Last.fm/MusicBrainz tags → LLM inference from artist name. Clustering runs on this merged tag set.
- **Storage policy:** no indefinite storage of raw Spotify Content. Persist only *derived* stats (play counts, district tallies, snapshots of our own world state); expire raw API responses; delete all on disconnect.
- **AI policy:** training ML models on Spotify Content is banned. We only do inference with off-the-shelf models, never fine-tune; send minimal fields (artist names, tags, counts).
- **Rate limits:** undocumented (rolling 30s window, Dev Mode lower than Extended). Always honor 429 `Retry-After` with exponential backoff.
- **[researched 2026-09-18]** Spotify has **never published a number** for Dev Mode limits, before or
  after Feb 2026 — treat any specific figure found online as folklore. What is documented:
  - **Two separate mechanisms.** The rolling-30s **rate limit** is *app-wide* (per Client ID). A
    distinct Dev Mode **quota** returns 429 with `"reason": "QUOTA_EXCEEDED"`, and since
    **2026-07-23** is counted **per developer account**, pooled across up to 25 Client IDs. Any other
    Dev Mode app on the same Spotify account shares Echoes' quota.
  - **The downside is asymmetric.** Post-Feb-2026 reports show `Retry-After` ranging from seconds to
    **13–18 hours**, sometimes absent entirely. Because the limit is app-wide, one bad 429 takes down
    the whole site's data, not just the polling feature. This is the reason to poll conservatively.
  - **Field norm for currently-playing polling is 5–30s, skewed slow.** Home Assistant's Spotify
    integration defaults to 30s; PresenceJam-Desktop defaults to 30s with a 5s floor; spotify-player
    is event-driven. A flat 5s is the aggressive end of what real 2026 projects run.
  - **[decided]** Phase 5a polls **~10s while playing** with **track-end skip-ahead** (use
    `progress_ms`/`duration_ms` to sleep until the track is about to end rather than polling blind),
    15s idle. Fall back to 15–30s if `usage_log` shows any 429s.
  - No evidence `/me/player/*` is metered separately. `X-RateLimit-*` headers are undocumented and
    unconfirmed — log them if present, don't rely on them.
- **Log headers, not just status.** `spotifyGet` currently records endpoint/status/retry count and
  discards response headers and bodies. Capture `Retry-After` raw, any `X-RateLimit-*`, the `Date`
  header, and a 429 body's `error.reason`. This is how we measure headroom passively instead of by
  provoking failures — do this before Phase 6's ramp test.
- **Live listening:** no push/webhooks — polling only. App open: `currently-playing` every ~5s while playing, 15s when paused/idle. App closed: Worker cron pulls `recently-played` (50-item cap) every 15–30 min to backfill history. Intervals are provisional until the rate-limit test below.

## Stack (proposed)
- **Frontend:** TypeScript + Vite, PixiJS for tile/sprite rendering.
- **Backend:** Cloudflare Worker (LLM proxy, agent runs, cron) + D1 (SQLite) for history and cached AI output.
- **Auth:** Spotify Authorization Code + PKCE.
- **LLM:** Gemini via a plain `fetch` to the REST `generateContent` endpoint in the Worker — **not**
  the `@google/genai` SDK (tried first, matching the portfolio site's Cloudflare backend; it threw
  in production with no useful `wrangler tail` output, almost certainly a `workerd`-vs-Node API gap
  that a raw `fetch` has no surface for — see CHANGELOG's Phase 3 fix pass). **Flash-Lite everywhere
  by default** (user decision 2026-09-17: far higher free-tier daily request limits, same as their
  other projects) — tagging, captions, weekly brief, and agent tool-calling. Only escalate a
  specific feature to Flash if Flash-Lite demonstrably can't do it, and say why. Pin exact model IDs
  at build time.

## Art direction (decided 2026-09-15)
- **Naruto: Path of the Ninja 1/2 (DS) sprites** — chosen over free packs (LPC, Ninja Adventure, Kenney) after side-by-side demos.
- **Genres are characters.** Each genre district = one Naruto character in one Naruto location. Artists appear as buildings/captions/info inside their genre's district.
- Roster (17): Hip-Hop=Naruto, Pop=Sakura, R&B=Neji, Rock/Metal=Rock Lee, Lo-fi=Shikamaru, Emo/Alt=Gaara, Darkwave=Sasuke (CS2 form only), Electronic=Kakashi, Punk=Kiba, Folk=Hinata, Ambient=Shino, Jazz=Guy, Indie=Ino, Soul/Funk=Choji, Latin=Tenten, Classical=Temari, Metalcore=Kankuro. Each has walk (4-dir, some mirrored), idle, 2 special poses.
- **Locations:** 8 real same-scale maps (Konoha village ×2 halves, Hidden Leaf Forest, Academy dojo, Hokage Monument yard, Hospital yard, Ichiraku interior, house interior). Remaining districts recolor Konoha. No usable Suna/Forest of Death/Valley of the End rips exist.
- Views: single district, all-characters roster, whole village (all characters on the Konoha map).
- Reference prototype: `prototypes/konoha-demo/` (open `index.html`; frame rects in `main.js`, checks in `verify.js`). Private preview: https://claude.ai/artifact/U1MS16iBHvtG5BTJPvVzsR
- **Licensing:** ripped assets are copyrighted — git-ignored, never committed to the public repo. The Naruto art is fixed — not a user-swappable feature. Public showcase = screenshots/video only.

## Foundations (before / during Phase 1)
Status legend: **[decided]** locked in · **[default]** proposed, revisit if needed · **[open]** needs a decision.

### Setup
- **[decided]** Spotify developer app with one redirect URI: `http://127.0.0.1:PORT/callback` (used only by the local connect script).
- **[decided]** Gemini API key, stored only as a Worker secret.
- **[decided]** Cloudflare account: Worker + D1 + cron.
- **[decided]** `git init` + public GitHub repo; `CHANGELOG.md` and `BACKLOG.md` kept current.

### Hosting
- **[decided]** Deployed publicly (Cloudflare Worker + static frontend), no Cloudflare Access gate — it's a personal app only the owner uses.
- **[decided]** No owner check on the Worker API. Abuse protection = rate limits instead: per-IP limits on every endpoint (Cloudflare rate limiting / Worker counter), a stricter per-IP + global daily cap on any endpoint that triggers a Gemini call, and Spotify-calling endpoints served from the Worker's cache so visitors can't burn the Spotify quota.
- **[decided]** Gemini free-tier key. Our use is inference only (listening insights), never training. Minimize exposure: send only derived fields (artist names, genre tags, counts), never raw Spotify payloads, user IDs, or tokens.
- **[default]** Ripped assets stay out of the public git repo (avoids DMCA takedown of the repo); uploaded to the deployment from a local folder or R2 at deploy time.
- **[decided]** URL: `https://echoes.parthkohale.com` (Worker custom domain; zone already on Cloudflare).
- **[decided]** Deployed from Phase 1 onward; every phase ends with a deploy to the same URL so it can be checked from a phone. Local `wrangler dev` + Vite still used while building.

### Auth & tokens
- **[decided]** Visitors never log in, and there is **no public connect page**. The owner runs `npm run spotify:connect` locally: PKCE login against `http://127.0.0.1:PORT/callback`, then the script writes the encrypted refresh token straight into the remote D1 (`wrangler d1 execute --remote`). The Worker refreshes access tokens automatically and saves the rotated refresh token each time. Refresh tokens don't expire on their own — only revoking access, changing password, or losing Premium breaks it; fix = rerun the script.
- **[decided]** The site never depends on a live token: it always renders from D1 (last known village + songs). If refresh fails, visitors still see the village with a subtle "live updates paused" state; the owner gets a notice (email/log) to reconnect.

### Data model (D1, derived data only)
- **[default]** Tables: `genre_slot_map` (raw genre/tag → one of the 17 slots, with source + confidence), `artist_cache` (artist id → slot, mood/energy, NPC text; TTL), `daily_snapshot` (rolled up from `play_event` + top-items per time range), `play_event` (derived: timestamp, artist id, slot; **source of truth**), `world_state` (current district states), `agent_event` (evolution-agent actions, reasoning, before/after diff), `llm_cache` (prompt hash → output), `usage_log` (Spotify requests + 429s, Gemini tokens/cost). **Correction (Phase 8a, 2026-09-18):** `play_event` as actually built has no `slot` column — see Phase 8's section below for why (a slot is a re-classifiable inference, not a fact about a play). It also adds `track_cache` (not listed here originally), for reasons also covered there. **Correction (Phase 8b, 2026-09-18):** `daily_snapshot` was never built — `worker/history-query.ts`'s `slotPlaysBetween` and `worker/history-daily.ts` query `play_event` joined to `artist_cache` live, at request time, instead of maintaining a rollup table. See Phase 8's section below for why.
- **[decided]** Disconnect deletes every row + the refresh token.

### Sprite & map data
- **[decided]** Character frame rects and animations move out of `main.js` into internal JSON data files with a loader and validation script (like `verify.js`). Internal organization only — not a user-facing sprite-swap feature.
- **[open]** **Walkable areas:** each map gets a walkability grid (hand-painted collision mask per map, likely a small PNG or tile grid) + pathfinding (A*) so characters never walk on roofs/walls. Needed before whole-village view ships.

### Genre fitting
- **[decided]** Fixed 17 genre slots (the roster). Gemini maps each raw Spotify genre / Last.fm tag → nearest slot, cached in `genre_slot_map`.
- **[default]** Unused slot (no listening) → district exists but is quiet/faded, character idles alone. Low-confidence or unmappable genres → nearest slot by similarity; truly unfit artists are "visitors" in the whole-village view.
- **[open]** Overlapping slots (Rock/Metal vs Metalcore; Emo/Alt vs Indie vs Punk): define each slot with example genres/tags in the mapping prompt, and revisit merging slots if mapping is ambiguous in practice.
- **[open]** Whether heavy sub-genre listening (e.g. lots of drill inside Hip-Hop) should show inside a district (e.g. a variant, prop, or crowd) rather than adding slots.

### What growth means (maps are fixed size)
- **[default]** A district can't physically grow, so listening share maps to an **activity level** per slot (dormant → quiet → active → festival): character walk speed and performance frequency, district lighting/saturation, festival props, and crowds of background villagers. Dormant slots are faded and still.
- **[decided]** Most listeners concentrate in ~4 slots, so most districts will usually be dormant. Accepted: the whole-village view highlights active districts; dormant ones stay visible but quiet.

### Where artists appear
- **[decided 2026-09-17]** Artists appear as **resident NPCs inside their genre's district** (Phase 2.5), listed in the sidebar too. Superseded option list below kept for context.
- **[superseded]** Characters are genres, so artists need a representation. Candidates: (a) signs/banners on district buildings named after top artists, (b) "now playing" caption + info card list, (c) small generic background NPCs (Konoha villager sprites) per top artist. Naruto rips have no standalone building sprites, so (a) means labeling existing map buildings. Default: (b) from Phase 3; evaluate (a)/(c) in Phase 7.

### Empty & edge states
- **[default]** New/low-history account → build the town from `short_term` top artists and show an onboarding note; nothing playing → idle town, polling slows; private session / no data returned → "listening privately" state; podcasts/audiobooks → ignored; artist with no genre → Last.fm → Gemini inference → nearest slot; Spotify down or token revoked → last known town + "live paused" state for visitors, reconnect notice for the owner only.

### AI cost control
- **[default]** Monthly Gemini budget cap enforced in the Worker via `usage_log` (hard stop + fall back to cached/template text). Limits: genre mapping only for new genres; artist tagging once per artist; captions cached per artist+song; weekly brief 1/week; Mayor chat rate-limited per day; evolution agent at most 1 run/day.

### Testing
- **[decided]** Unit tests: genre → slot mapping, snapshot diffs, district sizing, backoff wrapper.
- **[decided]** Rate-limit test (Phase 6).
- **[default]** AI steps tested against saved fixture inputs with schema validation of outputs (and snapshot-reviewed text), no live calls in CI.
- **[default]** Sprite/map data validation script runs in CI (frames in bounds, all assets referenced exist, spawn points walkable).

### Docs
- **[decided]** README: setup, architecture, and agent design write-up for the portfolio; screenshots/video instead of hosted assets.

---

## Phases
Each phase is sized to be built in **one prompt**: one visible outcome, a handful of files, no more than one new system. If a phase grows during building, split it rather than stretching it.

### Phase 1 — Village on screen (no Spotify yet)
- Vite + TypeScript scaffold, Worker scaffold (`wrangler dev`), repo + changelog/backlog.
- First public deploy (Worker + static assets); ripped assets uploaded at deploy, not in git.
- Move demo sprite/map data into JSON + loader + validation script; port the renderer (district view + whole-village view) using **hard-coded sample listening data**.

- Tapping any character opens the **genre sidebar** (desktop right panel / phone slide-up sheet) with sections: Overview, Songs (filter by artist/album, search, sort), Artists — on sample data. Sections are data-driven so later phases add tabs.

**You'll see:** the Konoha village live at a real URL, driven by fake data.

### Phase 2 — Log in and see your real top artists
- Local `npm run spotify:connect` script (PKCE on `127.0.0.1`) seeds the refresh token into remote D1; Worker auto-refreshes. No login UI on the site; visitors see data without logging in.
- Rate-aware Spotify wrapper (429 handling, backoff, request log).
- Fetch top artists (medium_term); show them in a simple in-game panel.

- Sidebar Songs/Overview switch to real data with **cover art** (researched 2026-09-15, allowed): `album.images` from top-tracks / recently-played / currently-playing, hotlinked from `i.scdn.co` (never re-hosted), unmodified (no crop/filter/overlay), 4px/8px rounded corners, each row links to `external_urls.spotify`, official Spotify logo ≥70px in the sidebar, our own visual style (not a Spotify look-alike). CSP `img-src https://i.scdn.co`.
- Optional: official Spotify embed for the now-playing row.

**You'll see:** log in → your real top artists listed inside the village UI.

### Phase 2.5 — One village, doors into districts
- Crop the unused interior rips (`raw/konoha_shops_589804.png` 6 shops, `raw/konoha_houses_589805.png` 6 houses) so the 10 recolored slots get **real interiors** instead of a tinted copy of the town map.
- Scene stack + fade transition: village map ⇄ district map. Entering is explicit — an "Enter district" button in the sidebar header, never a bare tap. Back button, Esc, browser back (history.pushState), and zoom-out below min all exit.
- Each slot gets a `door` position on the village map (on/near the matching building where one exists).
- Resident NPCs inside a district: the genre character as leader + 3–4 residents from `raw/hiddenleafninja_79019.png` (4 generic rigs, 41×41 grid, key color 128,184,248), name label via the existing caption layer. Tapping a resident opens the sidebar for that artist. Sample data for now.
- Add horizontal sprite mirroring to the renderer (generic rigs have only one side pose).
- Remove the Village / Districts / Roster view switch.
- **Check early:** one shop interior + leader + 4 labeled residents at 390px. If cramped, use the larger house interiors for active slots or cap residents at 3.

**You'll see:** one village you move through — walk up to a door, enter a genre's place, and find that genre's artists living there.

### Phase 3 — Your genres become characters
- **Deviation (built 2026-09-17):** no Last.fm API key exists, so the genre gap-fill chain is
  Spotify genres → (if empty) Gemini inference from the artist name directly — Last.fm/MusicBrainz
  tags are skipped entirely, not just deprioritized. In practice this account's artists come back
  with **empty `genres` from Spotify** (see "Spotify API constraints" above), so almost all
  classification is Gemini-from-name rather than Gemini-from-tags.
- Gemini call (Flash-Lite) mapping genres/tags → the 17 slots, cached in D1 `genre_slot_map`; Gemini inference for artists with no tags.
- Rate limits land with the first Gemini call: per-IP on every endpoint, Gemini per-IP + global daily cap, Spotify-backed endpoints served from cache.
- Replace sample data: each slot's **activity level** from your listening share; your top artists per slot become that district's residents and fill the sidebar.
- **The room says what the panel can't:** resident placement encodes play count (most-played stands centre/front, rarer ones at the edges), a faded/absent resident for an artist you've stopped playing, and the room's light/props/crowd follow the activity level. Entering a district must tell you something at a glance, not just re-show the sidebar.

**You'll see:** the village reflects your actual taste — busy districts for what you play, quiet ones for what you don't.

### Phase 3.5 — Songs tab goes real (built 2026-09-17)
- **Why a half-phase:** Phase 3 shipped Overview/Artists on real data but left Songs on
  `src/sample-data.ts` (SPEC.md's Phase 3 bullet explicitly deferred it — "tracks are a later
  phase"). This closes that gap without waiting for a full phase slot.
- `worker/tracks.ts` fetches **only** `GET /me/top/tracks?limit=50&time_range=<range>` through the
  existing rate-aware `spotifyGet`. No `/me/player/recently-played` (Phase 8 work) and no batch
  `GET /tracks`/`/artists`/`/albums` (removed by Spotify Feb 2026 — see "Spotify API constraints").
- **Bucketing, not classification:** a track is placed in a slot only if its *primary* artist
  already has a resolved slot from the Phase 3 artist pipeline (the current-range top 50 ∪
  long_term baseline union `worker/village.ts` already resolves). A track whose primary artist
  isn't a known resident is dropped — never a fresh Gemini call, never a new `artist_cache` row, so
  this costs **zero** additional AI usage. A resident with no top-50 track just gets an empty Songs
  tab ("No top tracks in this range"), never a widened fetch.
- `/api/village`'s existing payload grows a 4th field per slot, `songs[]`, built in a 4th
  `handleVillage` stage with its own try/catch: a top-tracks failure sets a top-level
  `songsLive: false` and leaves every slot's `songs: []`, but still returns the *real* village
  (artists/activity) rather than falling back to `pausedPayload` — the village is the product,
  songs are one tab. No new endpoint (`getSongs()` is called synchronously during DOM build) and no
  new D1 table — track titles/art are Spotify Content and live only in the existing 30-minute
  `caches.default` village entry.
- **No fabricated play counts.** Spotify's top-tracks endpoint gives rank, not plays or a
  timestamp — `Song.plays` and `Song.lastPlayed` are now optional, the Songs tab hides both when
  absent, and the default sort is relabeled "Top tracks" (rank order) with "Recently played" pulled
  from the sort options entirely when live (not just a no-op).
- **Bug fixed in the same change:** the Songs tab's artist filter compared `song.artist` (a
  display string, comma-joined for features) by exact equality, so a resident-tap filter would make
  every song where that artist is a feature (not the primary credit) silently vanish. Real songs now
  carry `artistIds: string[]` (every artist on the track) and the filter matches by membership.
- Cover art follows the same Phase 2 rules (hotlinked `i.scdn.co`, unmodified, 4px/8px corners,
  each row links to `external_urls.spotify`), a `Content-Security-Policy: img-src` on the HTML shell
  (see the fix pass below for where this actually lives), and the official Spotify logo asset
  (`public/brand/spotify-logo-white.png`, downloaded from Spotify's press asset bucket) in the
  sidebar footer, ≥70px wide.

**You'll see:** the Songs tab lists your actual top tracks per district, with real cover art, ranked
instead of a fake play count, and tapping a featured artist's row no longer empties the list.

**Fix pass (2026-09-17, before this shipped to production):**
- **The CSP never fired.** `worker/index.ts` set `Content-Security-Policy` on the `env.ASSETS.fetch()`
  result inside the Worker's `fetch` handler, but `wrangler.jsonc`'s `assets` config has no
  `run_worker_first`: a request for `/` matches a real file in `./dist` and is served straight off
  Cloudflare's static-asset layer *before the Worker is invoked at all* — that code path was dead
  except on the asset-not-found fallthrough. Moved to `public/_headers` (Vite copies `public/` into
  `dist/` verbatim; Workers Static Assets honors `_headers` at the same asset layer that was
  bypassing the Worker), and the dead block removed from `worker/index.ts` rather than left as a
  second, non-functional mechanism.
- **The Songs artist filter could strand the user.** `matchesArtistFilter` itself was correct, but
  on real data the filter *value* is an artist id (set by tapping a resident or artist row) while the
  Songs tab's own "Filter by artist" `<select>` only ever offered display-string options built from
  `song.artist` — the id was never among them, so the control silently reset its displayed selection
  to "All artists" while the list stayed filtered, and — because the control's value was already
  `""` at that point — picking "All artists" fired no `change` event, so there was no way to clear
  the filter from the UI at all. Fixed by inserting a synthetic `<option>` (id as value, the artist's
  real display name as label) whenever the active filter isn't among the built-in options; it's
  rebuilt fresh on every render, so it never accumulates or survives a district switch.
- **A deploy could silently ship a village with no sprites.** `public/assets/` (the ripped Naruto
  PNGs) is gitignored/local-only; `npm run deploy` chains `check:data` (which populates and validates
  it) before `build` and `wrangler deploy`, but `wrangler deploy` run directly skips all of that — and
  did, once, in production. `npm run check:data`'s local-PNG tier is also deliberately *soft* (skipped,
  not failed, when the rip isn't present, so CI stays green without it) and only ever looks at
  `public/assets/`, never the `dist/` output that actually gets uploaded. Added
  `scripts/check-dist-assets.mjs` — a fast, existence-only check of `dist/assets/` against
  `data/assets.json` — wired into `wrangler.jsonc`'s `build.command`, which Wrangler runs before
  bundling on *every* `wrangler dev`/`wrangler deploy`, including a bare `wrangler deploy` with no
  npm script in the loop. A non-zero exit from `build.command` aborts the deploy. This only catches
  missing files, not wrong/corrupt ones — pixel-level validation stays `check:data`'s job, run
  locally before a build.
- Also fixed, from direct user feedback on the live site: the shared `--color-glass` token (0.55
  alpha) read as frosted glass over a dark district interior but washed out over the bright village
  map. Added `--color-glass-panel` (same hue, 0.82 alpha) for the two text-dense surfaces that float
  over the map (sidebar, top-artists panel) only, plus `blur(30px) saturate(140%)` and a faint
  top-down highlight so the effect reads as diffusing glass rather than fog or an opaque slab. The
  lighter chrome (topbar, village caption, zoom controls) keeps the original token.

### Phase 4 — Characters walk properly
- Walkability grid per map + A* pathfinding; spawn points validated in the data check.

**You'll see:** characters wander naturally, no walking on roofs or through walls.

### Phase 4.5 — Camera feels right
- **Mobile can't zoom out (bug).** `ZOOM_MIN = 1` plus `fitZoom = Math.floor(min(availW/mapW,
  availH/mapH))` (src/main.ts:277,300) means a 390px-wide phone viewport against the 767px town map
  computes `floor(0.51) = 0`, clamped up to 1 — so the camera is pinned at 1:1 and shows a vertical
  strip. The floor of a sub-1 ratio is always 0, so the map can never fit on a phone. Fix: allow
  fractional zoom below 1, with the minimum being a true fit-to-screen.
- **Stepped zoom feels janky.** **[decided 2026-09-18]** Keep settling on integer zoom levels (the
  existing "never a fractional scale" rule at src/main.ts:331 is what keeps pixel art crisp — at a
  fractional scale some source pixels get 2 screen px and some get 1, which shimmers), but animate
  between levels over ~200ms with easing. Smooth to use, crisp at rest. Rejected fully-continuous
  zoom for that shimmer, and a phone/desktop split for the divergent feel.

- **Village caption is oversized on phone (2026-09-18).** "Drag to look around Konoha. Tap anyone to
  see their genre." wraps to two lines and takes a band off the top of the map, and it never goes
  away. Shrink it and dismiss it after a few seconds or on first interaction — it's a one-time hint.
- **Topbar glass reads muddy over the map art.** The sidebar and top-artists panel got
  `--color-glass-panel` in the Phase 3.5 fix pass; the topbar kept the lighter `--color-glass`, which
  goes blotchy over the village's greens and browns. Give it the heavier treatment.

**You'll see:** zoom glides instead of jumping, the whole village fits on a phone screen, and the
map isn't covered by chrome.

### Phase 5 — Live reactions
- Split into 5a and 5b; 5a is the user-visible half and ships first.
- **5a — Now-playing widget.** Poll currently-playing (**~10s playing / 15s idle**, see the
  rate-limit findings below) through the
  wrapper, and show it top-right as a **display-only** card: cover art, title, artist. **No transport
  controls** — the user explicitly asked for a view, not a player (2026-09-18). Hides when nothing
  is playing. Spotify attribution rules apply as in Phase 3.5 (unmodified art, links out, logo).
- **5b — Village reactions.** Uses the same poll.
- Now-playing song → its slot's character walks to their spot + special pose + caption (template text, no AI yet).

**You'll see:** play a song on Spotify → the right character reacts within seconds.

### Phase 6 — Rate-limit test
- Scripted ramp test (10s → 5s → 3s → 2s on currently-playing + concurrent top/artists calls), log every 429 + `Retry-After`, find fastest zero-429 interval over ~30 min, verify recovery after a forced 429.
- Set production intervals at ≥2× the safe interval; record results in this spec.

**You'll see:** a small results report and tuned polling in the app.

**Results (passive audit, 2026-09-19):** the ramp test above was deliberately **not run** — a single
429 can carry a `Retry-After` of 13–18 hours app-wide (see the rate-limit research above), so
provoking one to find a ceiling costs up to a day of live data to save seconds of latency. Instead
`usage_log` (migration `0003_usage_log_headers.sql`) was queried read-only over ~37h of real traffic
(2026-09-17T09:19Z → 2026-09-18T22:30Z, 173 Spotify requests):

| Metric | Result |
|---|---|
| 429s / 5xx | 0 / 0 |
| `X-RateLimit-*` ever non-null | 0 — Spotify never sends them to this app |
| Peak app-wide rate | 10 req/30s, 15 req/60s (one page-load burst: now-playing + 7 top-items calls in ~1.5s) |
| Peak per endpoint | ≤5 req/60s |
| `currently-playing` cadence | 10.7–10.9s while playing |
| `recently-played` cron | 15.0 min, 35/35 runs; ban pre-check never blocked |

**Decision:** keep ~10s playing / 15s idle / 15-min cron. The true ceiling stays unmeasured by
design. Revisit only if `usage_log` shows a real 429 (then fall back to 15–30s).

### Phase 7 — Moods and personalities
- Gemini mood/energy tagging per artist (cached) → district tint/lighting + character walk speed/performance frequency.
- Per-slot personality + dialogue lines flavored by your top artists (cached); shown in the info card.
- AI live captions replace the template captions (cached per artist+song).

- Sidebar gains a **Character** section (personality + dialogue).

**Phase 7c (built 2026-09-19):** AI live captions. Rides the existing `/api/now-playing`
poll instead of a separate endpoint — that handler already resolves the track's slot from
`artist_cache` on every refresh of its own ~10s shared cache, at zero extra Spotify calls, so
adding one more D1 read/write there costs nothing extra either. New migration `0008_caption_cache.sql`
(`caption_cache`, keyed by artist id + track id) caches a few short in-world lines per track
**forever**, generated at most once ever per (artist, track) pair — not once per poll, and not
even once per replay of the same track — via a new `worker/captions.ts` (prompt: artist name,
track name, slot genre only; the actual Gemini call lives in `worker/gemini.ts`, which stays the
only file allowed to call Gemini). Respects the existing Gemini daily cap
(`geminiQuotaAvailable`); quota exhausted, a Gemini failure, or no cache row yet all degrade to
`caption: null`, never a 500 — the frontend (`src/npc.ts`, `src/main.ts`) falls back to its
existing template caption exactly as before whenever that's null, live or sample-data alike.

**You'll see:** districts feel different by mood; characters talk about your music.

### Phase 8 — The village remembers
- Split into 8a and 8b; both built (8a 2026-09-18, 8b 2026-09-18).
- **8a — The play-event log starts.** Worker cron (`worker/history.ts`, wired to `wrangler.jsonc`'s
  `triggers.crons`) polls `GET /me/player/recently-played?limit=50` every 15 min, checks for an
  active 429 ban before ever calling Spotify (reads the newest `usage_log` row with `status = 429`;
  SPEC.md's rate-limit research records `Retry-After` values up to 13–18 hours, app-wide, since the
  cron runs with nobody watching), and appends new plays to `play_event` via a single `env.DB.batch()`
  of `INSERT OR IGNORE` statements — 45-50 ignored duplicates per run is fine and expected.
  `track_cache`/`artist_cache` get seeded for free from each item's inline data, at zero extra
  Spotify calls. `/api/history/stats` + a small "Collecting since ... · N plays logged" readout
  (`src/history-stats.ts`) are the only visible surface — no rollups, no activity levels driven by
  history, no sidebar History section, no era toggle. Those are 8b, built on the rows 8a starts
  collecting today. Every day this isn't running is a day of data Phase 8.5's Wrapped can never
  recover — see that section's "no backfill" decision.
- **8b — the history-driven world.** Three stages, each its own commit:
  1. **Token cache in D1** (`worker/token.ts`, `migrations/0005_token_cache.sql`) — fixes 8a's
     tracked exposure below: `getAccessToken` now reads a still-valid encrypted access token +
     expiry from `spotify_token` before ever refreshing, single-flights concurrent refreshes within
     an isolate, and uses a `version` column for compare-and-swap across isolates.
  2. **History-driven activity.** The cron classifies any of a run's primary artists still missing
     a slot right after its batch insert (`worker/genre-resolution.ts`, its own try/catch — never
     fails the sync). `worker/history-query.ts`'s `slotPlaysBetween` aggregates `play_event` joined
     to `artist_cache` by `primary_artist_id`, at query time. `worker/village.ts` maps each village
     range to a history window (short_term → last 28 days, medium_term → 180 days, long_term → all
     time) and, once a window has ≥50 slotted plays, drives every slot's activity/share from real
     plays instead of today's Spotify rank-weighted share — uniformly, never mixed per slot.
     `pausedPayload` is D1-only, so a token failure no longer flattens the village to all-dormant
     when there's real history to show instead. `activitySource`/`historyCoverage`/`historyPlays`
     ride along in the payload; the sidebar Overview tab shows a subtle "Activity from your play
     history" vs "...your Spotify top artists" note.
  3. **Era toggle + sidebar History strip.** `src/era.ts` is the one global era shared by
     `/api/village` and `src/top-artists.ts`'s panel (its existing range tabs, relabeled "4 weeks /
     6 months / All time"), persisted per viewer in `localStorage`. New `GET /api/history/daily`
     (D1-only) returns 30 owner-local days (`OWNER_TZ` var, bucketed with `Intl.DateTimeFormat`) of
     per-slot play counts; the sidebar's new **History** tab renders them as a bar strip, marking
     days before `collectingSince` as "no data" and zero-play days with unclassified plays pending
     as "not yet placed" rather than implying a genuinely quiet day.

**Deviations from this file's original plan (8b, built 2026-09-18):**
- **No `daily_snapshot` table.** `worker/history-query.ts`/`worker/history-daily.ts` query
  `play_event` joined to `artist_cache` live, at request time, instead of maintaining a rollup —
  the personal-app query volume here doesn't justify a rollup table's extra write path and staleness
  window, and a live join is guaranteed always up to date with the latest classification.
- **Era → history-window mapping is an approximation, not a literal translation** of Spotify's own
  fuzzy `time_range` definitions ("approximately last 4 weeks / 6 months") — short_term = last 28
  days, medium_term = last 180 days, long_term = all logged history (naturally bounded by Phase 8a's
  2026-09-18 start, not an arbitrary lookback).
- **Cron-time classification, not just village-time.** Not in the original plan's wording, but
  needed for the history join above to have anything to aggregate against before an artist happens
  to show up in a `/api/village` fetch too.
- **Activity threshold retune deferred.** `shared/activity.ts`'s dormant/quiet/active/festival cutoffs
  are untouched — real play share concentrates much more than Spotify's rank-weighted estimate does
  (a handful of heavily-repeated artists can dominate a slot's plays), so "festival" will likely fire
  more often than it used to once history takes over a slot. Revisit after roughly a month of real
  data rather than retuning on the ~1 day this shipped with.
- **History-based "faded" deferred.** A resident's `faded` state (score 0, rendered dim) still only
  ever comes from Spotify's long_term baseline (see 8a's deviations above) — Phase 8's history could
  in principle detect "stopped listening" more precisely, but that's follow-on work, not part of this
  pass.

**Deviations from this file's original plan (8a, built 2026-09-18):**
- **No `after` cursor on the recently-played call**, despite that being the obvious way to avoid
  re-fetching the same items every 15 min. Offline/downloaded listening syncs to Spotify later
  carrying its *original* `played_at`, which can be older than `MAX(played_at)` already stored — a
  forward-only cursor would permanently miss those plays. The response is capped at 50 items either
  way, so a cursor buys nothing a cheap `INSERT OR IGNORE` doesn't already give for free, and costs
  correctness.
- **No `slot_id` column on `play_event`**, despite the Data model section above originally saying
  "`play_event` (derived: timestamp, artist id, slot)". A slot is a re-classifiable inference, not a
  fact about a play — `worker/genre-resolution.ts` already refuses to persist a low-confidence
  fallback guess to `artist_cache` for exactly this reason (see its doc comment). Freezing a slot per
  play would bake in whatever guess existed 15 minutes after the play aired, forever, even after a
  real Gemini classification later corrects it. 8b joins through `artist_cache.slot_id` at query time
  instead, so every play always reflects the *current* best classification of its artist.
- **`track_cache` exists at all**, not just `play_event` + a join against `artist_cache`. Spotify
  removed the batch `GET /tracks` endpoint in Feb 2026 (see "Spotify API constraints" above), so
  re-resolving a play's title/art at display time would cost one single-item Spotify call per
  historical row, and any row logged before such a table existed would be a permanent hole in Phase
  8.5's Wrapped. `track_cache` is populated at cron time straight from the inline `track` object
  `recently-played` already returns — zero extra Spotify calls. Same category and justification as
  `artist_cache` (migrations/0001_init.sql), which has stored Spotify names/art in D1 since Phase 1.
- **Known, unfixable omissions:** plays under ~30s, private-session plays, and podcast episodes never
  appear in `recently-played` at all — Spotify simply never sends them, there's nothing to filter.
  `duration_ms` is a track's catalog length, not time actually listened (Spotify's API exposes no
  listened-duration signal at all), so Phase 8.5's "minutes listened" is really "minutes of tracks
  logged as played" and must be labelled as approximate, never exact.
- **Known exposure, fixed in 8b's Stage 1:** `getAccessToken`'s access-token cache was per-isolate
  only (`worker/token.ts`), and a cron firing every 15 min would often land on a cold isolate —
  roughly one refresh-token POST per run instead of one per ~50 minutes (the token's real TTL).
  Spotify's PKCE refresh rotates the refresh token on use, so two isolates refreshing concurrently
  (already possible before 8a) was a more frequent pre-existing race, not a new one. Fixed by
  persisting the encrypted access token + expiry in `spotify_token` (see 8b's Stage 1 above) so
  `getAccessToken` reads it before ever refreshing.

**You'll see (8a):** a small readout proves plays are being logged from today forward. The village
itself doesn't look any different yet — that's 8b.

**You'll see (8b):** districts whose slot has enough logged history feel different from ones that
don't yet — activity/share reflects real plays instead of Spotify's rank estimate, and the sidebar
says which. An era toggle (4 weeks / 6 months / all time) switches the whole village and the top
artists panel together. Each character's sidebar has a **History** tab: a 30-day bar strip of their
district's play counts.

### Phase 8.5 — Wrapped on demand
- Depends on Phase 8a's `play_event` history — minutes and true play counts do not exist in the
  Spotify API (rank only), so they can only come from history we log ourselves.
- **[decided 2026-09-18]** No data export import. The user chose to log from today forward, so
  Wrapped is accurate from the day Phase 8a shipped and empty before it. Do not backfill, and do not
  fabricate pre-history figures — show the collection start date instead.
- A Wrapped view over our own history: minutes listened, top songs / artists / genres, with real
  arbitrary ranges (this week / month / year / all time) rather than Spotify's three fixed
  `time_range` buckets.
- Until Phase 8 has accrued data, the same view can fall back to `/me/top/*` over
  short/medium/long_term — clearly labelled as Spotify's windows, not ours.

**Built (2026-09-19).** `GET /api/wrapped?range=week|month|year|all` (`worker/wrapped.ts`) — D1-only
over `play_event` once a window has ≥50 plays: `totalPlays`, `approxMinutes`, top 10 tracks/artists,
top 5 genres (reusing `worker/history-query.ts`'s `slotPlaysBetween`) + `unclassifiedPlays`, and
`collectingSince` (always the true whole-history value, never scoped to `range` — this is what "show
the collection start date instead" means in practice). Below 50 plays, falls back to `/me/top/tracks`
+ `/me/top/artists` (reusing `worker/tracks.ts`'s `fetchTopTracks` and `worker/top-artists.ts`'s
`deriveArtists` as-is) at week/month → `short_term`, year → `medium_term`, all → `long_term` —
rank-only, every plays/minutes field `null`, never estimated from a rank. `src/sidebar.ts` gained a
global **Wrapped** tab (ignores the open character on purpose) with the range picker, the "≈ N min
(approx.)" stat, top songs/artists/genres, an unconditional "Collecting since ..." line, and a "From
Spotify's own top lists — not enough logged plays yet" label when the fallback served the response.

**Deviations from this section's original plan:**
- **Fallback `topGenres` is always `[]`**, not derived from Spotify's own per-artist `genres` arrays.
  Spotify has no genre-play-count endpoint, and mapping raw Spotify genres to slots at request time
  would mean an uncached classification call on a page load — the same rule `worker/tracks.ts` already
  refuses to break for the Songs tab. Deferred, not fabricated.
- **A failed fallback attempt returns the thin history payload, not an error.** `spotifyFallbackPayload`
  has a deliberately broad catch around its two Spotify calls — the one place in this Worker that
  doesn't narrow to `SpotifyRequestError` — because this endpoint must degrade to "here's the little
  history we have" rather than 500 or 429 the whole tab over a fallback that couldn't run.
- **The ≥50-play threshold counts every play in the window, not just classified ones.** Top
  songs/artists need no genre classification at all, so gating the whole history path behind
  `slottedPlays` (rather than raw `play_event` rows) would fall back to Spotify's rank-only view more
  often than necessary.

**You'll see:** a Wrapped-style read on your listening, any time, over any range you pick.

### Phase 8.6 — Playlists are places
- **[decided 2026-09-18]** Playlists become **buildings you can enter**, not a sidebar list. A genre
  district is who you passively listen to; a playlist is something you deliberately made. That
  distinction is encoded spatially — they are not both districts.
- `GET /me/playlists` + `GET /playlists/{id}/tracks`. **Unverified:** these are user-scoped so they
  likely survived the Feb 2026 batch-endpoint removal, but confirm before scoping.
- Entering a playlist building shows its tracks and which resident characters live inside it.
- Playlist genre breakdown feeds Phase 8.5's Wrapped view.
- **Deferred:** generating/saving playlists to Spotify — needs write scopes and a re-connect, and is
  a separate feature.

**You'll see:** walk into a playlist and find the music you put there.

### Phase 9 — Weekly notice board
- Snapshot diff → Gemini weekly brief (1/week, cached) → in-world notice board UI.

- Sidebar gains a **This week** section (the brief's notes for this genre).

**You'll see:** a narrated weekly read on your taste in the village.

### Phase 10 — Talk to the Hokage (agent #1)
- Chat UI + Gemini function calling with tools `get_top_artists`, `get_recent_plays`, `get_slot_history`, `get_weekly_brief`, `find_artist`; daily chat limit.
- Camera pans to the district a tool call is about.

**You'll see:** ask a question about your listening → a real data-backed answer.

### Phase 11 — The village evolves itself (agent #2)
- Daily cron agent with tools `set_district_activity`, `set_weather`, `start_festival`, `set_time_of_day`, `send_visitor`, `set_character_mood`; validated diffs stored in `agent_event`.
- Weather/festival/time-of-day rendering needed for those tools.

**You'll see:** after a day, the village changed on its own.

### Phase 12 — Village chronicle
- Timeline UI of agent decisions with reasoning; replay a past day's changes.

**You'll see:** exactly what the agent changed and why.

### Phase 13 — Show it off
- PNG export / recorded clip, sound, onboarding, edge-state polish (empty account, private session, "live paused" state), disconnect script deletes everything.
- README with architecture + agent write-up.

**You'll see:** a polished app and something to post.

---

## Cross-cutting (every phase)
- **Design is first-class, every phase.** Polished UI on both desktop and mobile browsers (phone ~390px → wide desktop), touch + mouse/keyboard, design tokens in one place, coherent visual identity. Each phase's "You'll see" must look finished on both, not just work.
- All LLM outputs cached; no uncached LLM call on page load.
- API keys only in the Worker.
- `npm run spotify:disconnect` (local script) deletes all stored user data + the token.
- Each phase: typecheck + build pass, demo checklist verified, changelog entry.
- Spotify client centralizes all API calls behind one rate-aware wrapper (429 handling, backoff, request counter/logging) so limits can be measured and enforced everywhere.

## Open questions
- Last.fm vs MusicBrainz as primary tag fallback — default Last.fm (richer tags).
- PixiJS vs plain canvas — default PixiJS.
