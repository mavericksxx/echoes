// GET /api/top-artists?range=short_term|medium_term|long_term
//
// Returns only derived fields (name, id, genres, image url, rank) — never
// a raw Spotify payload passthrough (Spotify content storage/exposure
// policy, see SPEC.md). Connected-but-live-fetch-failed ("live paused")
// and not-connected both come back as HTTP 200 with a `connected`/`live`
// flag, never a thrown error, so the UI can render a clear state instead
// of a generic failure.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet, SpotifyRequestError } from "./spotify-fetch";

const VALID_RANGES = new Set(["short_term", "medium_term", "long_term"]);
const CACHE_TTL_SECONDS = 30 * 60;
const TOP_ARTISTS_LIMIT = 10;

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  images: SpotifyImage[];
}

interface SpotifyTopArtistsResponse {
  items: SpotifyArtist[];
}

export interface TopArtistOut {
  id: string;
  name: string;
  genres: string[];
  image: string | null;
  rank: number;
}

export type TopArtistsPayload =
  | { connected: false }
  | { connected: true; live: boolean; range: string; artists: TopArtistOut[]; cachedAt: string | null };

function deriveArtists(items: SpotifyArtist[]): TopArtistOut[] {
  return items.map((artist, i) => ({
    id: artist.id,
    name: artist.name,
    genres: artist.genres,
    // images are typically ordered largest-first; [1] is a reasonable
    // panel-sized thumbnail, falling back to whatever's available.
    image: artist.images[1]?.url ?? artist.images[0]?.url ?? null,
    rank: i + 1,
  }));
}

function cacheKeyFor(range: string): Request {
  return new Request(`https://echoes-cache.internal/top-artists/${range}`);
}

async function readCache(key: Request): Promise<TopArtistsPayload | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as TopArtistsPayload;
}

async function writeCache(key: Request, payload: TopArtistsPayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

function pausedPayload(range: string): TopArtistsPayload {
  return { connected: true, live: false, range, artists: [], cachedAt: null };
}

export async function handleTopArtists(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "medium_term";
  if (!VALID_RANGES.has(range)) {
    return Response.json({ error: "range must be short_term, medium_term, or long_term" }, { status: 400 });
  }

  // Token presence is checked (via getAccessToken) before touching the
  // cache, so a disconnect is reflected immediately rather than serving a
  // stale cached "connected" response for up to CACHE_TTL_SECONDS.
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    if (err instanceof TokenError) return Response.json(pausedPayload(range));
    throw err;
  }

  if (accessToken === null) {
    return Response.json({ connected: false } satisfies TopArtistsPayload);
  }

  const cacheKey = cacheKeyFor(range);
  const cached = await readCache(cacheKey);
  if (cached) return Response.json(cached);

  try {
    const data = await spotifyGet<SpotifyTopArtistsResponse>(
      env,
      `/me/top/artists?time_range=${range}&limit=${TOP_ARTISTS_LIMIT}`,
      accessToken,
    );
    const payload: TopArtistsPayload = {
      connected: true,
      live: true,
      range,
      artists: deriveArtists(data.items),
      cachedAt: new Date().toISOString(),
    };
    await writeCache(cacheKey, payload);
    return Response.json(payload);
  } catch (err) {
    if (err instanceof SpotifyRequestError) return Response.json(pausedPayload(range));
    throw err;
  }
}
