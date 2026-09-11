import { db } from './db.js';

export function normalizeDedupKey(artist, title) {
  return `${artist}|${title}`
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

const insertStmt = db.prepare(`
  INSERT INTO tracks (artist, title, dedup_key, file_path, source, source_id, duration_seconds, thumbnail_url, status, added_by, in_library)
  VALUES (@artist, @title, @dedup_key, @file_path, @source, @source_id, @duration_seconds, @thumbnail_url, 'ready', @added_by, @in_library)
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
    in_library = MAX(tracks.in_library, excluded.in_library),
    updated_at = CURRENT_TIMESTAMP
`);

const insertFailedStmt = db.prepare(`
  INSERT INTO tracks (artist, title, dedup_key, status, fail_reason, added_by, in_library)
  VALUES (@artist, @title, @dedup_key, 'failed', @fail_reason, @added_by, @in_library)
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
const countReadyStmt = db.prepare("SELECT COUNT(*) c FROM tracks WHERE status = 'ready' AND in_library = 1");
const randomPoolStmt = db.prepare(
  "SELECT * FROM tracks WHERE status = 'ready' AND in_library = 1 ORDER BY RANDOM() LIMIT ?"
);
const getByIdStmt = db.prepare('SELECT * FROM tracks WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM tracks WHERE id = ?');
const setInLibraryStmt = db.prepare(
  'UPDATE tracks SET in_library = MAX(in_library, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const softRemoveStmt = db.prepare("UPDATE tracks SET status = 'removed', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
const restoreStmt = db.prepare(
  "UPDATE tracks SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'removed'"
);

export const TrackRepo = {
  findByDedupKey(dedupKey) {
    return findByDedupKeyStmt.get(dedupKey);
  },

  findBySourceId(source, sourceId) {
    if (!sourceId) return null;
    return findBySourceIdStmt.get(source, sourceId);
  },

  insertReady({ artist, title, dedupKey, filePath, source, sourceId, durationSeconds, thumbnailUrl, addedBy, inLibrary = true }) {
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
      in_library: inLibrary ? 1 : 0,
    });
    return findByDedupKeyStmt.get(dedupKey);
  },

  insertFailed({ artist, title, dedupKey, reason, addedBy, inLibrary = true }) {
    insertFailedStmt.run({
      artist,
      title,
      dedup_key: dedupKey,
      fail_reason: reason,
      added_by: addedBy ?? null,
      in_library: inLibrary ? 1 : 0,
    });
  },

  countReady() {
    return countReadyStmt.get().c;
  },

  randomPool(limit) {
    return randomPoolStmt.all(limit);
  },

  getById(id) {
    return getByIdStmt.get(id);
  },

  // Never downgrades - only promotes a queue-only track (in_library=0) to
  // a permanent library track when it's later resolved via /add too.
  setInLibrary(id, inLibrary) {
    setInLibraryStmt.run(inLibrary ? 1 : 0, id);
  },

  deleteById(id) {
    deleteStmt.run(id);
  },

  softRemove(id) {
    softRemoveStmt.run(id);
  },

  restore(id) {
    restoreStmt.run(id);
  },
};
