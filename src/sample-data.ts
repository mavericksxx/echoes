// Hard-coded sample listening data (Phase 1 has no Spotify connection yet).
// Real per-user data replaces this in Phase 3 (see SPEC.md).

export interface TopArtist {
  name: string;
  plays: number;
}

export interface SlotListening {
  /** Matches a district id in data/districts.json. */
  slotId: string;
  /** Share of total plays, 0..1. Slots at 0 are "unused" — quiet and idle. */
  playShare: number;
  topArtists: TopArtist[];
}

export const SAMPLE_LISTENING: SlotListening[] = [
  { slotId: "naruto", playShare: 0.28, topArtists: [
    { name: "Kendrick Lamar", plays: 142 },
    { name: "Travis Scott", plays: 88 },
    { name: "Doechii", plays: 51 },
  ] },
  { slotId: "sakura", playShare: 0.19, topArtists: [
    { name: "Taylor Swift", plays: 121 },
    { name: "Olivia Rodrigo", plays: 64 },
  ] },
  { slotId: "shikamaru", playShare: 0.14, topArtists: [
    { name: "Mac Miller", plays: 77 },
    { name: "Nujabes", plays: 40 },
  ] },
  { slotId: "kakashi", playShare: 0.11, topArtists: [
    { name: "Frank Ocean", plays: 58 },
    { name: "ODESZA", plays: 33 },
  ] },
  { slotId: "gaara", playShare: 0.08, topArtists: [
    { name: "Travis Scott", plays: 34 },
    { name: "Ken Carson", plays: 19 },
  ] },
  { slotId: "rocklee", playShare: 0.06, topArtists: [
    { name: "Metallica", plays: 19 },
    { name: "Foo Fighters", plays: 12 },
  ] },
  { slotId: "neji", playShare: 0.05, topArtists: [
    { name: "Drake", plays: 34 },
    { name: "SZA", plays: 21 },
  ] },
  { slotId: "sasuke", playShare: 0.03, topArtists: [
    { name: "The Weeknd", plays: 9 },
    { name: "She Wants Revenge", plays: 5 },
  ] },
  { slotId: "kiba", playShare: 0.02, topArtists: [
    { name: "Machine Gun Kelly", plays: 7 },
    { name: "Turnstile", plays: 4 },
  ] },
  { slotId: "hinata", playShare: 0.02, topArtists: [
    { name: "Noah Kahan", plays: 8 },
    { name: "Bon Iver", plays: 5 },
  ] },
  { slotId: "ino", playShare: 0.01, topArtists: [
    { name: "Phoebe Bridgers", plays: 4 },
  ] },
  { slotId: "shino", playShare: 0.005, topArtists: [
    { name: "Brian Eno", plays: 2 },
  ] },
  { slotId: "guy", playShare: 0.005, topArtists: [
    { name: "Louis Armstrong", plays: 2 },
  ] },
  { slotId: "choji", playShare: 0, topArtists: [] },
  { slotId: "tenten", playShare: 0, topArtists: [] },
  { slotId: "temari", playShare: 0, topArtists: [] },
  { slotId: "kankuro", playShare: 0, topArtists: [] },
];

const BY_SLOT = new Map(SAMPLE_LISTENING.map((s) => [s.slotId, s]));

export function getListening(slotId: string): SlotListening | undefined {
  return BY_SLOT.get(slotId);
}

/**
 * Picks a slot id at random, weighted by playShare. Falls back to a uniform
 * pick across all slots if every share is 0. Used to drive which character
 * performs next in the whole-village "now playing" rotation.
 */
export function pickWeightedSlotId(rng: () => number = Math.random): string {
  const total = SAMPLE_LISTENING.reduce((sum, s) => sum + s.playShare, 0);
  if (total <= 0) {
    const i = Math.floor(rng() * SAMPLE_LISTENING.length);
    const slot = SAMPLE_LISTENING[Math.min(i, SAMPLE_LISTENING.length - 1)];
    return slot!.slotId;
  }
  let roll = rng() * total;
  for (const slot of SAMPLE_LISTENING) {
    roll -= slot.playShare;
    if (roll <= 0) return slot.slotId;
  }
  return SAMPLE_LISTENING[SAMPLE_LISTENING.length - 1]!.slotId;
}
