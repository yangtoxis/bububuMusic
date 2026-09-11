// Shared "Artist - Title" splitter (em dash, en dash or a plain hyphen,
// surrounded by whitespace on both sides - conservative on purpose so it
// doesn't misfire on hyphenated words like "T-Pain" or "24-7"). Used for
// TXT lines, free-text search queries, and to pull a real artist out of a
// resolved video's own title when the source has no better metadata.
const SEPARATOR_RE = /\s+[-–—]\s+/;

export function splitArtistTitle(text) {
  if (!text) return null;
  const match = text.match(SEPARATOR_RE);
  if (!match) return null;
  const artist = text.slice(0, match.index).trim();
  const title = text.slice(match.index + match[0].length).trim();
  if (!artist || !title) return null;
  return { artist, title };
}
