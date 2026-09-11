import { normalizeArtist } from '../library/TrackSelector.js';

// Per-guild "just played" memory that outlives a single AudioSession - a
// fresh /play after /stop must not immediately replay what was just
// finished. In-memory only (resets on bot restart), which is fine: the
// point is avoiding an immediate repeat within the same listening session,
// not a permanent play-history log.
const MAX_PER_GUILD = 8;
const store = new Map(); // guildId -> [{ id, artist }] most-recent-first

export function recordPlay(guildId, track) {
  const list = store.get(guildId) ?? [];
  list.unshift({ id: track.id, artist: normalizeArtist(track.artist) });
  if (list.length > MAX_PER_GUILD) list.length = MAX_PER_GUILD;
  store.set(guildId, list);
}

export function getRecentlyPlayed(guildId) {
  return store.get(guildId) ?? [];
}
