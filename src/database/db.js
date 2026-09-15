import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
fs.mkdirSync(env.libraryDir, { recursive: true });
fs.mkdirSync(env.importsDir, { recursive: true });

export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  file_path TEXT,
  source TEXT,
  source_id TEXT,
  duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'ready',
  fail_reason TEXT,
  added_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);

CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  requested_by TEXT,
  filename TEXT,
  total_lines INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  added INTEGER DEFAULT 0,
  existing INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  failed_items TEXT DEFAULT '[]',
  channel_id TEXT,
  message_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  volume INTEGER DEFAULT ${env.defaultVolume},
  vote_start_percent INTEGER DEFAULT ${env.defaultVoteStartPercent},
  vote_stop_percent INTEGER DEFAULT ${env.defaultVoteStopPercent},
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_dj_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS guild_moderator_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- A track's membership in a playlist is many-to-many: the same downloaded
-- file can belong to the shared "library" playlist (kind='library', a
-- single global row) AND to any number of personal playlists (kind=
-- 'personal', one per owner_id = Discord user id - never the display name,
-- which can change). Removing a track from one playlist never touches
-- another playlist that also references it; a track is only ever fully
-- deleted (row + file) once its last playlist_tracks reference is gone -
-- see library/playlistOps.js.
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('library', 'personal')),
  owner_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_kind_owner ON playlists(kind, COALESCE(owner_id, ''));

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE IF NOT EXISTS listening_stats (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seconds_listened INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id)
);
`);

export function migrateColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// in_library is legacy (kept only so old rows aren't touched) - playlist
// membership is now the single source of truth, via playlist_tracks.
migrateColumn('tracks', 'in_library', 'INTEGER NOT NULL DEFAULT 1');
migrateColumn('tracks', 'thumbnail_url', 'TEXT');

// One-time (idempotent) backfill: every track that used to be flagged
// in_library=1 becomes a member of the single "library" playlist.
db.exec(`
  INSERT OR IGNORE INTO playlists (kind, owner_id) VALUES ('library', NULL);
  INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id)
    SELECT (SELECT id FROM playlists WHERE kind = 'library'), id
    FROM tracks
    WHERE in_library = 1;
`);
