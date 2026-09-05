import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export type GatewayDb = Database.Database;

export function openDatabase(): GatewayDb {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: GatewayDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_track_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT,
      disc_id TEXT,
      kind TEXT NOT NULL,
      duration_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'local',
      external_url TEXT,
      last_sync_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS track_fts USING fts5(
      title,
      artist,
      disc_id,
      content='tracks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
      INSERT INTO track_fts(rowid, title, artist, disc_id)
      VALUES (new.id, new.title, COALESCE(new.artist, ''), COALESCE(new.disc_id, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
      INSERT INTO track_fts(track_fts, rowid, title, artist, disc_id)
      VALUES ('delete', old.id, old.title, COALESCE(old.artist, ''), COALESCE(old.disc_id, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
      INSERT INTO track_fts(track_fts, rowid, title, artist, disc_id)
      VALUES ('delete', old.id, old.title, COALESCE(old.artist, ''), COALESCE(old.disc_id, ''));
      INSERT INTO track_fts(rowid, title, artist, disc_id)
      VALUES (new.id, new.title, COALESCE(new.artist, ''), COALESCE(new.disc_id, ''));
    END;

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
      station_track_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      singer_uuid TEXT,
      key_adjustment INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      station_queue_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status_created ON requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(LOWER(requested_by), singer_uuid);

    CREATE TABLE IF NOT EXISTS queue_items (
      station_queue_id TEXT PRIMARY KEY,
      station_track_id TEXT,
      requested_by TEXT,
      singer_uuid TEXT,
      status TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      key_adjustment INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      artist TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_queue_items_requester ON queue_items(LOWER(requested_by), singer_uuid);
    CREATE INDEX IF NOT EXISTS idx_queue_items_status_pos ON queue_items(status, position);

    CREATE TABLE IF NOT EXISTS queue_actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      requested_by TEXT,
      singer_uuid TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_actions_status_created ON queue_actions(status, created_at);

    CREATE TABLE IF NOT EXISTS history_items (
      id TEXT PRIMARY KEY,
      requested_by TEXT NOT NULL,
      singer_uuid TEXT,
      title TEXT NOT NULL,
      artist TEXT,
      status TEXT NOT NULL DEFAULT 'imported',
      key_adjustment INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT,
      completed_at TEXT,
      source_data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_history_items_requester ON history_items(LOWER(requested_by), singer_uuid);

    CREATE TABLE IF NOT EXISTS gateway_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const trackColumns = db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[];
  if (!trackColumns.some((column) => column.name === 'external_url')) {
    db.exec('ALTER TABLE tracks ADD COLUMN external_url TEXT');
  }
  if (!trackColumns.some((column) => column.name === 'last_sync_id')) {
    db.exec('ALTER TABLE tracks ADD COLUMN last_sync_id TEXT');
  }
}

export function setMeta(db: GatewayDb, key: string, value: string) {
  db.prepare(`
    INSERT INTO gateway_meta(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
