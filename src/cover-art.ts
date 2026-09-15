// Tasteful placeholder art for song rows until Phase 2 fills in real Spotify
// artwork (Song.coverUrl). Deterministic per song so a given row always shows
// the same placeholder rather than flickering between renders.

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** A CSS gradient string for a song's cover-art slot, seeded from its title+artist. */
export function coverPlaceholderGradient(seed: string): string {
  const h = hashString(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + ((h >> 8) % 70)) % 360;
  const angle = (h >> 16) % 360;
  return `linear-gradient(${angle}deg, hsl(${hue1} 60% 42%), hsl(${hue2} 65% 28%))`;
}
