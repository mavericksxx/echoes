// Hard-coded sample listening data — the offline/not-connected fallback as
// of Phase 3 (see SPEC.md and src/listening-source.ts, which picks between
// this and /api/village's real data per tab). Artist/song/"now playing"
// content lives here rather than in data/districts.json since it's
// listening data, not sprite/map data.

export type { ActivityLevel } from "../shared/activity";
export { activityLevel } from "../shared/activity";
import type { WorldResponse } from "../shared/world";

export interface Song {
  id: string;
  title: string;
  artist: string;
  /** Real data only (Phase 3.5) — every artist id on the track, matching
   * `artist`'s comma-joined order; [0] is primary. Used to filter the Songs
   * tab by artist membership (a feature can't be matched by exact string
   * equality on `artist` — see src/sidebar.ts). Sample rows have none. */
  artistIds?: string[];
  album: string;
  /** Sample data only — Spotify's top-tracks endpoint gives no play counts,
   * only rank (see the "Spotify gives no play counts, only rank" comment in
   * src/listening-source.ts, made for artists first and now for songs too). */
  plays?: number;
  /** ISO timestamp. Sample data only, using a fixed reference "now" so
   * output is deterministic — Spotify's top-tracks endpoint gives no
   * timestamp either. */
  lastPlayed?: string;
  /** Real data only (Phase 3.5) — this track's 1-based rank within its
   * slot's top-tracks list. */
  rank?: number;
  /** Phase 2 fills this with real Spotify artwork; sample rows have none. */
  coverUrl?: string;
  /** Phase 2 fills this with the track's Spotify URL; sample rows aren't links. */
  spotifyUrl?: string;
}

/** Phase 7b: a slot's personality + dialogue lines. Mirrors worker/
 * persona.ts's SlotPersona (real data, once connected+live) — this file only
 * needs the shape, not the D1/Gemini plumbing behind it. */
export interface Persona {
  personality: string;
  dialogue: string[];
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
  // `plays` is optional on Song (real data has none — see the interface's
  // doc comment), but every sample song is built via song() above, which
  // always supplies one; the `?? 0` only guards the type, not real data here.
  const nowPlayingSongId = songs.length
    ? [...songs].sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0))[0]!.id
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

