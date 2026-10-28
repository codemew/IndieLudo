import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/server/db.js';
import { LobbyManager, hashLobbyPassword, verifyLobbyPassword } from '../src/server/lobbies.js';

let db: DB;
let now: number;
let lm: LobbyManager;
const onLeaveGame = vi.fn();
const onClosed = vi.fn();

const alice = { id: 1, username: 'alice' };
const bob = { id: 2, username: 'bob' };
const carol = { id: 3, username: 'carol' };

function make(maxLobbies = 50): LobbyManager {
  // randomInt 0: the first free colour, so these tests know who gets which seat.
  return new LobbyManager({ db, lobbyCreatePassword: 'secret', maxLobbies, lobbyIdleCloseSec: 600, now: () => now, onLeaveGame, onClosed, randomInt: () => 0 });
}

function create(user = alice, password = 'pw') {
  return lm.create(user, { createPassword: 'secret', name: 'Room', password });
}

beforeEach(() => {
  db = openDb(':memory:');
  now = 1_000_000;
  onLeaveGame.mockReset();
  onClosed.mockReset();
  lm = make();
});

describe('passwords', () => {
  it('hashes lobby passwords with a salt', () => {
    const a = hashLobbyPassword('pw');
    expect(a).not.toContain('pw');
    expect(a).not.toBe(hashLobbyPassword('pw'));
    expect(verifyLobbyPassword('pw', a)).toBe(true);
    expect(verifyLobbyPassword('PW', a)).toBe(false);
  });

  it('rejects a wrong creation password', () => {
    expect(() => lm.create(alice, { createPassword: 'nope', name: 'Room', password: 'pw' })).toThrow('WRONG_CREATE_PASSWORD');
    expect(() => lm.create(alice, { createPassword: '', name: 'Room', password: 'pw' })).toThrow('WRONG_CREATE_PASSWORD');
  });

  it('rejects a wrong lobby password', () => {
    const l = create();
    expect(() => lm.join(bob, l.id, 'wrong')).toThrow('WRONG_LOBBY_PASSWORD');
    expect(lm.join(bob, l.id, 'pw').members).toHaveLength(2);
  });

  it('never exposes the password hash publicly', () => {
    const l = create();
    expect(JSON.stringify(lm.toPublic(l))).not.toContain(l.passwordHash);
    expect(JSON.stringify(lm.summaries())).not.toContain(l.passwordHash);
  });
});

describe('membership', () => {
  it('assigns free colours and enforces capacity', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.join(carol, l.id, 'pw');
    lm.addBot(alice.id);
    expect(l.members.map((m) => m.color)).toEqual(['red', 'green', 'yellow', 'blue']);
    expect(() => lm.join({ id: 4, username: 'dan' }, l.id, 'pw')).toThrow('LOBBY_FULL');
    expect(() => lm.addBot(alice.id)).toThrow('LOBBY_FULL');
  });

  it('rejects colour conflicts', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    expect(() => lm.setColor(bob.id, 'red')).toThrow('COLOR_TAKEN');
    lm.setColor(bob.id, 'blue');
    expect(l.members.find((m) => m.userId === bob.id)!.color).toBe('blue');
    // The freed colour is available again.
    lm.join(carol, l.id, 'pw');
    expect(l.members.find((m) => m.userId === carol.id)!.color).toBe('green');
  });

  it('hands host over when the host leaves, closes when no human is left', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.addBot(alice.id);
    lm.leave(alice.id);
    expect(l.hostId).toBe(bob.id);
    lm.leave(bob.id);
    expect(lm.get(l.id)).toBeUndefined();
    expect(onClosed).toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lobbies').get()).toEqual({ n: 0 });
  });

  it('only the host can add bots, kick and start', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    expect(() => lm.addBot(bob.id)).toThrow('NOT_HOST');
    expect(() => lm.kick(bob.id, alice.id)).toThrow('NOT_HOST');
    expect(() => lm.checkStart(bob.id)).toThrow('NOT_HOST');
    lm.kick(alice.id, bob.id);
    expect(lm.forUser(bob.id)).toBeUndefined();
  });

  it('adding and removing a bot', () => {
    const l = create();
    lm.addBot(alice.id);
    expect(l.members[1]).toMatchObject({ isBot: true, ready: true, color: 'green', userId: null });
    lm.removeBot(alice.id, 'green');
    expect(l.members).toHaveLength(1);
  });

  it('start needs 2+ seats and every non-host human ready', () => {
    const l = create();
    expect(() => lm.checkStart(alice.id)).toThrow('NOT_ENOUGH_PLAYERS');
    lm.join(bob, l.id, 'pw');
    expect(() => lm.checkStart(alice.id)).toThrow('NOT_ALL_READY');
    lm.setReady(bob.id, true);
    expect(lm.checkStart(alice.id)).toBe(l);
  });

  it('switching lobbies leaves the old waiting lobby but not a running game', () => {
    const l1 = create();
    const l2 = create(bob);
    lm.join(carol, l1.id, 'pw');
    lm.join(carol, l2.id, 'pw');
    expect(lm.forUser(carol.id)?.id).toBe(l2.id);
    expect(l1.members.some((m) => m.userId === carol.id)).toBe(false);

    lm.markPlaying(l2.id, 'g1');
    expect(() => lm.join(carol, l1.id, 'pw')).toThrow('ALREADY_IN_GAME');
    expect(() => lm.join({ id: 9, username: 'zed' }, l2.id, 'pw')).toThrow('GAME_IN_PROGRESS');
  });

  it('leaving during a game notifies the game', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.markPlaying(l.id, 'g1');
    lm.leave(bob.id);
    expect(onLeaveGame).toHaveBeenCalledWith(l, bob.id);
    expect(() => lm.setColor(alice.id, 'blue')).toThrow('GAME_IN_PROGRESS');
  });

  it('caps the number of lobbies', () => {
    lm = make(1);
    create();
    expect(() => create(bob)).toThrow('TOO_MANY_LOBBIES');
  });
});

