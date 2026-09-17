// Picks between /api/village's real data and src/sample-data.ts's hard-coded
// fallback, per district and per sidebar tab — the single place Phase 3's
// "replace sample data when connected" rule lives, so main.ts/residents.ts/
// sidebar.ts don't each need their own connected/live branching.
//
// Split deliberately by *tab*, not just "connected or not": Overview and
// Artists switch to real artists/activity once connected+live, but Songs
// stays on sample data regardless (no per-track fetch yet — SPEC.md's Phase
// 3 bullet explicitly allows this; tracks are a later phase), and "now
// playing" only ever comes from the sample data (real currently-playing
// polling is Phase 5), so it's suppressed once real data is driving the
// district instead of pretending an old sample track is still playing.

import { activityLevel, type ActivityLevel } from "../shared/activity";
import { getListening, nowPlayingSong, totalPlays, topArtists as sampleTopArtists, type Song } from "./sample-data";

export interface ArtistEntry {
  name: string;
  id?: string;
  image?: string | null;
  /** Sample data only — Spotify gives no play counts, only rank. */
  plays?: number;
  /** Real data only — 1-based rank in the current range, or null if faded. */
  rank?: number | null;
  faded?: boolean;
}

export interface VillageArtistIn {
  id: string;
  name: string;
  image: string | null;
  rank: number | null;
  score: number;
  faded: boolean;
}

export interface VillageSlotIn {
  slotId: string;
  activity: ActivityLevel;
  share: number;
  artists: VillageArtistIn[];
}

export type VillagePayload =
  | { connected: false }
  | { connected: true; live: boolean; range: string; slots: VillageSlotIn[]; geminiLimited: boolean };

let village: VillagePayload = { connected: false };
let villageBySlot = new Map<string, VillageSlotIn>();

function indexVillage(payload: VillagePayload): void {
  villageBySlot = payload.connected ? new Map(payload.slots.map((s) => [s.slotId, s])) : new Map();
}

async function fetchVillage(): Promise<VillagePayload> {
  try {
    const res = await fetch("/api/village");
    if (!res.ok) return { connected: false };
    return (await res.json()) as VillagePayload;
  } catch {
    return { connected: false };
  }
}

/** Fetches /api/village once at startup. Safe to call even when there's no
 * Spotify connection — the endpoint itself reports `{connected:false}`, and
 * every accessor below just keeps returning the sample-data fallback. */
export async function initListeningSource(): Promise<void> {
  village = await fetchVillage();
  indexVillage(village);
}

export function isVillageLive(): boolean {
  return village.connected && village.live;
}

export function isVillageConnected(): boolean {
  return village.connected;
}

export function villageGeminiLimited(): boolean {
  return village.connected && village.geminiLimited;
}

/** Top artists for a slot: real (ranked, capped only by what /api/village
 * returned) when connected+live, else the sample data's play-count ranking. */
export function getArtists(slotId: string): ArtistEntry[] {
  if (isVillageLive()) {
    const slot = villageBySlot.get(slotId);
    return (slot?.artists ?? []).map((a) => ({
      name: a.name,
      id: a.id,
      image: a.image,
      rank: a.rank,
      faded: a.faded,
    }));
  }
  return sampleTopArtists(getListening(slotId)).map((a) => ({ name: a.name, plays: a.plays }));
}

export interface Activity {
  level: ActivityLevel;
  share: number;
}

export function getActivity(slotId: string): Activity {
  if (isVillageLive()) {
    const slot = villageBySlot.get(slotId);
    return { level: slot?.activity ?? activityLevel(0), share: slot?.share ?? 0 };
  }
  const listening = getListening(slotId);
  const share = listening?.playShare ?? 0;
  return { level: activityLevel(share), share };
}

/** Songs stay sample-only for every district regardless of connection state
 * — see this module's doc comment. */
export function getSongs(slotId: string): Song[] {
  return getListening(slotId)?.songs ?? [];
}

/** Sample-data play count, shown only in the offline/not-connected Overview
 * stat — real data has no equivalent (Spotify gives rank, not play counts). */
export function getSamplePlaysLogged(slotId: string): number {
  return totalPlays(getListening(slotId));
}

/** "Now playing" is only ever sample data (real currently-playing polling is
 * Phase 5) — suppressed once a district is showing real listening data, so
 * Overview doesn't imply a stale sample track is playing right now. */
export function getNowPlaying(slotId: string): Song | null {
  if (isVillageLive()) return null;
  return nowPlayingSong(getListening(slotId));
}
