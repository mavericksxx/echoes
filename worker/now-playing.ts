// GET /api/now-playing — the owner's currently-playing track (Phase 5a),
// shown as a display-only card top-right (src/now-playing-card.ts). Reuses
// the same token/spotifyGet plumbing as top-artists.ts/village.ts, but with
// its own much shorter shared cache — see the doc comment below.
//
// Shared, not per-visitor: the site is public, so every open tab polling
// this endpoint every ~10s would otherwise multiply real Spotify calls by
// however many people have the page open, against a rate limit that's per
// Client ID, app-wide (SPEC.md's Spotify API constraints — a bad 429 there
// can mean a Retry-After of 13-18 hours for the *whole site's* data, not
// just this widget). Caching the upstream response in caches.default for
// ~10s under one fixed key (not keyed by IP or query string) means Spotify
// is called at most ~6x/minute no matter how many visitors are polling.
//
// Any failure here (token, Spotify, or an unrecognized payload shape)
// degrades to `{ playing: false, track: null }` with HTTP 200, never a
// 5xx — a rate-limit blip must read as "no card", not take the page down.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet, SpotifyRequestError } from "./spotify-fetch";

const CACHE_TTL_SECONDS = 10;

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyTrackItem {
  id: string;
  name: string;
  duration_ms: number;
  album: { name: string; images: SpotifyImage[] };
  artists: { name: string }[];
  external_urls: { spotify: string };
}

/** GET /me/player/currently-playing's shape — only the fields used here.
 * `item` is a track, an episode (different shape entirely), or absent;
 * `currently_playing_type` is how Spotify distinguishes them. Spotify
 * returns 204 No Content (no body) when nothing is playing at all — see
 * spotify-fetch.ts's 204 handling, which is why this is nullable. */
interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrackItem | null;
  currently_playing_type: "track" | "episode" | "ad" | "unknown";
}

export interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  spotifyUrl: string;
  durationMs: number;
  progressMs: number;
}

export type NowPlayingPayload = { playing: boolean; track: NowPlayingTrack | null };

const NOT_PLAYING: NowPlayingPayload = { playing: false, track: null };

function cacheKey(): Request {
  // One fixed URL regardless of who's asking — see the shared-cache doc
  // comment above. Not real routing, just a caches.default key.
  return new Request("https://echoes-cache.internal/now-playing");
}

async function readCache(key: Request): Promise<NowPlayingPayload | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as NowPlayingPayload;
}

async function writeCache(key: Request, payload: NowPlayingPayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

/** Turns Spotify's raw currently-playing shape into the small payload the
 * card needs. `data` is null on a 204 (nothing playing at all); explicit
 * `is_playing: false` and the podcast/episode case (`item` present but not
 * a track) are both treated as "not playing" rather than a crash. */
function toPayload(data: SpotifyCurrentlyPlaying | null): NowPlayingPayload {
  if (!data || !data.is_playing || !data.item || data.currently_playing_type !== "track") {
    return NOT_PLAYING;
  }
  const track = data.item;
  return {
    playing: true,
    track: {
      id: track.id,
      title: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      album: track.album.name,
      coverUrl: track.album.images[0]?.url ?? null,
      spotifyUrl: track.external_urls.spotify,
      durationMs: track.duration_ms,
      progressMs: data.progress_ms ?? 0,
    },
  };
}

export async function handleNowPlaying(env: Env): Promise<Response> {
  const key = cacheKey();
  try {
    const cached = await readCache(key);
    if (cached) return Response.json(cached);
  } catch (err) {
    console.error("[now-playing] cache read failed, fetching fresh:", err);
  }

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    // Token/refresh trouble degrades to "nothing playing", never a 5xx —
    // see this file's doc comment.
    if (err instanceof TokenError) return Response.json(NOT_PLAYING);
    console.error("[now-playing] token stage failed unexpectedly:", err);
    return Response.json(NOT_PLAYING);
  }
  if (accessToken === null) return Response.json(NOT_PLAYING);

  let payload: NowPlayingPayload;
  try {
    const data = await spotifyGet<SpotifyCurrentlyPlaying | null>(env, "/me/player/currently-playing", accessToken);
    payload = toPayload(data);
  } catch (err) {
    if (err instanceof SpotifyRequestError) return Response.json(NOT_PLAYING);
    console.error("[now-playing] spotify stage failed unexpectedly:", err);
    return Response.json(NOT_PLAYING);
  }

  try {
    await writeCache(key, payload);
  } catch (err) {
    console.error("[now-playing] cache write failed (response still returned):", err);
  }
  return Response.json(payload);
}
