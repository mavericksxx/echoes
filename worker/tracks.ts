// GET /me/top/tracks — real per-track data for the sidebar's Songs tab
// (Phase 3.5). Fetched through the same rate-aware spotifyGet as every other
// Spotify call in this Worker; worker/village.ts owns calling this as its
// 4th ("tracks") stage and merging the result into the /api/village
// payload — this module only knows Spotify's shape, not the village roster.
//
// Deliberately does NOT fetch /me/player/recently-played (that's Phase 8:
// history/backfill, a different concern) and does NOT use the batch
// GET /tracks, /artists, /albums endpoints — Spotify removed all three in
// Feb 2026 (SPEC.md), so every field a song row needs (title, artists,
// album, cover, link) has to come back inline from this one top-tracks call.
//
// Bucketing rule (why this file trusts the caller's slot map instead of
// reaching for Gemini itself): a track is placed in a slot only if its
// *primary* artist already has a resolved slot from the artist pipeline
// (worker/genre-resolution.ts) — never a fresh classification. That keeps
// this endpoint at zero additional Gemini calls and zero new artist_cache
// rows, matching SPEC.md's "no uncached LLM call on page load". A track
// whose primary artist isn't a known resident (not in the current-range ∪
// long_term union built in village.ts) is dropped, not guessed at.

import type { Env } from "./index";
import { spotifyGet } from "./spotify-fetch";

const TOP_TRACKS_LIMIT = 50; // Spotify's max for /me/top/tracks

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyTrackArtist {
  id: string;
  name: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyTrackArtist[];
  album: { name: string; images: SpotifyImage[] };
  external_urls: { spotify: string };
}

interface SpotifyTopTracksResponse {
  items: SpotifyTrack[];
}

/** One track, shaped for the /api/village payload — everything the sidebar's
 * Songs tab needs to render a row, nothing more (no raw Spotify passthrough,
 * per SPEC.md's storage/exposure policy). Lives only in the 30-minute
 * `caches.default` entry village.ts writes — never persisted to D1. */
export interface TrackOut {
  id: string;
  title: string;
  /** Comma-joined display name of every artist on the track (features included). */
  artist: string;
  /** Every artist id on the track, same order as Spotify's `artists` array — [0] is primary. */
  artistIds: string[];
  album: string;
  /** A ~300px image from `album.images`, or null if Spotify sent none. */
  coverUrl: string | null;
  spotifyUrl: string;
}

function deriveTracks(items: SpotifyTrack[]): TrackOut[] {
  return items.map((track) => ({
    id: track.id,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    artistIds: track.artists.map((a) => a.id),
    album: track.album.name,
    // images are typically ordered largest-first, same convention as
    // top-artists.ts's artist image pick — [1] lands around 300px.
    coverUrl: track.album.images[1]?.url ?? track.album.images[0]?.url ?? null,
    spotifyUrl: track.external_urls.spotify,
  }));
}

export async function fetchTopTracks(env: Env, accessToken: string, range: string): Promise<TrackOut[]> {
  const data = await spotifyGet<SpotifyTopTracksResponse>(
    env,
    `/me/top/tracks?time_range=${range}&limit=${TOP_TRACKS_LIMIT}`,
    accessToken,
  );
  return deriveTracks(data.items);
}

/** A song as placed inside a slot — TrackOut plus its 1-based rank within
 * *that slot's* song list (not its rank in the raw 50-track fetch). */
export interface SlottedSong extends TrackOut {
  rank: number;
}

/** Buckets tracks into slots by primary-artist membership in `slotById` (see
 * this module's doc comment) — a track whose first artist isn't in the map
 * is dropped, never guessed at. Order within each slot's list follows the
 * original fetch order (Spotify's own preference ranking), renumbered 1..n
 * per slot. */
export function bucketTracksBySlot(
  tracks: TrackOut[],
  slotById: Map<string, { slotId: string }>,
): Map<string, SlottedSong[]> {
  const bySlot = new Map<string, SlottedSong[]>();
  for (const track of tracks) {
    const primaryArtistId = track.artistIds[0];
    if (!primaryArtistId) continue;
    const slotId = slotById.get(primaryArtistId)?.slotId;
    if (!slotId) continue;
    const list = bySlot.get(slotId) ?? [];
    list.push({ ...track, rank: list.length + 1 });
    bySlot.set(slotId, list);
  }
  return bySlot;
}
