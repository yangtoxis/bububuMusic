import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
fs.mkdirSync(env.libraryDir, { recursive: true });
fs.mkdirSync(env.importsDir, { recursive: true });

export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');

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
`);

export function migrateColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// in_library=0 marks a track that was resolved only for /add-queue (a one-off
// play, not part of the permanent "Хайповый музон" pool the shuffler draws
// from). thumbnail_url is best-effort metadata from the resolver.
migrateColumn('tracks', 'in_library', 'INTEGER NOT NULL DEFAULT 1');
migrateColumn('tracks', 'thumbnail_url', 'TEXT');
