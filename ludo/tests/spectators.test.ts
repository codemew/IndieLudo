import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/server/db.js';
import { LobbyManager, humanIds } from '../src/server/lobbies.js';
import { MAX_SPECTATORS } from '../src/shared/types.js';

let db: DB;
let lm: LobbyManager;
const onLeaveGame = vi.fn();
const onMemberLeft = vi.fn();
const onClosed = vi.fn();

const user = (id: number) => ({ id, username: `u${id}` });
const [alice, bob, carol] = [user(1), user(2), user(3)];

function make(): LobbyManager {
  return new LobbyManager({ db, lobbyCreatePassword: 'secret', maxLobbies: 50, lobbyIdleCloseSec: 600, now: () => 1_000_000, onLeaveGame, onMemberLeft, onClosed, randomInt: () => 0 });
}
const create = (u = alice) => lm.create(u, { createPassword: 'secret', name: 'Room', password: 'pw' });
const seated = (id: string) => lm.get(id)!.members.map((m) => m.username);
const watching = (id: string) => lm.get(id)!.spectators.map((s) => s.username);

beforeEach(() => {
  db = openDb(':memory:');
  [onLeaveGame, onMemberLeft, onClosed].forEach((f) => f.mockReset());
  lm = make();
});

describe('joining to watch', () => {
  it('watching takes no seat; it needs the password like joining does', () => {
    const l = create();
    expect(() => lm.join(bob, l.id, 'nope', true)).toThrow('WRONG_LOBBY_PASSWORD');
    lm.join(bob, l.id, 'pw', true);
    expect(seated(l.id)).toEqual(['u1']);
    expect(watching(l.id)).toEqual(['u2']);
    expect(lm.forUser(bob.id)?.id).toBe(l.id);
    expect(lm.summaries()[0]).toMatchObject({ players: 1, watching: 1 });
  });

  it('a running game or full seats can only be watched', () => {
    const l = create();
    lm.fillBots(alice.id);
    expect(() => lm.join(bob, l.id, 'pw')).toThrow('LOBBY_FULL');
    lm.join(bob, l.id, 'pw', true);
    lm.markPlaying(l.id, 'g1');
    expect(() => lm.join(carol, l.id, 'pw')).toThrow('GAME_IN_PROGRESS');
    lm.join(carol, l.id, 'pw', true);
    expect(watching(l.id)).toEqual(['u2', 'u3']);
  });

  it(`at most ${MAX_SPECTATORS} watch`, () => {
    const l = create();
    for (let i = 0; i < MAX_SPECTATORS; i++) lm.join(user(10 + i), l.id, 'pw', true);
    expect(() => lm.join(user(99), l.id, 'pw', true)).toThrow('TOO_MANY_WATCHING');
    expect(() => lm.spectate(alice.id)).toThrow('TOO_MANY_WATCHING');
  });

  it('a spectator of a running game may switch to another lobby; a player in it may not', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.join(carol, l.id, 'pw', true);
    lm.markPlaying(l.id, 'g1');
    const other = create(user(7));
    expect(() => lm.join(bob, other.id, 'pw')).toThrow('ALREADY_IN_GAME');
    lm.join(carol, other.id, 'pw');
    expect(watching(l.id)).toEqual([]);
    expect(onLeaveGame).not.toHaveBeenCalled(); // watching wasn't a seat in that game
  });
});

describe('watch instead / sit down', () => {
  it('a player gives up their seat to watch, and sits back on an open seat', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.spectate(bob.id);
    expect(seated(l.id)).toEqual(['u1']);
    expect(watching(l.id)).toEqual(['u2']);
    expect(() => lm.sit(bob.id, 'red')).toThrow('COLOR_TAKEN');
    lm.sit(bob.id, 'blue');
    expect(lm.get(l.id)!.members.find((m) => m.userId === bob.id)).toMatchObject({ color: 'blue', ready: false });
    expect(watching(l.id)).toEqual([]);
    expect(() => lm.sit(bob.id, 'green')).toThrow('NOT_WATCHING');
  });

  it("seat-only actions are refused while watching, and swaps aren't offered to or from them", () => {
    const l = create();
    lm.join(bob, l.id, 'pw', true);
    expect(() => lm.setReady(bob.id, true)).toThrow('NOT_SEATED');
    expect(() => lm.setColor(bob.id, 'blue')).toThrow('NOT_SEATED');
    expect(() => lm.askSwap(bob.id, 'red')).toThrow('NOT_SEATED');
    expect(() => lm.spectate(bob.id)).toThrow('NOT_SEATED');
  });

  it('nobody changes seat while a game runs', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    lm.join(carol, l.id, 'pw', true);
    lm.markPlaying(l.id, 'g1');
    expect(() => lm.spectate(bob.id)).toThrow('GAME_IN_PROGRESS');
    expect(() => lm.sit(carol.id, 'blue')).toThrow('GAME_IN_PROGRESS');
  });
});

