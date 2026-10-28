import { afterEach, describe, expect, it } from 'vitest';
import type { NetStats } from '../src/shared/net.js';
import type { LobbySummary, PublicGameState, PublicLobby } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import { client, createLobby, startTestServer, startTwoPlayerGame, wait, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

async function people(...names: string[]) {
  const cs = [];
  for (const n of names) cs.push(await client(t, n));
  clients.push(...cs);
  return cs;
}

describe('watching a game', () => {
  it('a spectator joins a running game, sees every update, and can do nothing but watch', async () => {
    t = await startTestServer({}, { dice: scriptedDice([4, 4]) });
    const [alice, bob, carol] = await people('alice', 'bob', 'carol');
    const gameId = await startTwoPlayerGame(alice, bob);
    const lobbyId = t.server.ctx.games.get(gameId)!.lobbyId;

    expect(await carol.emit('lobby:join', { lobbyId, password: 'pw' })).toEqual({ ok: false, error: 'GAME_IN_PROGRESS' });
    const first = carol.nextState();
    const joined = await carol.emit<PublicLobby>('lobby:join', { lobbyId, password: 'pw', watch: true });
    expect(joined.ok && joined.data!.spectators.map((s) => s.username)).toEqual(['carol']);
    expect((await first).state.id).toBe(gameId); // straight to the board

    const seen = carol.nextState((u) => u.state.version === 2);
    expect(await alice.emit('game:roll', { gameId, version: 1, actionId: crypto.randomUUID() })).toEqual({ ok: true });
    expect((await seen).events?.[0]).toMatchObject({ type: 'roll', value: 4 });

    const v = t.server.ctx.games.get(gameId)!.version;
    expect(await carol.emit('game:roll', { gameId, version: v, actionId: crypto.randomUUID() })).toMatchObject({ ok: false, error: 'NOT_YOUR_TURN' });
    expect(t.server.ctx.games.get(gameId)!.version).toBe(v);
    expect(await carol.emit('lobby:spectate', {})).toMatchObject({ ok: false, error: 'NOT_SEATED' });
    expect(await carol.emit('lobby:sit', { color: 'blue' })).toMatchObject({ ok: false, error: 'GAME_IN_PROGRESS' });

    // After a reload the spectator can fetch the game; a stranger can't.
    const resumed = await carol.emit<PublicGameState>('game:resume', { gameId });
    expect(resumed.ok && resumed.data!.id).toBe(gameId);
    const [dave] = await people('dave');
    expect(await dave.emit('game:resume', { gameId })).toMatchObject({ ok: false, error: 'NO_GAME' });

    // Spectators are in the lobby's voice chat too.
    expect((await carol.emit('voice:join', { lobbyId })).ok).toBe(true);
  });

  it('a spectator who leaves mid-game takes no seat with them, and stops getting updates', async () => {
    t = await startTestServer({}, { dice: scriptedDice([4, 4, 4]) });
    const [alice, bob, carol] = await people('alice', 'bob', 'carol');
    const gameId = await startTwoPlayerGame(alice, bob);
    const lobbyId = t.server.ctx.games.get(gameId)!.lobbyId;
    await carol.emit('lobby:join', { lobbyId, password: 'pw', watch: true });
    await carol.emit('lobby:leave', {});
    const before = carol.states.length;
    await alice.emit('game:roll', { gameId, version: 1, actionId: crypto.randomUUID() });
    await wait(100);
    expect(carol.states.length).toBe(before);
    expect(t.server.ctx.games.get(gameId)!.seats.map((s) => s.controller)).toEqual(['human', 'human']);
  });
});

describe('bot battle', () => {
  it('the host watches, fills the seats with bots and starts: the bots play it to the end on their own', async () => {
    t = await startTestServer({}, { botDelayMs: 0, animScale: 0 });
    const [alice] = await people('alice');
    await createLobby(alice);
    expect(await alice.emit('lobby:spectate', {})).toEqual({ ok: true });
    expect(await alice.emit('lobby:fillBots', {})).toEqual({ ok: true });
    const over = alice.nextState((u) => u.state.finished, 30_000);
    expect(await alice.emit('lobby:start', {})).toEqual({ ok: true });
    const end = (await over).state;
    expect(end.botBattle).toBe(true);
    expect(end.ranks).toHaveLength(4);
    await wait(50);
    // The lobby reopens with its bots still seated, ready for another round.
    const lobby = t.server.ctx.lobbies.forUser(alice.userId)!;
    expect(lobby.status).toBe('waiting');
    expect(lobby.members.filter((m) => m.isBot)).toHaveLength(4);
    expect(lobby.spectators.map((s) => s.userId)).toEqual([alice.userId]);
  });
});

describe('less data on the wire', () => {
  it('WebSocket messages are compressed', async () => {
    t = await startTestServer();
    const [alice] = await people('alice');
    const ws = (alice.socket.io.engine.transport as any).ws;
    expect(ws.extensions).toContain('permessage-deflate');
  });

  it("the lobby list goes out only when it changed, not when someone just gets ready", async () => {
    t = await startTestServer();
    const [alice, bob, carol] = await people('alice', 'bob', 'carol');
    const lists: LobbySummary[][] = [];
    carol.socket.on('lobby:list', (l: LobbySummary[]) => lists.push(l));
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    await wait(50);
    expect(lists.map((l) => l[0].players)).toEqual([1, 2]);
    await bob.emit('lobby:ready', { ready: true });
    await bob.emit('lobby:ready', { ready: false });
    await wait(50);
    expect(lists).toHaveLength(2);
    await carol.emit('lobby:join', { lobbyId, password: 'pw', watch: true });
    await wait(50);
    expect(lists.at(-1)![0]).toMatchObject({ players: 2, watching: 1 });
  });

  it('ping stats are sent when they change, not every few seconds', async () => {
    t = await startTestServer({}, { netIntervalMs: 120 });
    const [alice, bob] = await people('alice', 'bob');
    for (const c of [alice, bob]) c.socket.on('net:ping', (ack: () => void) => setTimeout(ack, 20)); // a steady 20 ms
    const stats: NetStats[] = [];
    alice.socket.on('net:stats', (s: NetStats) => stats.push(s));
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    await wait(2000); // about 16 rounds of pings
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.length).toBeLessThan(10);
  });
});

