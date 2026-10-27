import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { AppError } from './errors.js';
import type { User } from './users.js';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only token hashes are stored, so a leaked database cannot be replayed as sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export interface Device {
  id: number;
  user_agent: string;
  ip_first_seen: string;
  verified_at: number;
  last_seen: number;
}

/** A device that passed the access gate once. Independent of user accounts and code rotation. */
export class DeviceService {
  constructor(private db: DB) {}

  create(userAgent: string, ip: string, now = Date.now()): { token: string; device: Device } {
    const token = newToken();
    const r = this.db
      .prepare('INSERT INTO devices (token_hash, user_agent, ip_first_seen, verified_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), userAgent.slice(0, 256), ip, now, now);
    return { token, device: this.get(Number(r.lastInsertRowid))! };
  }

  get(id: number): Device | undefined {
    return this.db
      .prepare('SELECT id, user_agent, ip_first_seen, verified_at, last_seen FROM devices WHERE id = ?')
      .get(id) as Device | undefined;
  }

  resolve(token: string | undefined | null, now = Date.now()): Device | undefined {
    if (!token || token.length > 128) return undefined;
    const device = this.db
      .prepare('SELECT id, user_agent, ip_first_seen, verified_at, last_seen FROM devices WHERE token_hash = ?')
      .get(hashToken(token)) as Device | undefined;
    if (device) this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, device.id);
    return device;
  }

  list(): Device[] {
    return this.db
      .prepare('SELECT id, user_agent, ip_first_seen, verified_at, last_seen FROM devices ORDER BY last_seen DESC')
      .all() as unknown as Device[];
  }

  revoke(id: number): void {
    // Sessions on the device go with it (ON DELETE CASCADE).
    const r = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (r.changes === 0) throw new AppError('NOT_FOUND', 404);
  }
}

export interface SessionRow {
  id: number;
  user_id: number | null;
  device_id: number;
  is_admin: number;
  user_agent: string;
  created_at: number;
  last_seen: number;
}

export interface ResolvedSession {
  session: SessionRow;
  user: User | null;
  isAdmin: boolean;
}

const SESSION_COLUMNS = 'id, user_id, device_id, is_admin, user_agent, created_at, last_seen';

export class SessionService {
  constructor(private db: DB) {}

  create(opts: { userId: number | null; deviceId: number; isAdmin?: boolean; userAgent?: string; now?: number }): { token: string; session: SessionRow } {
    const token = newToken();
    const now = opts.now ?? Date.now();
    const r = this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, device_id, is_admin, user_agent, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashToken(token), opts.userId, opts.deviceId, opts.isAdmin ? 1 : 0, (opts.userAgent ?? '').slice(0, 256), now, now);
    return { token, session: this.get(Number(r.lastInsertRowid))! };
  }

  get(id: number): SessionRow | undefined {
    return this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  resolve(token: string | undefined | null, now = Date.now()): ResolvedSession | undefined {
    if (!token || token.length > 128) return undefined;
    const session = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`)
      .get(hashToken(token)) as SessionRow | undefined;
    if (!session) return undefined;
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, session.id);
    const user = session.user_id === null
      ? null
      : ((this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as User | undefined) ?? null);
    return { session, user, isAdmin: session.is_admin === 1 };
  }

  setAdmin(id: number, isAdmin: boolean): void {
    this.db.prepare('UPDATE sessions SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }

  list(): (SessionRow & { username: string | null })[] {
    return this.db
      .prepare(
        `SELECT s.id, s.user_id, s.device_id, s.is_admin, s.user_agent, s.created_at, s.last_seen, u.username
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.last_seen DESC`,
      )
      .all() as unknown as (SessionRow & { username: string | null })[];
  }

  revoke(id: number): SessionRow {
    const session = this.get(id);
    if (!session) throw new AppError('NOT_FOUND', 404);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return session;
  }

  idsForDevice(deviceId: number): number[] {
    return (this.db.prepare('SELECT id FROM sessions WHERE device_id = ?').all(deviceId) as { id: number }[]).map((r) => r.id);
  }
}