describe('a watching host and bot battles', () => {
  it('the host can watch and still add bots, fill the seats and start a game of only bots', () => {
    const l = create();
    lm.spectate(alice.id);
    expect(lm.get(l.id)!.hostId).toBe(alice.id);
    lm.addBot(alice.id, 'green');
    lm.fillBots(alice.id);
    expect(seated(l.id).sort()).toEqual(['Bot Blue', 'Bot Green', 'Bot Red', 'Bot Yellow']);
    expect(lm.checkStart(alice.id).id).toBe(l.id);
  });

  it('"fill with bots" only fills open seats, and only for the host', () => {
    const l = create();
    lm.join(bob, l.id, 'pw');
    expect(() => lm.fillBots(bob.id)).toThrow('NOT_HOST');
    lm.fillBots(alice.id);
    expect(lm.get(l.id)!.members.map((m) => `${m.color}:${m.username}`)).toEqual(['red:u1', 'green:u2', 'yellow:Bot Yellow', 'blue:Bot Blue']);
  });

  it('after a bot battle the bots stay for the next one; after a normal game they go', () => {
    const l = create();
    lm.spectate(alice.id);
    lm.fillBots(alice.id);
    lm.markPlaying(l.id, 'g1');
    lm.finishGame(l.id, true);
    expect(lm.get(l.id)!.members.filter((m) => m.isBot)).toHaveLength(4);
    expect(lm.get(l.id)!.members.every((m) => m.ready)).toBe(true);
    expect(lm.get(l.id)!.status).toBe('waiting');
    lm.markPlaying(l.id, 'g2');
    lm.finishGame(l.id);
    expect(lm.get(l.id)!.members).toEqual([]);
    expect(watching(l.id)).toEqual(['u1']); // the lobby stays open for its spectator
  });
});

describe('leaving, hosts and cleanup with spectators', () => {
  it('the host role passes to a spectator if no player is left, and the lobby closes with the last person', () => {
    const l = create();
    lm.addBot(alice.id);
    lm.join(bob, l.id, 'pw', true);
    lm.leave(alice.id);
    expect(lm.get(l.id)!.hostId).toBe(bob.id);
    expect(onMemberLeft).toHaveBeenCalledWith(expect.objectContaining({ id: l.id }), alice.id);
    lm.leave(bob.id);
    expect(lm.get(l.id)).toBeUndefined();
    expect(onClosed).toHaveBeenCalled();
  });

  it('the host can kick a spectator', () => {
    const l = create();
    lm.join(bob, l.id, 'pw', true);
    lm.kick(alice.id, bob.id);
    expect(watching(l.id)).toEqual([]);
    expect(lm.forUser(bob.id)).toBeUndefined();
  });

  it('a spectator online keeps the lobby from going idle; offline spectators are dropped after a game', () => {
    const l = create();
    lm.join(bob, l.id, 'pw', true);
    lm.setConnected(alice.id, false);
    expect(lm.get(l.id)!.allOfflineSince).toBeNull();
    lm.setConnected(bob.id, false);
    expect(lm.get(l.id)!.allOfflineSince).not.toBeNull();
    lm.setConnected(alice.id, true);
    lm.markPlaying(l.id, 'g1');
    lm.finishGame(l.id);
    expect(watching(l.id)).toEqual([]);
    expect(onMemberLeft).toHaveBeenCalledWith(expect.anything(), bob.id);
  });

  it('renames reach spectators, and they are sent with their wins', () => {
    lm = new LobbyManager({ db, lobbyCreatePassword: 'secret', maxLobbies: 50, lobbyIdleCloseSec: 600, randomInt: () => 0, winsOf: (id) => id * 10 });
    const l = create();
    lm.join(bob, l.id, 'pw', true);
    lm.updateUser(bob.id, { username: 'bobby', avatar: '' });
    expect(lm.toPublic(lm.get(l.id)!).spectators).toEqual([{ userId: 2, username: 'bobby', connected: true, wins: 20 }]);
    expect(humanIds(lm.get(l.id)!)).toEqual([1, 2]);
  });

  it('spectators survive a restart (offline), and lobbies saved before spectators load with none', () => {
    const l = create();
    lm.join(bob, l.id, 'pw', true);
    const old = create(carol);
    const raw = JSON.parse((db.prepare('SELECT data FROM lobbies WHERE id = ?').get(old.id) as { data: string }).data);
    delete raw.spectators;
    db.prepare('UPDATE lobbies SET data = ? WHERE id = ?').run(JSON.stringify(raw), old.id);
    lm = make();
    lm.load();
    expect(lm.get(l.id)!.spectators).toEqual([{ userId: 2, username: 'u2', connected: false }]);
    expect(lm.forUser(bob.id)?.id).toBe(l.id);
    expect(lm.get(old.id)!.spectators).toEqual([]);
  });
});
