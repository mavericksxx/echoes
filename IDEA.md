# spotify-pixel-town

A pixel-art world shaped by your real Spotify listening habits — genres become districts, artists become NPCs/buildings, your taste shifts visibly change the world over time.

## The idea

- Connect to your own Spotify account via OAuth. Your listening history drives the world, not a demo dataset.
- Genres become **districts** of the town — the more you listen to a genre, the bigger/more developed its district gets.
- Artists you listen to become **NPCs or buildings** in their genre's district — top artists get prominent placement.
- **Recent plays drive live events** — something lights up / an NPC appears when a song plays, if polling live.
- Taste shifts over time change the world visibly — a district you've drifted away from fades or goes quiet; a new obsession causes rapid new construction.
- **Weekly reflection**, Zenith-brief style: "you went deep into [genre] this week, here's how your taste map shifted" — not just a dashboard, an actual narrated read on you.

## Why this one

Matches the exact throughline that makes pokeharness and Zenith click for you: gamifying real activity data, reflecting it back with insight, and doing it with real aesthetic craft — applied to a completely fresh domain (music/taste) instead of coding activity. Also gives more room to build an ambitious, evolving pixel world than pokeharness's garden did.

## Wow factor

Not "here's your Spotify Wrapped" (static, once a year, generic). This is **always-on and alive** — a world you can open any day and see visibly shift as your taste shifts, with a narrated weekly read on yourself. The novelty is in making music taste *spatial and inhabited* rather than a bar chart.

## Feasibility: Spotify Web API

- **Auth:** Authorization Code flow with PKCE. Single-user personal project — no backend token storage needed beyond a local refresh token.
- **`/me/top/tracks`, `/me/top/artists`** (`time_range=short_term|medium_term|long_term`) — the taste map across different windows; great for driving district size/season.
- **`/me/player/recently-played`** — live listening stream, for real-time world events.
- **Artist `genres` field** (via `/artists`) — genre bucketing for districts. Note: `audio-features`/`audio-analysis` (danceability, energy, valence) were deprecated for new apps in Nov 2024 — no per-track mood data available. v1 should lean on genre + frequency/recency rather than audio-derived mood.

## Scope tiers

**Weekend:** OAuth connect, pull top artists/tracks, render a static tile-grid town with one district per top genre, artist name labels on buildings.

**MVP:** live polling of recently-played to trigger world events/animations; district size responds to listening frequency across time ranges; basic weekly reflection text generated from taste-shift diffs.

**Flagship:** full animated world with seasons/weather tied to taste evolution, NPC "characters" per artist with simple routines, a proper narrated weekly brief (LLM-generated, Zenith-style), shareable snapshots of your current town.

## First actions

1. Register a Spotify app, set up OAuth (PKCE) against your own account.
2. Pull `/me/top/artists` + `/me/top/tracks`, log genre distribution to validate district-mapping logic before any rendering.
3. Set up a TypeScript tile-rendering canvas pipeline (reuse patterns from pokeharness/gravitational-lensing-sim).
4. Map genres → districts, render the weekend-scope static town.

## Open questions

- How many genres realistically map to distinct, readable districts? (Spotify's genre taxonomy is granular — may need genre clustering/bucketing.)
- Poll-based (checked periodically) vs. attempt at real-time via webhooks (Spotify has no push webhooks for playback — polling is the only option).
- Where does taste history persist between sessions (local file, SQLite) so the "world shifts over time" is real and not resimulated from scratch each load?
- Stack: plain canvas/TypeScript vs. Phaser/PixiJS for the tile/sprite layer.

## AI / LLM layer

AI is a first-class part of the project (and a portfolio centerpiece), not a bolt-on.

### Core (fixes real design gaps)
1. **Genre clustering.** LLM clusters Spotify's granular genres into ~8–12 named districts ("Neon Alley", "Folk Hollow"). Run once, cache, incrementally assign new genres. Answers the "how many districts" open question.
2. **Narrated weekly brief.** Feed week-over-week taste diffs (district growth, new artists, fading genres) to Gemini → short Zenith-style narrated read. One call per week.
3. **Mood inference without audio-features.** LLM tags each artist with mood/energy from name + genres, driving weather, time-of-day, and NPC energy. Replaces the deprecated audio-features API.

### Flavor
4. **NPC personalities.** Per-artist NPC bio, daily routine, and dialogue lines in the artist's vibe. Generated once, cached.
5. **Live event captions.** One-line in-world narration when a song plays ("The Radiohead tower flickers; someone's in a mood.").
6. **Town Mayor chat agent.** Tool-using agent over your listening data (`get_top_artists(range)`, `get_district_history`, `get_recent_plays`, ...). Ask "why is the jazz district growing?" or "what would revive Folk Hollow?"

### Agentic (portfolio showcase)
7. **World-evolution agent.** Scheduled agent that reads taste history and *decides* world changes — new construction, weather, festivals, district decline — via tools that mutate world state. The agent shapes the world; the renderer just shows it.
8. **Generated pixel art** for artist buildings/sprites. Hardest to keep consistent — last.

### Architecture notes
- LLM calls go through a small backend (e.g. Cloudflare Worker) — API keys never ship to the client. Spotify PKCE can stay client-side.
- Cache every LLM output (district map, moods, NPC bios, briefs) in SQLite/D1 so the world is stable across sessions and cost stays near zero.
- Gemini (`@google/genai`, matching Zenith/portfolio): Flash-Lite for bulk tagging (genres, moods, captions); Flash for the brief and NPC writing; Flash/Pro with function calling for agents.
- Keep agent actions structured (tool calls → validated world-state diffs) so every change is inspectable and replayable — this is the portfolio story.
