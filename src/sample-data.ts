// Hard-coded sample listening data — the offline/not-connected fallback as
// of Phase 3 (see SPEC.md and src/listening-source.ts, which picks between
// this and /api/village's real data per tab). Artist/song/"now playing"
// content lives here rather than in data/districts.json since it's
// listening data, not sprite/map data.

export type { ActivityLevel } from "../shared/activity";
export { activityLevel } from "../shared/activity";

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  plays: number;
  /** ISO timestamp. Sample data uses a fixed reference "now" so output is deterministic. */
  lastPlayed: string;
  /** Phase 2 fills this with real Spotify artwork; sample rows have none. */
  coverUrl?: string;
  /** Phase 2 fills this with the track's Spotify URL; sample rows aren't links. */
  spotifyUrl?: string;
}

export interface SlotListening {
  /** Matches a district id in data/districts.json. */
  slotId: string;
  /** Share of total plays, 0..1. Slots at 0 are "unused" — quiet and idle. */
  playShare: number;
  songs: Song[];
  /** Which song is "now playing" for this slot's demo caption/performance, if any. */
  nowPlayingSongId: string | null;
}

export const SAMPLE_NOW = Date.parse("2026-09-15T12:00:00Z");

function daysAgoIso(days: number): string {
  return new Date(SAMPLE_NOW - days * 86_400_000).toISOString();
}

let songSeq = 0;
function song(title: string, artist: string, album: string, plays: number, daysAgo: number): Song {
  songSeq++;
  return { id: `s${songSeq}`, title, artist, album, plays, lastPlayed: daysAgoIso(daysAgo) };
}

function slot(slotId: string, playShare: number, songs: Song[]): SlotListening {
  const nowPlayingSongId = songs.length
    ? [...songs].sort((a, b) => b.plays - a.plays)[0]!.id
    : null;
  return { slotId, playShare, songs, nowPlayingSongId };
}

