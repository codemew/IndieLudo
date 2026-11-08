import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/server/db.js';
import { MatchHistory, summarize } from '../src/server/history.js';
import { applySurrender, createGameState } from '../src/shared/rules.js';
import type { Color, GameState } from '../src/shared/types.js';
import { seat } from './helpers.js';
import { http, signup, startTestServer, type TestServer } from './serverHelpers.js';

let db: DB;
function save(s: GameState, endedAt: number): void {
  db.prepare('INSERT INTO games (id, lobby_id, state_json, version, updated_at, finished) VALUES (?, ?, ?, ?, ?, ?)').run(
    s.id,
    s.lobbyId,
    JSON.stringify(s),
    s.version,
    endedAt,
    s.finished ? 1 : 0,
  );
}

/** A finished game: the players surrender in the order given, so the last one left wins. */
function finished(
  id: string,
  colors: Color[],
  users: (number | null)[],
  surrenderOrder: Color[],
  extra: Partial<Parameters<typeof createGameState>[0]> = {},
): GameState {
  const s = createGameState({
    id,
    lobbyId: 'L',
    seats: colors.map((c, i) => ({ ...seat(c, users[i], users[i] === null ? 'bot' : 'human'), username: users[i] === null ? `Bot ${c}` : `u${users[i]}` })),
    now: 1000,
    ...extra,
  });
  for (const c of surrenderOrder) applySurrender(s, c);
  return s;
}

describe('the match history', () => {
  it('finished matches newest first, a page at a time, with places, winners and awards; dropped games left out', () => {
    db = openDb(':memory:');
    const h = new MatchHistory(db);
    for (let i = 0; i < 25; i++) save(finished(`g${i}`, ['red', 'green'], [1, 2], ['green']), 10_000 + i);
    // Dropped when its lobby closed: finished, but nobody won.
    const dropped = createGameState({ id: 'dropped', lobbyId: 'L', seats: [seat('red', 1), seat('green', 2)] });
    dropped.finished = true;
    save(dropped, 99_999);
    // Still being played.
    save(createGameState({ id: 'live', lobbyId: 'L', seats: [seat('red', 1), seat('green', 2)] }), 99_998);
    const first = h.list();
    expect(first.matches).toHaveLength(20);
    expect(first.more).toBe(true);
    expect(first.matches[0].id).toBe('g24');
    expect(first.matches[0].players.map((p) => [p.username, p.place, p.won])).toEqual([
      ['u1', 1, true],
      ['u2', 2, false],
    ]);
    expect(first.matches[0].players[1].surrendered).toBe(true);
    const next = h.list({ before: first.matches.at(-1)!.endedAt });
    expect(next.matches.map((m) => m.id)).toEqual(['g4', 'g3', 'g2', 'g1', 'g0']);
    expect(next.more).toBe(false);
    expect(h.get('dropped')).toBeUndefined();
    expect(h.get('live')).toBeUndefined();
    expect(h.get('g3')!.endedAt).toBe(10_003);
  });

  it('only mine: the matches I played, also one I left before the end (a bot played on)', () => {
    db = openDb(':memory:');
    const h = new MatchHistory(db);
    save(finished('a', ['red', 'green'], [1, 2], ['green']), 1);
    save(finished('b', ['red', 'green'], [3, 2], ['red']), 2);
    const left = finished('c', ['red', 'green', 'yellow'], [1, 4, null], []);
    left.seats[0] = { ...left.seats[0], userId: null, controller: 'bot', leftBy: 1 };
    applySurrender(left, 'yellow');
    applySurrender(left, 'green');
    save(left, 3);
    expect(h.list({ userId: 1 }).matches.map((m) => m.id)).toEqual(['c', 'a']);
    expect(h.list({ userId: 2 }).matches.map((m) => m.id)).toEqual(['b', 'a']);
    const c = h.list({ userId: 1 }).matches[0];
    expect(c.players[0]).toMatchObject({ username: 'u1', userId: 1, bot: false, left: true, won: true });
    expect(c.players.find((p) => p.color === 'yellow')).toMatchObject({ bot: true, userId: null });
  });

  it('Team-up places both winners first; the rules played are listed; awards go to their players', () => {
    const s = finished('t', ['red', 'green', 'yellow', 'blue'], [1, 2, 3, 4], ['green'], {
      teams: true,
      share: true,
      powerUps: { seed: 3 },
      golden: { red: 0 },
    });
    s.stats = { red: { cells: 40, captures: 2, sixes: 5, revenges: 0, firstBlood: true, owed: {} } };
    const m = summarize(s, 5);
    expect(m).toMatchObject({ teams: true, share: true, powerUps: true, golden: true, board: 4, startedAt: 1000, endedAt: 5 });
    expect(m.players.map((p) => [p.color, p.place])).toEqual([
      ['red', 1],
      ['yellow', 1],
      ['blue', 2],
      ['green', 2],
    ]);
    expect(m.players[0].awards.map((a) => a.title)).toEqual(['Most cells travelled', 'Most tokens captured', 'Most sixes', 'First blood']);
    expect(m.players[1].awards).toEqual([]);
  });
});

describe('the match history over the API', () => {
  let t: TestServer;
  afterEach(async () => t?.close());

  it('signed-in players see every match or only theirs, and open one whole; the server keeps the power-up seed', async () => {
    t = await startTestServer();
    const alice = await signup(t, 'alice');
    const bob = await signup(t, 'bob');
    db = t.server.ctx.db;
    save(finished('m1', ['red', 'green'], [alice.userId, bob.userId], ['green'], { powerUps: { seed: 9 } }), 100);
    save(finished('m2', ['red', 'green'], [bob.userId, null], ['green']), 200);
    expect((await http(t.base, 'GET', '/api/history')).status).toBe(401);
    const all = await http(t.base, 'GET', '/api/history', { session: alice.token });
    expect(all.json.matches.map((m: { id: string }) => m.id)).toEqual(['m2', 'm1']);
    const mine = await http(t.base, 'GET', '/api/history?mine=1', { session: alice.token });
    expect(mine.json.matches.map((m: { id: string }) => m.id)).toEqual(['m1']);
    expect((await http(t.base, 'GET', '/api/history?before=150', { session: alice.token })).json.matches.map((m: { id: string }) => m.id)).toEqual(['m1']);
    expect((await http(t.base, 'GET', '/api/history?before=soon', { session: alice.token })).status).toBe(400);
    const one = await http(t.base, 'GET', '/api/history/m1', { session: alice.token });
    expect(one.json.match).toMatchObject({ id: 'm1', endedAt: 100, finished: true });
    expect('orbSeed' in one.json.match).toBe(false);
    expect((await http(t.base, 'GET', '/api/history/nope', { session: alice.token })).status).toBe(404);
  });
});