describe('after a game and idle cleanup', () => {
  it('drops bots and offline humans, reopens for connected humans', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.join(carol, l.id, 'pw');
    lm.addBot(alice.id);
    lm.setReady(bob.id, true);
    lm.markPlaying(l.id, 'g1');
    lm.setConnected(carol.id, false);
    lm.finishGame(l.id);
    expect(l.status).toBe('waiting');
    expect(l.gameId).toBeNull();
    expect(l.members.map((m) => m.username)).toEqual(['alice', 'bob']);
    expect(l.members.every((m) => !m.ready)).toBe(true);
    expect(lm.forUser(carol.id)).toBeUndefined();
  });

  it('closes the lobby when no connected human is left', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.markPlaying(l.id, 'g1');
    lm.setConnected(alice.id, false);
    lm.setConnected(bob.id, false);
    lm.finishGame(l.id);
    expect(lm.get(l.id)).toBeUndefined();
    expect(lm.forUser(alice.id)).toBeUndefined();
  });

  it('passes the host on if the host was dropped', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.markPlaying(l.id, 'g1');
    lm.setConnected(alice.id, false);
    lm.finishGame(l.id);
    expect(l.hostId).toBe(bob.id);
  });

  it('sweeps lobbies whose humans have all been offline too long', () => {
    const idle = create();
    const active = create(bob);
    lm.setConnected(alice.id, false);
    now += 599_000;
    expect(lm.sweep()).toBe(0);
    now += 2_000;
    expect(lm.sweep()).toBe(1);
    expect(lm.get(idle.id)).toBeUndefined();
    expect(lm.get(active.id)).toBeDefined();
  });

  it('coming back online stops the idle clock', () => {
    const l = create();
    lm.setConnected(alice.id, false);
    now += 500_000;
    lm.setConnected(alice.id, true);
    now += 500_000;
    expect(lm.sweep()).toBe(0);
    expect(lm.get(l.id)).toBeDefined();
  });

  it('reloads persisted lobbies with everyone offline', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    const again = make();
    again.load();
    const loaded = again.get(l.id)!;
    expect(loaded.members.map((m) => m.username)).toEqual(['alice', 'bob']);
    expect(loaded.members.every((m) => !m.connected)).toBe(true);
    expect(again.forUser(bob.id)?.id).toBe(l.id);
    expect(verifyLobbyPassword('pw', loaded.passwordHash)).toBe(true);
  });
});

describe('random colours', () => {
  it('the host and joiners get a random free colour, never one that is taken', () => {
    const picks = [2, 0, 1]; // indexes into whatever colours are still free
    const lm2 = new LobbyManager({ db, lobbyCreatePassword: 'secret', maxLobbies: 9, lobbyIdleCloseSec: 600, randomInt: (_min, max) => Math.min(picks.shift() ?? 0, max - 1) });
    const l = lm2.create(alice, { createPassword: 'secret', name: 'Room', password: 'pw' });
    lm2.join(bob, l.id, 'pw');
    lm2.join(carol, l.id, 'pw');
    lm2.addBot(alice.id);
    // red green yellow blue → index 2 = yellow; then [red green blue] → 0 = red; then [green blue] → 1 = blue; the bot gets green.
    expect(lm2.get(l.id)!.members.map((m) => m.color)).toEqual(['yellow', 'red', 'blue', 'green']);
  });

  it('with real randomness the host is not always red', () => {
    const lm2 = new LobbyManager({ db, lobbyCreatePassword: 'secret', maxLobbies: 500, lobbyIdleCloseSec: 600 });
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const l = lm2.create({ id: 100 + i, username: `p${i}` }, { createPassword: 'secret', name: 'Room', password: 'pw' });
      seen.add(l.members[0].color);
    }
    expect(seen).toEqual(new Set(['red', 'green', 'yellow', 'blue']));
  });
});
