import { db } from './db.js';

const getLibraryStmt = db.prepare("SELECT * FROM playlists WHERE kind = 'library' LIMIT 1");
const insertLibraryStmt = db.prepare("INSERT OR IGNORE INTO playlists (kind, owner_id) VALUES ('library', NULL)");

const getPersonalStmt = db.prepare("SELECT * FROM playlists WHERE kind = 'personal' AND owner_id = ?");
const insertPersonalStmt = db.prepare("INSERT OR IGNORE INTO playlists (kind, owner_id) VALUES ('personal', ?)");

const getByIdStmt = db.prepare('SELECT * FROM playlists WHERE id = ?');

const linkStmt = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id) VALUES (?, ?)');
const isLinkedStmt = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
const unlinkStmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
const clearStmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
const trackIdsForPlaylistStmt = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?');
const countRefsStmt = db.prepare('SELECT COUNT(*) c FROM playlist_tracks WHERE track_id = ?');

const countReadyStmt = db.prepare(`
  SELECT COUNT(*) c FROM playlist_tracks pt
  JOIN tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ? AND t.status = 'ready'
`);
const randomPoolStmt = db.prepare(`
  SELECT t.* FROM playlist_tracks pt
  JOIN tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ? AND t.status = 'ready'
  ORDER BY RANDOM() LIMIT ?
`);
const listReadyStmt = db.prepare(`
  SELECT t.* FROM playlist_tracks pt
  JOIN tracks t ON t.id = pt.track_id
  WHERE pt.playlist_id = ? AND t.status = 'ready'
  ORDER BY pt.added_at DESC
`);

export const PlaylistRepo = {
  getOrCreateLibrary() {
    insertLibraryStmt.run();
    return getLibraryStmt.get();
  },

  getOrCreatePersonal(ownerId) {
    insertPersonalStmt.run(ownerId);
    return getPersonalStmt.get(ownerId);
  },

  getPersonal(ownerId) {
    return getPersonalStmt.get(ownerId) ?? null;
  },

  getById(playlistId) {
    return getByIdStmt.get(playlistId) ?? null;
  },

  link(playlistId, trackId) {
    linkStmt.run(playlistId, trackId);
  },

  isLinked(playlistId, trackId) {
    return Boolean(isLinkedStmt.get(playlistId, trackId));
  },

  unlink(playlistId, trackId) {
    unlinkStmt.run(playlistId, trackId);
  },

  // Removes every track from a playlist in one go and returns the track ids
  // that were linked (for the caller to cascade-check/garbage-collect).
  clear(playlistId) {
    const trackIds = trackIdsForPlaylistStmt.all(playlistId).map((r) => r.track_id);
    clearStmt.run(playlistId);
    return trackIds;
  },

  countReferences(trackId) {
    return countRefsStmt.get(trackId).c;
  },

  countReady(playlistId) {
    return countReadyStmt.get(playlistId).c;
  },

  randomPool(playlistId, limit) {
    return randomPoolStmt.all(playlistId, limit);
  },

  listReady(playlistId) {
    return listReadyStmt.all(playlistId);
  },
};