// Handwritten personas (Phase 7b) for the offline/not-connected fallback —
// real data gets these from worker/persona.ts's Gemini generation instead
// (see src/listening-source.ts's getPersona). Only the slots with a nonzero
// SAMPLE_LISTENING share get one; the four silent slots (choji/tenten/
// temari/kankuro) fall back to null, same as a live slot with no residents
// yet — the sidebar's Character section already renders that gracefully.
const STATIC_PERSONAS: Record<string, Persona> = {
  naruto: {
    personality: "Loud, stubborn, and convinced every track is about to be his favorite song ever — again.",
    dialogue: [
      "This one's my new favorite. Same as yesterday's new favorite.",
      "You gotta turn it up or it doesn't count!",
      "I could run laps to this. I have run laps to this.",
      "Believe it — this playlist never misses.",
      "One more song. Okay, five more songs.",
    ],
  },
  sakura: {
    personality: "Keeps the shop's radio on a strict rotation of whatever's stuck in her head this week.",
    dialogue: [
      "Okay but this chorus is unreasonably catchy.",
      "I've had this on repeat since Tuesday, don't judge me.",
      "Perfect song for closing up the shop.",
      "This is my walking-fast-on-purpose song.",
      "Sing it with me or don't come in.",
    ],
  },
  shikamaru: {
    personality: "Studies with something low and unbothered playing — never picks it, never turns it off either.",
    dialogue: [
      "Too much effort to skip it. It's fine where it is.",
      "This is background noise doing its job perfectly.",
      "Troublesome how good this beat is, honestly.",
      "I'll nap to this. That's the highest compliment I give.",
      "Don't ask me to explain it, just let it play.",
    ],
  },
  kakashi: {
    personality: "Reads with one earbud in, something glitchy and precise humming under the page.",
    dialogue: [
      "Hm. This one's got a good pulse to it.",
      "Didn't hear you come in — good track, my bad.",
      "This is the kind of thing you notice on the third listen.",
      "Steady beat. Steady hands. It works.",
      "I'll tell you the artist later. Maybe.",
    ],
  },
  gaara: {
    personality: "Keeps the volume low and the mood lower — this district doesn't do upbeat.",
    dialogue: [
      "Fits the forest better than most people do.",
      "This one understands the quiet.",
      "I don't need it loud. I need it honest.",
      "Some nights this is the only company I want.",
      "Don't ask me why it's sad. It just is.",
    ],
  },
  rocklee: {
    personality: "Trains harder when something loud is on — the louder, the more reps.",
    dialogue: [
      "THIS is what a warm-up song sounds like!",
      "Five hundred push-ups, one riff. Let's go!",
      "If it doesn't make my ears ring, it's not working hard enough.",
      "Youthful energy AND a killer breakdown — unbeatable combo!",
      "Turn it up or I'm turning up the reps instead!",
    ],
  },
  neji: {
    personality: "Precise taste, precise volume — nothing plays here without a reason.",
    dialogue: [
      "Smooth. Deliberate. As it should be.",
      "This track knows exactly what it's doing.",
      "I don't repeat songs by accident.",
      "Fate had nothing to do with this playlist. I curated it.",
      "Quiet room, good song — that's the whole plan.",
    ],
  },
  sasuke: {
    personality: "Something dark and moody plays behind the counter whether anyone's shopping or not.",
    dialogue: [
      "Don't ask what it's about. It's not about anything.",
      "This is the only thing in here that gets it.",
      "Play it again. I wasn't listening the first time.",
      "It's not brooding, it's atmosphere.",
      "You wouldn't get it.",
    ],
  },
  kiba: {
    personality: "Blasts something fast and scrappy through the market stall speakers, dog included.",
    dialogue: [
      "Akamaru barks along, it's basically a duet.",
      "This one's got teeth. I like it.",
      "Three chords and a bad attitude — perfect.",
      "Turn it up before the whole market complains.",
      "Fast song, fast walk, let's move.",
    ],
  },
  hinata: {
    personality: "Something gentle drifts through the garden room — she never plays it loud enough to notice at first.",
    dialogue: [
      "It's soft. I like that it doesn't rush.",
      "This one feels like the garden in the morning.",
      "I hope it's okay if I play it again.",
      "There's something honest about the quiet parts.",
      "I could listen to this for a long time.",
    ],
  },
  ino: {
    personality: "Rotates something a little off-center at the flower shop — nothing that plays on the radio.",
    dialogue: [
      "Nobody else in the village listens to this. Their loss.",
      "Found this one on a whim, kept it forever.",
      "It's a mood, okay? Let me have it.",
      "This is the good kind of weird.",
      "Trust me, it grows on you like everything here does.",
    ],
  },
  shino: {
    personality: "The general store hums with something so quiet you might not register it's playing at all.",
    dialogue: [
      "It's there if you listen for it.",
      "Most people don't notice. I prefer it that way.",
      "This is less a song and more a room tone.",
      "It settles the shop. That's enough.",
      "I wouldn't call it background. I'd call it structure.",
    ],
  },
  guy: {
    personality: "Trains to something with real swing to it — insists everyone can hear the youthful spirit in it.",
    dialogue: [
      "THIS is the sound of springtime youth, my friend!",
      "A good horn line is worth a thousand push-ups!",
      "Listen to that rhythm section — flawless technique!",
      "I challenge you to sit still through this one!",
      "Music like this is why I train before dawn!",
    ],
  },
};

/** A slot's handwritten sample persona, or null for a silent slot (see
 * STATIC_PERSONAS' doc comment) — the offline counterpart to
 * src/listening-source.ts's real getPersona(). */
export function getPersona(slotId: string): Persona | null {
  return STATIC_PERSONAS[slotId] ?? null;
}

const BY_SLOT = new Map(SAMPLE_LISTENING.map((s) => [s.slotId, s]));

export function getListening(slotId: string): SlotListening | undefined {
  return BY_SLOT.get(slotId);
}

