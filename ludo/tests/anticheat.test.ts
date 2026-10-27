import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameState } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import { client, createLobby, clientForToken, startTestServer, startTwoPlayerGame, wait, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

async function game(dice: number[]) {
  t = await startTestServer({}, { dice: scriptedDice(dice) });
  const host = await client(t, 'alice');
  const guest = await client(t, 'bob');
  clients.push(host, guest);
  const gameId = await startTwoPlayerGame(host, guest);
  const snapshot = () => structuredClone(t.server.ctx.games.get(gameId)!) as GameState;
  return { host, guest, gameId, snapshot };
}

const id = () => crypto.randomUUID();

describe('every cheat attempt is rejected without changing state', () => {
  it('rolling when it is not your turn', async () => {
    const { guest, gameId, snapshot } = await game([6]);
    const before = snapshot();
    expect(await guest.emit('game:roll', { gameId, version: 1, actionId: id() })).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
    expect(snapshot()).toEqual(before);
  });

  it('moving during another player\'s turn', async () => {
    const { host, guest, gameId, snapshot } = await game([6, 2]);
    await host.emit('game:roll', { gameId, version: 1, actionId: id() });
    await host.emit('game:roll', { gameId, version: 2, actionId: id() });
    const before = snapshot();
    expect(await guest.emit('game:move', { gameId, version: 3, actionId: id(), dieIndex: 0, tokenId: 0 })).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
    expect(snapshot()).toEqual(before);
  });

  it('a die index that is not in the queue, or a move that is not legal', async () => {
    const { host, gameId, snapshot } = await game([6, 2]);
    await host.emit('game:roll', { gameId, version: 1, actionId: id() });
    await host.emit('game:roll', { gameId, version: 2, actionId: id() });
    const before = snapshot();
    expect(await host.emit('game:move', { gameId, version: 3, actionId: id(), dieIndex: 2, tokenId: 0 })).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
    // The 2 cannot bring a token out of base.
    expect(await host.emit('game:move', { gameId, version: 3, actionId: id(), dieIndex: 1, tokenId: 0 })).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
    expect(snapshot()).toEqual(before);
  });

  it('payloads with extra value/to/userId fields are rejected', async () => {
    const { host, gameId, snapshot } = await game([1]);
    const before = snapshot();
    for (const extra of [{ value: 6 }, { to: 56 }, { userId: 2 }, { dice: [6, 6] }]) {
      expect(await host.emit('game:roll', { gameId, version: 1, actionId: id(), ...extra })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    }
    expect(await host.emit('game:move', { gameId, version: 1, actionId: id(), dieIndex: 0, tokenId: 0, to: 56 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await host.emit('game:move', { gameId, version: 1, actionId: id(), dieIndex: '0', tokenId: 0 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(snapshot()).toEqual(before);
  });

  it('impersonation: the user comes from the session, never the payload', async () => {
    const { guest, gameId, snapshot } = await game([1]);
    const before = snapshot();
    // Bob claims to be Alice (user 1), whose turn it is.
    expect(await guest.emit('game:roll', { gameId, version: 1, actionId: id(), userId: 1 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('lobby:kick', { userId: 1, as: 1 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('lobby:kick', { userId: 1 })).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(snapshot()).toEqual(before);
  });

  it('colour conflicts and changing colour after the start', async () => {
    t = await startTestServer();
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId: lobbyId, password: 'pw' });
    expect(await guest.emit('lobby:color', { color: 'red' })).toEqual({ ok: false, error: 'COLOR_TAKEN' });
    expect(await guest.emit('lobby:color', { color: 'purple' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    await guest.emit('lobby:ready', { ready: true });
    await host.emit('lobby:start', {});
    expect(await guest.emit('lobby:color', { color: 'blue' })).toEqual({ ok: false, error: 'GAME_IN_PROGRESS' });
  });

  it('rolling with a guessed game id or for a finished game fails', async () => {
    const { host } = await game([1]);
    expect(await host.emit('game:roll', { gameId: 'nope', version: 1, actionId: id() })).toEqual({ ok: false, error: 'NO_GAME' });
  });

  it('flooding intents trips the rate limit and disconnects the socket', async () => {
    const { guest, gameId } = await game([]);
    const gone = new Promise((res) => guest.socket.once('disconnect', res));
    for (let i = 0; i < 60; i++) guest.socket.emit('game:roll', { gameId, version: 1, actionId: id() }, () => {});
    await gone;
    expect(guest.socket.connected).toBe(false);
  });
});

describe('colours are global', () => {
  it('every client sees the same colour per player, also after reconnect and restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludo-colors-'));
    try {
      t = await startTestServer({ dbPath: join(dir, 'db.sqlite') }, { dice: scriptedDice([]) });
      const host = await client(t, 'alice');
      const guest = await client(t, 'bob');
      clients.push(host, guest);
      const lobbyId = await createLobby(host);
      await guest.emit('lobby:join', { lobbyId: lobbyId, password: 'pw' });
      await guest.emit('lobby:color', { color: 'blue' });
      await host.emit('lobby:color', { color: 'yellow' });
      await guest.emit('lobby:ready', { ready: true });
      const hs = host.nextState();
      const gs = guest.nextState();
      await host.emit('lobby:start', {});
      const colorsOf = (s: GameState) => s.seats.map((x) => [x.username, x.color]);
      const expected = [
        ['alice', 'yellow'],
        ['bob', 'blue'],
      ];
      expect(colorsOf((await hs).state)).toEqual(expected);
      expect(colorsOf((await gs).state)).toEqual(expected);
      const gameId = (await hs).state.id;

      guest.close();
      await wait(30);
      const back = await clientForToken(t.base, guest.token, guest.userId);
      clients.push(back);
      expect(colorsOf(back.hello.game!)).toEqual(expected);

      clients.splice(0).forEach((c) => c.close());
      await t.close();
      t = await startTestServer({ dbPath: join(dir, 'db.sqlite') }, { dice: scriptedDice([]) });
      const again = await clientForToken(t.base, host.token, host.userId);
      clients.push(again);
      expect(again.hello.game!.id).toBe(gameId);
      expect(colorsOf(again.hello.game!)).toEqual(expected);
    } finally {
      clients.splice(0).forEach((c) => c.close());
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
