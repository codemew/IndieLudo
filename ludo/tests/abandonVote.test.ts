import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbandonVotes } from '../src/server/abandonVote.js';
import type { AbandonVote, AbandonVoteEnd, PublicLobby } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import { client, startTwoPlayerGame, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

const alice = { userId: 1, username: 'alice' };
const bob = { userId: 2, username: 'bob' };
const carol = { userId: 3, username: 'carol' };

function votes() {
  const changes: AbandonVote[] = [];
  const ends: [string, AbandonVoteEnd][] = [];
  const passed: string[] = [];
  const v = new AbandonVotes({
    onChange: (x) => changes.push(structuredClone(x)),
    onEnd: (g, e) => ends.push([g, e]),
    onPass: (g) => passed.push(g),
    durationMs: 1000,
    now: () => 0,
  });
  return { v, changes, ends, passed };
}

describe('votes to abandon a game', () => {
  afterEach(() => vi.useRealTimers());

  it("the host's own answer is yes; everyone else saying yes abandons the game", () => {
    const { v, changes, ends, passed } = votes();
    v.start('g', alice, [alice, bob, carol]);
    expect(changes[0].voters.map((x) => x.vote)).toEqual([true, null, null]);
    v.answer('g', 2, true);
    expect(passed).toEqual([]);
    v.answer('g', 3, true);
    expect(passed).toEqual(['g']);
    expect(ends).toEqual([['g', { how: 'passed' }]]);
    expect(v.get('g')).toBeUndefined();
  });

  it('one no ends it; so does time running out; answers are checked', () => {
    vi.useFakeTimers();
    const { v, ends, passed } = votes();
    v.start('g', alice, [alice, bob, carol]);
    expect(() => v.start('g', alice, [alice, bob])).toThrow('VOTE_RUNNING');
    expect(() => v.answer('g', 9, true)).toThrow('NOT_A_VOTER');
    v.answer('g', 2, true);
    expect(() => v.answer('g', 2, false)).toThrow('ALREADY_VOTED');
    v.answer('g', 3, false);
    expect(ends.at(-1)).toEqual(['g', { how: 'refused', by: 'carol' }]);
    expect(() => v.answer('g', 3, true)).toThrow('NO_VOTE');
    v.start('h', alice, [alice, bob]);
    vi.advanceTimersByTime(1001);
    expect(ends.at(-1)).toEqual(['h', { how: 'expired' }]);
    expect(passed).toEqual([]);
  });

  it('alone with bots it passes at once; a player who leaves stops counting; the game ending cancels it', () => {
    const { v, ends, passed } = votes();
    v.start('solo', alice, [alice]);
    expect(passed).toEqual(['solo']);
    v.start('g', alice, [alice, bob, carol]);
    v.answer('g', 2, true);
    v.dropVoter('g', 3);
    expect(passed).toEqual(['solo', 'g']);
    // A host who isn't playing (watching a bot battle) can ask too; a game that ends drops the vote.
    v.start('k', carol, [alice, bob]);
    v.cancel('k');
    expect(ends.at(-1)).toEqual(['k', { how: 'cancelled' }]);
  });
});

describe('a vote to abandon over the wire', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the host asks, the other player says yes: the game is gone, no winner, no stats, no match history; the lobby waits again', async () => {
    t = await startTestServer({}, { dice: scriptedDice(Array(40).fill(1)) });
    const a = await client(t, 'alice');
    const b = await client(t, 'bob');
    clients.push(a, b);
    const gameId = await startTwoPlayerGame(a, b);
    const lobbyId = t.server.ctx.lobbies.forUser(a.userId)!.id;
    expect(await b.emit('game:abandonVote', { gameId })).toEqual({ ok: false, error: 'NOT_HOST' });
    const asked = new Promise<AbandonVote>((r) => b.socket.once('game:abandonVote', r));
    expect((await a.emit('game:abandonVote', { gameId })).ok).toBe(true);
    const vote = await asked;
    expect(vote.voters.map((v) => [v.username, v.vote])).toEqual([
      ['alice', true],
      ['bob', null],
    ]);
    expect(await a.emit('game:abandonVote', { gameId })).toEqual({ ok: false, error: 'VOTE_RUNNING' });
    const abandoned = new Promise((r) => a.socket.once('game:abandoned', r));
    const waiting = new Promise<PublicLobby>((r) => a.socket.on('lobby:state', (l: PublicLobby | null) => l?.status === 'waiting' && r(l)));
    expect((await b.emit('game:abandonAnswer', { gameId, yes: true })).ok).toBe(true);
    expect(await abandoned).toEqual({ gameId });
    expect((await waiting).gameId).toBeNull();
    expect(t.server.ctx.games.get(gameId)).toBeUndefined();
    expect(t.server.ctx.db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)).toBeUndefined();
    expect(t.server.ctx.history.list().matches).toEqual([]);
    expect(t.server.ctx.users.get(a.userId)).toMatchObject({ wins: 0, games_played: 0 });
    expect(t.server.ctx.lobbies.get(lobbyId)!.status).toBe('waiting');
  });

  it('a no lets the game go on, and everyone is told who', async () => {
    t = await startTestServer({}, { dice: scriptedDice(Array(40).fill(1)) });
    const a = await client(t, 'alice');
    const b = await client(t, 'bob');
    clients.push(a, b);
    const gameId = await startTwoPlayerGame(a, b);
    await a.emit('game:abandonVote', { gameId });
    const ended = new Promise((r) => a.socket.once('game:abandonVoteEnd', r));
    await b.emit('game:abandonAnswer', { gameId, yes: false });
    expect(await ended).toEqual({ gameId, how: 'refused', by: 'bob' });
    await wait(30);
    expect(t.server.ctx.games.get(gameId)!.finished).toBe(false);
  });
});