export function totalPlays(listening: SlotListening | undefined): number {
  if (!listening) return 0;
  return listening.songs.reduce((sum, s) => sum + (s.plays ?? 0), 0);
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
    byArtist.set(s.artist, (byArtist.get(s.artist) ?? 0) + (s.plays ?? 0));
  }
  return Array.from(byArtist, ([name, plays]) => ({ name, plays })).sort(
    (a, b) => b.plays - a.plays,
  );
}

export function nowPlayingSong(listening: SlotListening | undefined): Song | null {
  if (!listening || !listening.nowPlayingSongId) return null;
  return listening.songs.find((s) => s.id === listening.nowPlayingSongId) ?? null;
}

// ---------------------------------------------------------------------------
// Playlists (Phase 8.6, first cut) — a couple of handwritten sample
// playlists for the offline/not-connected fallback, mirroring
// worker/playlists.ts's PlaylistDetailPayload shape closely enough that
// src/sidebar.ts's Playlists tab can render either without branching on
// more than "is this a sample playlist" (see getSamplePlaylist below).
// ---------------------------------------------------------------------------
export interface SamplePlaylistCastArtist {
  name: string;
  trackCount: number;
}

export interface SamplePlaylistCastSlot {
  slotId: string;
  share: number;
  topArtists: SamplePlaylistCastArtist[];
}

export interface SamplePlaylist {
  id: string;
  name: string;
  trackCount: number;
  cast: SamplePlaylistCastSlot[];
}

export const SAMPLE_PLAYLISTS: SamplePlaylist[] = [
  {
    id: "sample-late-night-drive",
    name: "late night drive",
    trackCount: 34,
    cast: [
      {
        slotId: "shikamaru",
        share: 0.44,
        topArtists: [
          { name: "Mac Miller", trackCount: 6 },
          { name: "Nujabes", trackCount: 4 },
        ],
      },
      {
        slotId: "kakashi",
        share: 0.32,
        topArtists: [
          { name: "ODESZA", trackCount: 5 },
          { name: "Bonobo", trackCount: 3 },
        ],
      },
      {
        slotId: "neji",
        share: 0.24,
        topArtists: [{ name: "Frank Ocean", trackCount: 4 }],
      },
    ],
  },
  {
    id: "sample-gym-pump",
    name: "gym pump",
    trackCount: 27,
    cast: [
      {
        slotId: "naruto",
        share: 0.56,
        topArtists: [
          { name: "Kendrick Lamar", trackCount: 7 },
          { name: "Travis Scott", trackCount: 4 },
        ],
      },
      {
        slotId: "kiba",
        share: 0.26,
        topArtists: [{ name: "Turnstile", trackCount: 3 }],
      },
      {
        slotId: "kankuro",
        share: 0.18,
        topArtists: [{ name: "Bring Me The Horizon", trackCount: 2 }],
      },
    ],
  },
];

