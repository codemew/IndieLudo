import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/server/db.js';
import { CreateAccess } from '../src/server/hosts.js';
import { LobbyManager } from '../src/server/lobbies.js';
import { UserService } from '../src/server/users.js';

let db: DB;
let users: UserService;
let alice: number;
let bob: number;

beforeEach(() => {
  db = openDb(':memory:');
  users = new UserService(db);
  alice = users.create('alice').id;
  bob = users.create('bob').id;
});

describe('the creation password and remembered hosts', () => {
  it("uses config.json's password until an admin sets one, and remembers whoever entered it", () => {
    const access = new CreateAccess(db, 'from-config', () => 1000);
    expect(access.source()).toBe('config');
    expect(access.allow(alice, 'wrong')).toBe(false);
    expect(access.isTrusted(alice)).toBe(false);
    expect(access.allow(alice, 'from-config')).toBe(true);
    // From now on alice needs no password, on any phone; bob still does.
    expect(access.allow(alice, '')).toBe(true);
    expect(access.allow(bob, '')).toBe(false);
    expect(access.list()).toEqual([{ userId: alice, username: 'alice', grantedAt: 1000 }]);
  });

  it('a password set in the admin panel wins over the config, and forgets every remembered host', () => {
    const access = new CreateAccess(db, 'from-config');
    access.trust(alice);
    access.set('panel-pw');
    expect(access.source()).toBe('admin');
    expect(access.isTrusted(alice)).toBe(false);
    expect(access.check('from-config')).toBe(false);
    expect(access.check('panel-pw')).toBe(true);
    expect(access.check('')).toBe(false);
    // It is stored hashed, never as typed.
    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'createPasswordHash'").get() as { value: string }).value;
    expect(stored).not.toContain('panel-pw');
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('going back to the config password forgets everyone again; too short or too long is refused', () => {
    const access = new CreateAccess(db, 'from-config');
    access.set('panel-pw');
    access.trust(bob);
    access.useConfig();
    expect(access.source()).toBe('config');
    expect(access.isTrusted(bob)).toBe(false);
    expect(access.check('from-config')).toBe(true);
    expect(() => access.set('abc')).toThrow('PASSWORD_TOO_SHORT');
    expect(() => access.set('x'.repeat(129))).toThrow('PASSWORD_TOO_LONG');
    expect(() => access.set(42)).toThrow('PASSWORD_TOO_SHORT');
  });

  it('a creation password changed in config.json while the server was down forgets everyone; an unchanged one does not', () => {
    new CreateAccess(db, 'first').trust(alice);
    expect(new CreateAccess(db, 'first').isTrusted(alice)).toBe(true); // a restart with the same config
    expect(new CreateAccess(db, 'second').isTrusted(alice)).toBe(false);
    // The fingerprint kept for that check doesn't hold the password in the clear.
    const key = (db.prepare("SELECT value FROM settings WHERE key = 'createTrustKey'").get() as { value: string }).value;
    expect(key).not.toContain('second');
  });

  it('an admin can forget one account; a deleted user is forgotten with it', () => {
    const access = new CreateAccess(db, 'pw');
    access.trust(alice);
    access.trust(bob);
    access.revoke(alice);
    expect(access.list().map((h) => h.username)).toEqual(['bob']);
    users.delete(bob);
    expect(access.list()).toEqual([]);
  });

  it('the lobby manager asks the gate: a remembered account creates with an empty creation password', () => {
    const access = new CreateAccess(db, 'pw');
    const lm = new LobbyManager({ db, lobbyCreatePassword: 'unused', createGate: access, maxLobbies: 9, lobbyIdleCloseSec: 600, randomInt: () => 0 });
    const user = { id: alice, username: 'alice' };
    expect(() => lm.create(user, { createPassword: '', name: 'Room', password: 'x' })).toThrow('WRONG_CREATE_PASSWORD');
    lm.create(user, { createPassword: 'pw', name: 'Room', password: 'x' });
    lm.leave(alice);
    expect(() => lm.create(user, { createPassword: '', name: 'Again', password: 'x' })).not.toThrow();
  });
});
