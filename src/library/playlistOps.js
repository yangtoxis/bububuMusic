import fs from 'node:fs';
import { PlaylistRepo } from '../database/PlaylistRepo.js';
import { TrackRepo } from '../database/TrackRepo.js';
import { audioManager } from '../audio/AudioManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'playlistOps' });

function deleteFile(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch((err) => {
    if (err.code !== 'ENOENT') logger.warn('failed to delete track file', { error: err.message, filePath });
  });
}

/**
 * Removes one track from one playlist. If that was the track's last
 * playlist reference anywhere, the track is fully deleted (DB row + file)
 * instead of being left as an orphan nobody can reach. Either way, any live
 * session (any guild) that already had this track queued or playing drops
 * it immediately instead of getting to it later and finding it gone.
 */
export function removeTrackFromPlaylist(playlistId, trackId) {
  PlaylistRepo.unlink(playlistId, trackId);
  const remaining = PlaylistRepo.countReferences(trackId);

  if (remaining > 0) {
    audioManager.evictTrackEverywhere(trackId);
    return { hardDeleted: false };
  }

  const track = TrackRepo.getById(trackId);
  TrackRepo.deleteById(trackId);
  deleteFile(track?.file_path);
  audioManager.evictTrackEverywhere(trackId);
  return { hardDeleted: true, track };
}

/**
 * Removes every track from a playlist. Returns how many were removed and
 * how many of those had no other playlist referencing them (and so were
 * fully deleted).
 */
export function clearPlaylist(playlistId) {
  const trackIds = PlaylistRepo.clear(playlistId);
  let hardDeletedCount = 0;

  for (const trackId of trackIds) {
    if (PlaylistRepo.countReferences(trackId) > 0) {
      audioManager.evictTrackEverywhere(trackId);
      continue;
    }
    const track = TrackRepo.getById(trackId);
    TrackRepo.deleteById(trackId);
    deleteFile(track?.file_path);
    audioManager.evictTrackEverywhere(trackId);
    hardDeletedCount += 1;
  }

  return { removedCount: trackIds.length, hardDeletedCount };
}

/**
 * Re-links a previously removed track back into a playlist ("Отменить" on
 * a /remove). Only meaningful when the track wasn't hard-deleted - the
 * caller must check for that itself before offering an undo button.
 */
export function restoreTrackToPlaylist(playlistId, trackId) {
  const track = TrackRepo.getById(trackId);
  if (!track) return { ok: false };
  PlaylistRepo.link(playlistId, trackId);
  return { ok: true, track };
}
