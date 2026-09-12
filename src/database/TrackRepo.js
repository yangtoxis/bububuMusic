import { db } from './db.js';

export function normalizeDedupKey(artist, title) {
  return `${artist}|${title}`
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

const insertStmt = db.prepare(`
  INSERT INTO tracks (artist, title, dedup_key, file_path, source, source_id, duration_seconds, thumbnail_url, status, added_by)
  VALUES (@artist, @title, @dedup_key, @file_path, @source, @source_id, @duration_seconds, @thumbnail_url, 'ready', @added_by)
  ON CONFLICT(dedup_key) DO UPDATE SET
    artist = excluded.artist,
    title = excluded.title,
    file_path = excluded.file_path,
    source = excluded.source,
    source_id = excluded.source_id,
    duration_seconds = excluded.duration_seconds,
    thumbnail_url = excluded.thumbnail_url,
    status = 'ready',
    fail_reason = NULL,
    updated_at = CURRENT_TIMESTAMP
`);

const insertFailedStmt = db.prepare(`
  INSERT INTO tracks (artist, title, dedup_key, status, fail_reason, added_by)
  VALUES (@artist, @title, @dedup_key, 'failed', @fail_reason, @added_by)
  ON CONFLICT(dedup_key) DO UPDATE SET
    status = 'failed',
    fail_reason = excluded.fail_reason,
    updated_at = CURRENT_TIMESTAMP
  WHERE tracks.status != 'ready'
`);

const findByDedupKeyStmt = db.prepare('SELECT * FROM tracks WHERE dedup_key = ?');
const findBySourceIdStmt = db.prepare(
  "SELECT * FROM tracks WHERE source = ? AND source_id = ? AND status = 'ready'"
);
const getByIdStmt = db.prepare('SELECT * FROM tracks WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM tracks WHERE id = ?');

export const TrackRepo = {
  findByDedupKey(dedupKey) {
    return findByDedupKeyStmt.get(dedupKey);
  },

  findBySourceId(source, sourceId) {
    if (!sourceId) return null;
    return findBySourceIdStmt.get(source, sourceId);
  },

  insertReady({ artist, title, dedupKey, filePath, source, sourceId, durationSeconds, thumbnailUrl, addedBy }) {
    insertStmt.run({
      artist,
      title,
      dedup_key: dedupKey,
      file_path: filePath,
      source,
      source_id: sourceId ?? null,
      duration_seconds: durationSeconds ?? null,
      thumbnail_url: thumbnailUrl ?? null,
      added_by: addedBy ?? null,
    });
    return findByDedupKeyStmt.get(dedupKey);
  },

  insertFailed({ artist, title, dedupKey, reason, addedBy }) {
    insertFailedStmt.run({
      artist,
      title,
      dedup_key: dedupKey,
      fail_reason: reason,
      added_by: addedBy ?? null,
    });
  },

  getById(id) {
    return getByIdStmt.get(id);
  },

  // Cascades to playlist_tracks (ON DELETE CASCADE) - callers doing this as
  // part of a playlist removal should go through library/playlistOps.js
  // instead, which also handles the file on disk.
  deleteById(id) {
    deleteStmt.run(id);
  },
};
