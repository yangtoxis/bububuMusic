import { splitArtistTitle } from './splitArtistTitle.js';

export function parseTrackList(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const items = [];

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return; // skip blank lines silently, they don't count as "line" entries
    const split = splitArtistTitle(line);
    if (split) {
      items.push({ lineNumber: index + 1, raw: line, artist: split.artist, title: split.title });
      return;
    }
    items.push({ lineNumber: index + 1, raw: line, artist: '', title: line });
  });

  return items;
}