export function getSamplePlaylist(id: string): SamplePlaylist | undefined {
  return SAMPLE_PLAYLISTS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Weekly brief (Phase 9) — a handwritten sample notice-board post for the
// offline/not-connected fallback, mirroring worker/weekly-brief.ts's
// WeeklyBriefOut shape closely enough that src/sidebar.ts's Notice board and
// This week sections can render either without branching on more than "is
// this the sample brief" (see src/listening-source.ts's isVillageConnected).
// ---------------------------------------------------------------------------
export interface SampleBriefMover {
  slotId: string;
  playsThisWeek: number;
  playsLastWeek: number;
}

export interface SampleBriefNewArtist {
  name: string;
  slotId: string;
  plays: number;
}

export interface SampleBrief {
  /** Display only — a plain "YYYY-MM-DD", not fetched/parsed like the real payload's. */
  weekStart: string;
  headline: string;
  notes: string[];
  slotNotes: Record<string, string>;
  movers: SampleBriefMover[];
  topNewArtists: SampleBriefNewArtist[];
}

export const SAMPLE_BRIEF: SampleBrief = {
  weekStart: "2026-09-08",
  headline: "Konoha leaned moody this week — Emo/Alt and Lo-fi both spiked while Pop went quiet.",
  notes: [
    "Gaara's district logged its loudest week yet.",
    "Three brand-new artists showed up out of nowhere.",
    "Sakura's corner has gone unusually quiet — worth a check-in.",
  ],
  slotNotes: {
    gaara: "Rough week, but the music's been carrying it.",
    shikamaru: "Slower days, slower songs. Fitting, honestly.",
    sakura: "Haven't heard much from over here lately.",
    naruto: "Same old favorites, on repeat as always.",
  },
  movers: [
    { slotId: "gaara", playsThisWeek: 41, playsLastWeek: 19 },
    { slotId: "shikamaru", playsThisWeek: 28, playsLastWeek: 15 },
    { slotId: "naruto", playsThisWeek: 33, playsLastWeek: 31 },
    { slotId: "sakura", playsThisWeek: 6, playsLastWeek: 22 },
  ],
  topNewArtists: [
    { name: "Wisp", slotId: "gaara", plays: 7 },
    { name: "Men I Trust", slotId: "shikamaru", plays: 5 },
    { name: "beabadoobee", slotId: "ino", plays: 3 },
  ],
};

// ---------------------------------------------------------------------------
// Hokage (Phase 10) — the offline/not-connected fallback for the chat tab.
// Unlike every other sample-data section above, this isn't real content the
// real UI renders verbatim (a chat reply is written for a specific question,
// which sample mode has none of) — it's one fixed scripted reply shown for
// whatever a visitor types, same "sample mode keeps working, but with
// necessarily fake content" convention SAMPLE_BRIEF/SAMPLE_PLAYLISTS follow,
// just collapsed to a single line since there's no real question/answer
// pairing to fake. No network call is made for it (src/sidebar.ts).
// ---------------------------------------------------------------------------
export interface SampleHokageReply {
  reply: string;
  /** Always naruto — a genuinely arbitrary "closest thing" pick, same as
   * openNoticeBoard's SLOTS[0] fallback in src/main.ts, since sample mode
   * has no real tool call to derive one from. */
  focusSlot: string;
}

export const SAMPLE_HOKAGE_REPLY: SampleHokageReply = {
  reply:
    "Ah, a visitor. In this quiet hour I can only speak in generalities — but connect your Spotify and I'll read the real leaves of your listening. For now: the Naruto district has always carried this village's loudest days.",
  focusSlot: "naruto",
};

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

// ---------------------------------------------------------------------------
// World (Phase 11) — a handwritten sample world state for the offline/
// not-connected fallback, shaped exactly like GET /api/world's WorldResponse
// (shared/world.ts) so src/world-state.ts can render either without
// branching on more than "is the village connected" (see
// src/listening-source.ts's isVillageConnected). Every entry's expiresOn is
// far in the future — sample mode has no daily agent re-writing/pruning it,
// unlike the real thing, so nothing here should ever go stale mid-session.
// ---------------------------------------------------------------------------
const SAMPLE_WORLD_SET_ON = "2026-09-19T06:00:00.000Z";
const SAMPLE_WORLD_EXPIRES = "2099-01-01T00:00:00.000Z";

export const SAMPLE_WORLD: WorldResponse = {
  state: {
    weather: { value: "blossom", setOn: SAMPLE_WORLD_SET_ON, expiresOn: SAMPLE_WORLD_EXPIRES },
    festivals: [
      {
        value: { slotId: "naruto", name: "Ramen Festival" },
        setOn: SAMPLE_WORLD_SET_ON,
        expiresOn: SAMPLE_WORLD_EXPIRES,
      },
    ],
    visitors: [
      {
        value: { slotId: "shikamaru", artistId: "sample-visitor-yaeji" },
        setOn: SAMPLE_WORLD_SET_ON,
        expiresOn: SAMPLE_WORLD_EXPIRES,
      },
    ],
    activity: {},
    moods: {},
  },
  visitorNames: { "sample-visitor-yaeji": "Yaeji" },
  updatedAt: SAMPLE_WORLD_SET_ON,
  runDate: "2026-09-19",
  ownerTz: "Asia/Dubai", // matches wrangler.jsonc's real OWNER_TZ
};
