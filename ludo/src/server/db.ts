import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     games_played INTEGER NOT NULL DEFAULT 0,
     wins INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE devices (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token_hash TEXT NOT NULL UNIQUE,
     user_agent TEXT NOT NULL DEFAULT '',
     ip_first_seen TEXT NOT NULL DEFAULT '',
     verified_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token_hash TEXT NOT NULL UNIQUE,
     user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
     is_admin INTEGER NOT NULL DEFAULT 0,
     user_agent TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE lobbies (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );
   CREATE TABLE games (
     id TEXT PRIMARY KEY,
     lobby_id TEXT NOT NULL,
     state_json TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     finished INTEGER NOT NULL DEFAULT 0
   );`,
  // Profile avatars (shared/avatars.ts ids; '' = none, the initial is shown).
  `ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // SQLite ships with foreign keys off; without this, deleting a user would leave its sessions behind.
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
