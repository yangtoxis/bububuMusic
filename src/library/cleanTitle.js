// Strips every trailing (...)/[...] group from a YouTube video title -
// "(Official Video)", "[320 kbps]", "(feat. X)", "(Remix)", "(4K Remaster)",
// whatever - so a stored title reads as cleanly as a plain "Artist - Title"
// listing instead of a raw upload title cluttered with promo/quality tags.
const TRAILING_GROUP_RE = /\s*[([][^()[\]]*[)\]]\s*$/;

export function cleanTitle(rawTitle) {
  if (!rawTitle) return rawTitle;
  let title = rawTitle.trim();

  let stripped = title.replace(TRAILING_GROUP_RE, '').trim();
  while (stripped && stripped !== title) {
    title = stripped;
    stripped = title.replace(TRAILING_GROUP_RE, '').trim();
  }

  return title || rawTitle; // never collapse to an empty string
}
