import { afterEach, describe, expect, it } from 'vitest';
import { HIDDEN } from '../src/shared/board.js';
import type { GameUpdate } from '../src/shared/protocol.js';
import type { PublicGameState, PublicLobby } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import { CREATE_PW, client, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

async function join(name: string): Promise<TestClient> {
  const c = await client(t, name);
  clients.push(c);
  return c;
}

/** Alice hosts with the rules given, bob plays, carol watches; the game starts with alice to move (red). */
async function powerGame(rules: { powerUps?: boolean; golden?: boolean }) {
  const alice = await join('alice');
  const bob = await join('bob');
  const carol = await join('carol');
  const created = await alice.emit<PublicLobby>('lobby:create', { createPassword: CREATE_PW, name: 'P', password: 'pw' });
  const lobbyId = created.ok ? created.data!.id : '';
  await bob.emit('lobby:join', { lobbyId, password: 'pw' });
  await carol.emit('lobby:join', { lobbyId, password: 'pw', watch: true });
  expect(await bob.emit('lobby:rules', rules)).toEqual({ ok: false, error: 'NOT_HOST' });
  expect((await alice.emit('lobby:rules', rules)).ok).toBe(true);
  await bob.emit('lobby:ready', { ready: true });
  const first = carol.nextState();
  expect((await alice.emit('lobby:start', {})).ok).toBe(true);
  const gameId = (await first).state.id;
  return { alice, bob, carol, gameId, lobbyId };
}

const last = (c: TestClient, gameId: string) => [...c.states].reverse().find((u) => u.state.id === gameId)!;

describe('power ups and golden token over the wire', () => {
  it('the host turns them on in the lobby; the game starts with orbs and golden tokens, and the shuffle seed stays on the server', async () => {
    t = await startTestServer({}, { dice: scriptedDice(Array(40).fill(1)), randomInt: (min) => min + 1 });
    const { alice, bob, carol, gameId, lobbyId } = await powerGame({ powerUps: true, golden: true });
    const lobby = t.server.ctx.lobbies.get(lobbyId)!;
    expect([lobby.powerUps, lobby.golden]).toEqual([true, true]);
    expect(t.server.ctx.lobbies.summaries()[0]).toMatchObject({ powerUps: true, golden: true });
    const server = t.server.ctx.games.get(gameId)!;
    expect(server.orbSeed).toBeGreaterThan(0);
    for (const c of [alice, bob, carol]) {
      const s = last(c, gameId).state;
      expect(s.powerUps).toBe(true);
      expect(s.orbs).toHaveLength(4);
      expect(s.golden).toEqual(server.golden);
      expect('orbSeed' in s).toBe(false);
    }
    // Nor in a resume, or in what a reconnecting phone is sent.
    const r = await bob.emit<PublicGameState>('game:resume', { gameId });
    expect(r.ok && 'orbSeed' in r.data!).toBe(false);
  });

  it("a cloaked token's square and moves reach only its owner: the opponent and spectators see nothing of it", async () => {
    t = await startTestServer({}, { dice: scriptedDice([2, 1, 1, 1, 1, 1, 1, 1]), randomInt: () => 0 });
    const { alice, bob, carol, gameId } = await powerGame({ powerUps: true });
    const st = t.server.ctx.games.get(gameId)!;
    const red = st.seats.find((s) => s.username === 'alice')!.color;
    expect(st.seats[st.turn.seat].color).toBe(red);
    st.orbs = [];
    st.tokens[red][0] = 10;
    st.powers = { [red]: ['cloak', null, null, null] };
    const v0 = st.version;
    const moved = (u: GameUpdate) => u.state.version === v0 + 2;
    const seen = { bob: bob.nextState(moved), carol: carol.nextState(moved), alice: alice.nextState(moved) };
    expect((await alice.emit('game:roll', { gameId, version: v0, actionId: 'roll-0001' })).ok).toBe(true);
    // One token can move: alice plays it.
    await wait(30);
    expect((await alice.emit('game:move', { gameId, version: v0 + 1, actionId: 'move-0001', dieIndex: 0, tokenId: 0 })).ok).toBe(true);
    const [b, c, a] = (await Promise.all([seen.bob, seen.carol, seen.alice])) as GameUpdate[];
    expect(st.tokens[red][0]).toBe(12);
    expect(a.state.tokens[red][0]).toBe(12);
    expect(a.events!.some((e) => e.type === 'move')).toBe(true);
    for (const u of [b, c]) {
      expect(u.state.tokens[red][0]).toBe(HIDDEN);
      expect(u.events!.some((e) => e.type === 'move')).toBe(false);
      expect(JSON.stringify(u)).not.toContain('"to":12');
    }
    // Asking again gives the same answer.
    const r = await bob.emit<PublicGameState>('game:resume', { gameId });
    expect(r.ok && r.data!.tokens[red][0]).toBe(HIDDEN);
    const mine = await alice.emit<PublicGameState>('game:resume', { gameId });
    expect(mine.ok && mine.data!.tokens[red][0]).toBe(12);
  });
});
