import { afterEach, describe, expect, it } from 'vitest';
import { BASE } from '../src/shared/board.js';
import type { PublicLobby } from '../src/shared/types.js';
import { client, createLobby, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

describe('the time to move after a roll, set by the host', () => {
  it('5 to 10 seconds in whole seconds, the host only; it starts at the server setting; changing it keeps everyone ready', async () => {
    t = await startTestServer({ moveTimeoutSec: 7 });
    const a = await client(t, 'alice');
    const b = await client(t, 'bob');
    clients.push(a, b);
    const lobbyId = await createLobby(a);
    await b.emit('lobby:join', { lobbyId, password: 'pw' });
    expect(t.server.ctx.lobbies.toPublic(t.server.ctx.lobbies.get(lobbyId)!).moveSeconds).toBe(7);
    await b.emit('lobby:ready', { ready: true });
    expect(await b.emit('lobby:rules', { moveSeconds: 8 })).toEqual({ ok: false, error: 'NOT_HOST' });
    for (const bad of [4, 11, 7.5])
      expect(await a.emit('lobby:rules', { moveSeconds: bad })).toEqual({ ok: false, error: bad === 7.5 ? 'BAD_PAYLOAD' : 'BAD_MOVE_TIME' });
    const seen = new Promise<PublicLobby>((r) => b.socket.on('lobby:state', (l: PublicLobby) => l.moveSeconds === 9 && r(l)));
    expect((await a.emit('lobby:rules', { moveSeconds: 9 })).ok).toBe(true);
    const l = await seen;
    expect(l.members.find((m) => m.username === 'bob')!.ready).toBe(true);
  });

  it("the game gives that long to pick a token after a roll (rolling keeps the server's turn time)", async () => {
    const dice: number[] = [];
    t = await startTestServer({ turnTimeoutSec: 30 }, { dice: () => dice.shift() ?? 1 });
    const a = await client(t, 'alice');
    const b = await client(t, 'bob');
    clients.push(a, b);
    const lobbyId = await createLobby(a);
    await b.emit('lobby:join', { lobbyId, password: 'pw' });
    await a.emit('lobby:rules', { moveSeconds: 8 });
    await b.emit('lobby:ready', { ready: true });
    await a.emit('lobby:start', {});
    const game = t.server.ctx.games.get(t.server.ctx.lobbies.get(lobbyId)!.gameId!)!;
    expect(game.moveSeconds).toBe(8);
    const me = game.seats[game.turn.seat];
    const roller = me.userId === a.userId ? a : b;
    // Two tokens out: a 2 is a real choice.
    game.tokens[me.color] = [0, 5, BASE, BASE];
    game.turn.queue = [];
    game.turn.phase = 'rolling';
    dice.push(2);
    const before = Date.now();
    expect((await roller.emit('game:roll', { gameId: game.id, version: game.version, actionId: 'roll-00001' })).ok).toBe(true);
    expect(game.turn.phase).toBe('moving');
    // 8 s, plus the time the phones take to show the roll.
    const left = game.turn.deadline - before;
    expect(left).toBeGreaterThan(8000);
    expect(left).toBeLessThan(8000 + 1600);
  });
});
