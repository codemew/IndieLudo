import crypto from 'node:crypto';
import type { DB } from './db.js';
import { AppError } from './errors.js';
import { hashLobbyPassword, safeEqual, verifyLobbyPassword, type CreateGate } from './lobbies.js';

/** Where the creation password in force comes from. */
export type CreateSource = 'config' | 'admin';

export interface TrustedHost {
  userId: number;
  username: string;
  grantedAt: number;
}

const HASH_KEY = 'createPasswordHash';
const TRUST_KEY = 'createTrustKey';

/**
 * Who may create lobbies. The creation password is `lobbyCreatePassword` from the config until an
 * admin sets another one in the admin panel (stored hashed in `settings`, and it then wins over the
 * config). An account that enters it correctly once is remembered (`trusted_hosts`) and creates
 * lobbies without it from then on, on any phone. Admins can forget an account, and a new creation
 * password (set in the panel, put back to the config's, or a changed config value) forgets everyone.
 */
export class CreateAccess implements CreateGate {
  constructor(
    private db: DB,
    private configPassword: string,
    private now: () => number = Date.now,
  ) {
    // A creation password changed in config.json while the server was down counts as a change too.
    this.resetIfChanged();
  }

  source(): CreateSource {
    return this.storedHash() ? 'admin' : 'config';
  }

  /** Whether `password` is the creation password in force. */
  check(password: string): boolean {
    const hash = this.storedHash();
    if (hash) return typeof password === 'string' && password.length > 0 && verifyLobbyPassword(password, hash);
    return safeEqual(password, this.configPassword);
  }

  /** CreateGate: remembered accounts need no password; a correct one remembers the account. */
  allow(userId: number, password: string): boolean {
    if (this.isTrusted(userId)) return true;
    if (!this.check(password)) return false;
    this.trust(userId);
    return true;
  }

  /** Admin: a new creation password (it replaces the config's). Every remembered account is forgotten. */
  set(password: unknown): void {
    if (typeof password !== 'string' || password.length < 4) throw new AppError('PASSWORD_TOO_SHORT');
    if (password.length > 128) throw new AppError('PASSWORD_TOO_LONG');
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(HASH_KEY, hashLobbyPassword(password));
    this.resetIfChanged();
  }

  /** Admin: back to `lobbyCreatePassword` from the config. Every remembered account is forgotten. */
  useConfig(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(HASH_KEY);
    this.resetIfChanged();
  }

  isTrusted(userId: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM trusted_hosts WHERE user_id = ?').get(userId));
  }

  trust(userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO trusted_hosts (user_id, granted_at) VALUES (?, ?)').run(userId, this.now());
  }

  /** Admin: this account needs the creation password again. */
  revoke(userId: number): void {
    this.db.prepare('DELETE FROM trusted_hosts WHERE user_id = ?').run(userId);
  }

  list(): TrustedHost[] {
    return this.db
      .prepare(
        'SELECT t.user_id AS userId, u.username AS username, t.granted_at AS grantedAt FROM trusted_hosts t JOIN users u ON u.id = t.user_id ORDER BY t.granted_at DESC',
      )
      .all() as unknown as TrustedHost[];
  }

  private storedHash(): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(HASH_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * A fingerprint of the password in force (never the password itself). When it differs from the
   * one the remembered accounts were granted under, they are all forgotten.
   */
  private resetIfChanged(): void {
    const basis = this.storedHash() ?? `config:${this.configPassword}`;
    // A slow hash: the database never holds anything that cheaply reveals the config password.
    const key = crypto.scryptSync(basis, 'ludo-create-trust', 32).toString('hex');
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(TRUST_KEY) as { value: string } | undefined;
    if (row?.value === key) return;
    this.db.exec('DELETE FROM trusted_hosts');
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(TRUST_KEY, key);
  }
}
