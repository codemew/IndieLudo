import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/server/db.js';
import { DeviceService, SessionService, hashToken } from '../src/server/sessions.js';
import { UserService, validateUsername } from '../src/server/users.js';

let db: DB;
let users: UserService;
let devices: DeviceService;
let sessions: SessionService;

beforeEach(() => {
  db = openDb(':memory:');
  users = new UserService(db);
  devices = new DeviceService(db);
  sessions = new SessionService(db);
});

describe('usernames', () => {
  it('accepts 3-16 letters, digits and underscores', () => {
    expect(validateUsername('ab_12')).toBe('ab_12');
    expect(validateUsername('  padded  ')).toBe('padded');
    for (const bad of ['ab', 'x'.repeat(17), 'has space', 'émoji', 'semi;colon', '', 42, null]) {
      expect(() => validateUsername(bad)).toThrow('INVALID_USERNAME');
    }
  });

  it('reserves admin/bot names', () => {
    expect(() => validateUsername('admin')).toThrow('USERNAME_RESERVED');
    expect(() => validateUsername('Bot_Red')).toThrow('USERNAME_RESERVED');
  });

  it('are unique regardless of case', () => {
    users.create('Alice');
    expect(() => users.create('alice')).toThrow('USERNAME_TAKEN');
    expect(() => users.create('ALICE')).toThrow('USERNAME_TAKEN');
    expect(users.getByName('aLiCe')?.username).toBe('Alice');
  });
});

describe('sessions and devices', () => {
  it('stores only token hashes', () => {
    const { token: dTok, device } = devices.create('ua', '1.2.3.4');
    const u = users.create('bob');
    const { token } = sessions.create({ userId: u.id, deviceId: device.id });
    const sessionRow = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    const deviceRow = db.prepare('SELECT token_hash FROM devices').get() as { token_hash: string };
    expect(sessionRow.token_hash).toBe(hashToken(token));
    expect(deviceRow.token_hash).toBe(hashToken(dTok));
    const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(dTok);
  });

  it('resolves a session token to its user', () => {
    const { device } = devices.create('ua', 'ip');
    const u = users.create('carol');
    const { token } = sessions.create({ userId: u.id, deviceId: device.id });
    const r = sessions.resolve(token)!;
    expect(r.user?.username).toBe('carol');
    expect(r.isAdmin).toBe(false);
    expect(sessions.resolve('nope')).toBeUndefined();
    expect(sessions.resolve(undefined)).toBeUndefined();
    expect(sessions.resolve('x'.repeat(500))).toBeUndefined();
  });

  it('admin can rename, delete and revoke', () => {
    const { device } = devices.create('ua', 'ip');
    const u = users.create('dave');
    users.create('erin');
    expect(users.rename(u.id, 'david').username).toBe('david');
    expect(() => users.rename(u.id, 'ERIN')).toThrow('USERNAME_TAKEN');
    expect(() => users.rename(999, 'ghost')).toThrow('NOT_FOUND');

    const { token, session } = sessions.create({ userId: u.id, deviceId: device.id });
    sessions.revoke(session.id);
    expect(sessions.resolve(token)).toBeUndefined();
    expect(() => sessions.revoke(session.id)).toThrow('NOT_FOUND');

    users.delete(u.id);
    expect(users.get(u.id)).toBeUndefined();
    expect(() => users.delete(u.id)).toThrow('NOT_FOUND');
  });

  it('deleting a user cascades to their sessions (foreign keys are on)', () => {
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const { device } = devices.create('ua', 'ip');
    const u = users.create('frank');
    const { token } = sessions.create({ userId: u.id, deviceId: device.id });
    users.delete(u.id);
    expect(sessions.resolve(token)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    // The device itself stays verified.
    expect(devices.get(device.id)).toBeDefined();
  });

  it('revoking a device removes it and its sessions', () => {
    const { token: dTok, device } = devices.create('ua', 'ip');
    const u = users.create('gina');
    const { token } = sessions.create({ userId: u.id, deviceId: device.id });
    devices.revoke(device.id);
    expect(devices.resolve(dTok)).toBeUndefined();
    expect(sessions.resolve(token)).toBeUndefined();
  });

  it('admin flag is separate from the user', () => {
    const { device } = devices.create('ua', 'ip');
    const { token, session } = sessions.create({ userId: null, deviceId: device.id, isAdmin: true });
    expect(sessions.resolve(token)).toMatchObject({ user: null, isAdmin: true });
    sessions.setAdmin(session.id, false);
    expect(sessions.resolve(token)!.isAdmin).toBe(false);
  });

  it('records game stats', () => {
    const u = users.create('hank');
    users.recordGame(u.id, true);
    users.recordGame(u.id, false);
    expect(users.get(u.id)).toMatchObject({ games_played: 2, wins: 1 });
  });

  it('search escapes LIKE wildcards', () => {
    users.create('a_b');
    users.create('axb');
    expect(users.list('a_').map((u) => u.username)).toEqual(['a_b']);
  });
});