export const SAMPLE_LISTENING: SlotListening[] = [
  slot("naruto", 0.28, [
    song("Not Like Us", "Kendrick Lamar", "GNX", 41, 1),
    song("squabble up", "Kendrick Lamar", "GNX", 33, 2),
    song("FEIN", "Travis Scott", "UTOPIA", 29, 1),
    song("Anxiety", "Doechii", "Alligator Bites Never Heal", 27, 3),
    song("DENIAL IS A RIVER", "Doechii", "Alligator Bites Never Heal", 24, 4),
    song("95.south", "Kendrick Lamar", "GNX", 22, 5),
    song("Thought I Was Playing", "JID", "The Forever Story", 18, 6),
    song("Sirens", "Baby Keem", "The Melodic Blue", 16, 8),
    song("Corso", "Tyler, The Creator", "CALL ME IF YOU GET LOST", 14, 9),
    song("Walkin", "Denzel Curry", "Melt My Eyez See Your Future", 11, 12),
  ]),
  slot("sakura", 0.19, [
    song("Cruel Summer", "Taylor Swift", "Lover", 38, 1),
    song("vampire", "Olivia Rodrigo", "GUTS", 31, 2),
    song("Espresso", "Sabrina Carpenter", "Short n' Sweet", 27, 1),
    song("Good Luck, Babe!", "Chappell Roan", "The Rise and Fall of a Midwest Princess", 24, 3),
    song("Houdini", "Dua Lipa", "Radical Optimism", 19, 5),
    song("LUNCH", "Billie Eilish", "HIT ME HARD AND SOFT", 16, 6),
    song("Get Him Back!", "Olivia Rodrigo", "GUTS", 14, 7),
    song("Training Season", "Dua Lipa", "Radical Optimism", 10, 10),
  ]),
  slot("shikamaru", 0.14, [
    song("Good News", "Mac Miller", "Circles", 29, 2),
    song("Blue World", "Mac Miller", "Swimming", 24, 3),
    song("Reflection Eternal", "Nujabes", "Modal Soul", 20, 4),
    song("Feather", "Nujabes", "Metaphorical Music", 17, 6),
    song("Time", "Idealism", "Innocence", 13, 8),
    song("So Far To Go", "J Dilla", "Donuts", 11, 10),
    song("Waves", "Tomppabeats", "Nostalgia", 8, 14),
  ]),
  slot("kakashi", 0.11, [
    song("Pink + White", "Frank Ocean", "Blonde", 24, 2),
    song("Live for", "ODESZA", "In Return", 19, 4),
    song("Say My Name", "Flume", "Skin", 16, 5),
    song("Kerala", "Bonobo", "Migration", 13, 7),
    song("Gosh", "Jamie xx", "In Colour", 10, 9),
    song("A Moment Apart", "ODESZA", "A Moment Apart", 8, 12),
  ]),
  slot("gaara", 0.08, [
    song("SICKO MODE", "Travis Scott", "ASTROWORLD", 15, 3),
    song("Rich Flex", "Ken Carson", "A Great Chaos", 12, 5),
    song("Money So Big", "Yeat", "2 Alivë", 9, 7),
    song("Location", "Playboi Carti", "Die Lit", 7, 10),
  ]),
  slot("rocklee", 0.06, [
    song("Master of Puppets", "Metallica", "Master of Puppets", 12, 4),
    song("Everlong", "Foo Fighters", "The Colour and the Shape", 10, 6),
    song("Numb", "Linkin Park", "Meteora", 8, 8),
    song("Toxicity", "System of a Down", "Toxicity", 6, 11),
  ]),
  slot("neji", 0.05, [
    song("Passionfruit", "Drake", "More Life", 11, 4),
    song("Good Days", "SZA", "SOS", 9, 6),
    song("Nights", "Frank Ocean", "Blonde", 7, 9),
    song("Come and See Me", "PARTYNEXTDOOR", "PARTYNEXTDOOR 3", 5, 13),
  ]),
  slot("sasuke", 0.03, [
    song("Blinding Lights", "The Weeknd", "After Hours", 6, 5),
    song("Tear You Apart", "She Wants Revenge", "She Wants Revenge", 4, 9),
    song("Motorcycle", "Boy Harsher", "Careful", 3, 15),
  ]),
  slot("kiba", 0.02, [
    song("bloody valentine", "Machine Gun Kelly", "Tickets to My Downfall", 4, 6),
    song("HOLIDAY", "Turnstile", "GLOW ON", 3, 10),
    song("American Idiot", "Green Day", "American Idiot", 2, 18),
  ]),
  slot("hinata", 0.02, [
    song("Stick Season", "Noah Kahan", "Stick Season", 4, 6),
    song("Holocene", "Bon Iver", "Bon Iver, Bon Iver", 3, 11),
    song("Skinny Love", "Bon Iver", "For Emma, Forever Ago", 2, 16),
  ]),
  slot("ino", 0.01, [
    song("Motion Sickness", "Phoebe Bridgers", "Stranger in the Alps", 2, 12),
    song("Glue Song", "beabadoobee", "Beatopia", 2, 17),
  ]),
  slot("shino", 0.005, [
    song("An Ending (Ascent)", "Brian Eno", "Apollo: Atmospheres and Soundtracks", 1, 20),
  ]),
  slot("guy", 0.005, [
    song("What a Wonderful World", "Louis Armstrong", "What a Wonderful World", 1, 22),
  ]),
  slot("choji", 0, []),
  slot("tenten", 0, []),
  slot("temari", 0, []),
  slot("kankuro", 0, []),
];

const BY_SLOT = new Map(SAMPLE_LISTENING.map((s) => [s.slotId, s]));

export function getListening(slotId: string): SlotListening | undefined {
  return BY_SLOT.get(slotId);
}

export function totalPlays(listening: SlotListening | undefined): number {
  if (!listening) return 0;
  return listening.songs.reduce((sum, s) => sum + s.plays, 0);
}

export interface ArtistTotal {
  name: string;
  plays: number;
}

/** Aggregates a slot's songs by artist, sorted by plays descending. */
export function topArtists(listening: SlotListening | undefined): ArtistTotal[] {
  if (!listening) return [];
  const byArtist = new Map<string, number>();
  for (const s of listening.songs) {
    byArtist.set(s.artist, (byArtist.get(s.artist) ?? 0) + s.plays);
  }
  return Array.from(byArtist, ([name, plays]) => ({ name, plays })).sort(
    (a, b) => b.plays - a.plays,
  );
}

export function nowPlayingSong(listening: SlotListening | undefined): Song | null {
  if (!listening || !listening.nowPlayingSongId) return null;
  return listening.songs.find((s) => s.id === listening.nowPlayingSongId) ?? null;
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
    const chosen = SAMPLE_LISTENING[Math.min(i, SAMPLE_LISTENING.length - 1)];
    return chosen!.slotId;
  }
  let roll = rng() * total;
  for (const s of SAMPLE_LISTENING) {
    roll -= s.playShare;
    if (roll <= 0) return s.slotId;
  }
  return SAMPLE_LISTENING[SAMPLE_LISTENING.length - 1]!.slotId;
}
