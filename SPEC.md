# Echoes (working name; formerly spotify-pixel-town)

See `IDEA.md` for the concept. This spec breaks the build into **vertical slices**: every phase ships something you can open and see working end to end (data → logic → AI → pixels). No "backend-only" or "AI-only" phases.

**Rule for every phase:** it ends with a runnable demo and a short "what you'll see" check. If a phase can't be demoed, it's scoped wrong.

## Spotify API constraints (researched 2026-09)
- **Feb 2026 Dev Mode rules:** app owner needs active Premium; max 5 users. Owner has Premium Student (confirmed 2026-09-15).
- **Storage:** no databases of Spotify content. Store track/artist **IDs + derived counts** only; fetch names/art live (batch `/tracks`) when rendering. Delete everything within 5 days of disconnect.
- **Dev Mode forever:** max 5 allowlisted users; Extended Quota needs 250k+ MAU. Fine for personal use; public sharing = images/read-only views, not logins.
- **Redirect URI:** `localhost` is banned — use `http://127.0.0.1:PORT/callback`.
- **Artist `genres` is deprecated and often empty.** Genre source = Spotify genres when present → Last.fm/MusicBrainz tags → LLM inference from artist name. Clustering runs on this merged tag set.
- **Storage policy:** no indefinite storage of raw Spotify Content. Persist only *derived* stats (play counts, district tallies, snapshots of our own world state); expire raw API responses; delete all on disconnect.
- **AI policy:** training ML models on Spotify Content is banned. We only do inference with off-the-shelf models, never fine-tune; send minimal fields (artist names, tags, counts).
- **Rate limits:** undocumented (rolling 30s window, Dev Mode lower than Extended). Always honor 429 `Retry-After` with exponential backoff.
- **Live listening:** no push/webhooks — polling only. App open: `currently-playing` every ~5s while playing, 30–60s when paused/idle. App closed: Worker cron pulls `recently-played` (50-item cap) every 15–30 min to backfill history. Intervals are provisional until the rate-limit test below.

## Stack (proposed)
- **Frontend:** TypeScript + Vite, PixiJS for tile/sprite rendering.
- **Backend:** Cloudflare Worker (LLM proxy, agent runs, cron) + D1 (SQLite) for history and cached AI output.
- **Auth:** Spotify Authorization Code + PKCE.
- **LLM:** Gemini via `@google/genai` in the Worker (same setup as the portfolio site's Cloudflare backend). **Flash-Lite everywhere by default** (user decision 2026-09-17: far higher free-tier daily request limits, same as their other projects) — tagging, captions, weekly brief, and agent tool-calling. Only escalate a specific feature to Flash if Flash-Lite demonstrably can't do it, and say why. Pin exact model IDs at build time.

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
- **[default]** Tables: `genre_slot_map` (raw genre/tag → one of the 17 slots, with source + confidence), `artist_cache` (artist id → slot, mood/energy, NPC text; TTL), `daily_snapshot` (rolled up from `play_event` + top-items per time range), `play_event` (derived: timestamp, artist id, slot; **source of truth**), `world_state` (current district states), `agent_event` (evolution-agent actions, reasoning, before/after diff), `llm_cache` (prompt hash → output), `usage_log` (Spotify requests + 429s, Gemini tokens/cost).
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

### Phase 4 — Characters walk properly
- Walkability grid per map + A* pathfinding; spawn points validated in the data check.

**You'll see:** characters wander naturally, no walking on roofs or through walls.

### Phase 5 — Live reactions
- Poll currently-playing (~5s playing / 30–60s idle) through the wrapper.
- Now-playing song → its slot's character walks to their spot + special pose + caption (template text, no AI yet).

**You'll see:** play a song on Spotify → the right character reacts within seconds.

### Phase 6 — Rate-limit test
- Scripted ramp test (10s → 5s → 3s → 2s on currently-playing + concurrent top/artists calls), log every 429 + `Retry-After`, find fastest zero-429 interval over ~30 min, verify recovery after a forced 429.
- Set production intervals at ≥2× the safe interval; record results in this spec.

**You'll see:** a small results report and tuned polling in the app.

### Phase 7 — Moods and personalities
- Gemini mood/energy tagging per artist (cached) → district tint/lighting + character walk speed/performance frequency.
- Per-slot personality + dialogue lines flavored by your top artists (cached); shown in the info card.
- AI live captions replace the template captions (cached per artist+song).

- Sidebar gains a **Character** section (personality + dialogue).

**You'll see:** districts feel different by mood; characters talk about your music.

### Phase 8 — The village remembers
- Worker cron backfills `recently-played` every 15–30 min → `play_event`.
- Daily rollup into `daily_snapshot`; activity levels use history; faded/festival states.
- Time-range toggle (short/medium/long).

- Sidebar gains a **History** section (this genre's activity over time).

**You'll see:** the village keeps changing even when the app was closed; flip between eras.

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
