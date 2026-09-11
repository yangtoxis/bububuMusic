import { TrackRepo } from '../database/TrackRepo.js';

const POOL_SIZE = 40;

export function normalizeArtist(artist) {
  return (artist || '').trim().toLowerCase();
}

/**
 * Picks a random "ready" library track, avoiding a set of excluded ids
 * (the track currently playing, tracks already queued) and, where the
 * library is large enough to afford it, artists from recent history.
 *
 * @param {number[]} excludeTrackIds
 * @param {string[]} recentArtists - normalized artists to avoid repeating
 */
export function pickNextTrack({ excludeTrackIds = [], recentArtists = [] } = {}) {
  const total = TrackRepo.countReady();
  if (total === 0) return null;

  const pool = TrackRepo.randomPool(POOL_SIZE);
  const excludeSet = new Set(excludeTrackIds.filter((id) => id != null));

  let candidates = pool.filter((t) => !excludeSet.has(t.id));
  if (candidates.length === 0) {
    // Too few distinct tracks to satisfy every exclusion at once (a small
    // library building out a multi-track queue). Relax gradually instead
    // of dropping every constraint in one go: keep excluding at least the
    // single most recently picked id (the last element - see callers) so
    // a tiny library still alternates instead of repeating back-to-back.
    const mostRecentId = excludeTrackIds[excludeTrackIds.length - 1];
    candidates = pool.filter((t) => t.id !== mostRecentId);
    if (candidates.length === 0) candidates = pool; // only one track exists at all, nothing else possible
  }

  if (recentArtists.length > 0) {
    const withoutRecentArtist = candidates.filter(
      (t) => !recentArtists.includes(normalizeArtist(t.artist))
    );
    if (withoutRecentArtist.length > 0) candidates = withoutRecentArtist;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}
