import type { DB } from './db.js';
import { isAvatarId } from '../shared/avatars.js';
import { AppError } from './errors.js';

export interface User {
  id: number;
  username: string;
  created_at: number;
  last_seen: number;
  games_played: number;
  wins: number;
  avatar: string;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function validateUsername(name: unknown): string {
  if (typeof name !== 'string') throw new AppError('INVALID_USERNAME');
  const trimmed = name.trim();
  if (!USERNAME_RE.test(trimmed)) throw new AppError('INVALID_USERNAME');
  // Reserved so nobody can pose as the admin or a bot in the UI.
  if (/^(admin|bot|system)/i.test(trimmed)) throw new AppError('USERNAME_RESERVED');
  return trimmed;
}

export class UserService {
  constructor(private db: DB) {}

  create(username: unknown, now = Date.now()): User {
    const name = validateUsername(username);
    if (this.getByName(name)) throw new AppError('USERNAME_TAKEN', 409);
    const r = this.db
      .prepare('INSERT INTO users (username, created_at, last_seen) VALUES (?, ?, ?)')
      .run(name, now, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  getByName(name: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name) as User | undefined;
  }

  list(search = ''): User[] {
    return this.db
      .prepare("SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY last_seen DESC")
      .all(`%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%`) as unknown as User[];
  }

  rename(id: number, username: unknown): User {
    const name = validateUsername(username);
    const existing = this.getByName(name);
    if (existing && existing.id !== id) throw new AppError('USERNAME_TAKEN', 409);
    const r = this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, id);
    if (r.changes === 0) throw new AppError('NOT_FOUND', 404);
    return this.get(id)!;
  }

  /** Picks the player's avatar (an id from shared/avatars.ts), or '' for none. */
  setAvatar(id: number, avatar: unknown): User {
    if (avatar !== '' && !isAvatarId(avatar)) throw new AppError('INVALID_AVATAR');
    const r = this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, id);
    if (r.changes === 0) throw new AppError('NOT_FOUND', 404);
    return this.get(id)!;
  }

  delete(id: number): void {
    const r = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (r.changes === 0) throw new AppError('NOT_FOUND', 404);
  }

  touch(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, id);
  }

  recordGame(id: number, won: boolean): void {
    this.db
      .prepare('UPDATE users SET games_played = games_played + 1, wins = wins + ? WHERE id = ?')
      .run(won ? 1 : 0, id);
  }
}
