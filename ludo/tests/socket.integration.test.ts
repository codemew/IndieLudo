import { afterEach, describe, expect, it } from 'vitest';
import { HOME } from '../src/shared/board.js';
import type { LobbySummary, PublicGameState } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import { ADMIN_PW, CREATE_PW, client, clientForToken, createLobby, http, startTestServer, startTwoPlayerGame, verifiedDevice, wait, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

async function players(dice: number[]) {
  t = await startTestServer({}, { dice: scriptedDice(dice) });
  const host = await client(t, 'alice');
  const guest = await client(t, 'bob');
  clients.push(host, guest);
  return { host, guest };
}

describe('full flow', () => {
  it('create lobby → join → start → roll → move, seen identically by both players', async () => {
    const { host, guest } = await players([6, 3]);
    const gameId = await startTwoPlayerGame(host, guest);
    let s = t.server.ctx.games.get(gameId)!;
    expect(s.seats.map((x) => [x.color, x.username])).toEqual([
      ['red', 'alice'],
      ['green', 'bob'],
    ]);

    expect(await host.emit('game:roll', { gameId, version: 1, actionId: crypto.randomUUID() })).toEqual({ ok: true });
    expect(await host.emit('game:roll', { gameId, version: 2, actionId: crypto.randomUUID() })).toEqual({ ok: true });
    s = t.server.ctx.games.get(gameId)!;
    expect(s.turn).toMatchObject({ phase: 'moving', queue: [6, 3] });

    expect(await host.emit('game:move', { gameId, version: 3, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 2 })).toEqual({ ok: true });
    const seen = guest.nextState((u) => u.state.version === 5);
    expect(await host.emit('game:move', { gameId, version: 4, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 2 })).toEqual({ ok: true });
    const update = await seen;
    expect(update.state.tokens.red).toEqual([-1, -1, 3, -1]);
    expect(update.events!.map((e) => e.type)).toEqual(['move', 'turn']);
    expect(update.state.turn.seat).toBe(1);
    expect(update.state.legalMoves).toEqual([]);
  });

  it('broadcasts the lobby list to everyone', async () => {
    const { host, guest } = await players([]);
    const listed = new Promise<LobbySummary[]>((res) => guest.socket.once('lobby:list', res));
    await host.emit('lobby:create', { createPassword: CREATE_PW, name: 'Fun room', password: 'pw' });
    const list = await listed;
    expect(list).toEqual([expect.objectContaining({ name: 'Fun room', hostName: 'alice', players: 1, status: 'waiting' })]);
    expect(JSON.stringify(list)).not.toContain('pw');
  });

  it('creator and joiner both receive the lobby state', async () => {
    const { host, guest } = await players([]);
    const hostState = new Promise<any>((res) => host.socket.on('lobby:state', (l: any) => l && res(l)));
    const lobbyId = await createLobby(host);
    expect((await hostState).members.map((m: any) => m.username)).toEqual(['alice']);
    const guestState = new Promise<any>((res) => guest.socket.on('lobby:state', (l: any) => l?.members.length === 2 && res(l)));
    await guest.emit('lobby:join', { lobbyId, password: 'pw' });
    expect((await guestState).members.map((m: any) => m.username)).toEqual(['alice', 'bob']);
  });

  it('kicked players are told they left', async () => {
    const { host, guest } = await players([]);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId: lobbyId, password: 'pw' });
    const nullState = new Promise((res) => guest.socket.on('lobby:state', (s: unknown) => s === null && res(s)));
    expect(await host.emit('lobby:kick', { userId: guest.userId })).toEqual({ ok: true });
    await nullState;
    expect(t.server.ctx.lobbies.forUser(guest.userId)).toBeUndefined();
  });
});

describe('reconnect', () => {
  it('a client dropped mid-turn resumes at the same state version', async () => {
    const { host, guest } = await players([6, 6, 2]);
    const gameId = await startTwoPlayerGame(host, guest);
    await host.emit('game:roll', { gameId, version: 1, actionId: crypto.randomUUID() });

    const offline = host.nextState((u) => u.state.seats[1].connected === false);
    guest.socket.disconnect();
    await offline;

    await host.emit('game:roll', { gameId, version: 2, actionId: crypto.randomUUID() });
    const version = t.server.ctx.games.get(gameId)!.version;

    const back = await clientForToken(t.base, guest.token, guest.userId);
    clients.push(back);
    expect(back.hello.game?.version).toBe(version);
    expect(back.hello.game?.turn.queue).toEqual([6, 6]);
    expect(back.hello.lobby?.status).toBe('playing');
    const resumed = await back.emit<PublicGameState>('game:resume', { gameId });
    expect(resumed.ok && resumed.data!.version).toBe(version);
    expect(t.server.ctx.games.get(gameId)!.seats[1].connected).toBe(true);
    // The rejoined socket gets live updates again.
    const live = back.nextState();
    await host.emit('game:roll', { gameId, version, actionId: crypto.randomUUID() });
    expect((await live).state.version).toBe(version + 1);
  });

  it('resume of someone else\'s game is refused', async () => {
    const { host, guest } = await players([]);
    const gameId = await startTwoPlayerGame(host, guest);
    const stranger = await client(t, 'mallory');
    clients.push(stranger);
    expect(await stranger.emit('game:resume', { gameId })).toEqual({ ok: false, error: 'NO_GAME' });
  });
});

describe('game end', () => {
  it('records stats, sends results and reopens the lobby; offline players are removed', async () => {
    t = await startTestServer({}, { dice: scriptedDice([2]) });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    const third = await client(t, 'carol');
    clients.push(host, guest, third);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId: lobbyId, password: 'pw' });
    await third.emit('lobby:join', { lobbyId: lobbyId, password: 'pw' });
    await guest.emit('lobby:ready', { ready: true });
    await third.emit('lobby:ready', { ready: true });
    await host.emit('lobby:addBot', {});
    const first = host.nextState();
    await host.emit('lobby:start', {});
    const gameId = (await first).state.id;

    third.socket.disconnect();
    await wait(50);

    const s = t.server.ctx.games.get(gameId)!;
    s.tokens.red = [HOME, HOME, HOME, 54];
    s.tokens.green = [HOME, HOME, HOME, 50];
    s.tokens.yellow = [HOME, HOME, HOME, 50];
    s.ranks = ['green', 'yellow'];
    const final = host.nextState((u) => u.state.finished);
    await host.emit('game:roll', { gameId, version: s.version, actionId: crypto.randomUUID() });
    await host.emit('game:move', { gameId, version: s.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 3 });
    const done = await final;
    expect(done.state.ranks).toEqual(['green', 'yellow', 'red', 'blue']);
    expect(done.events!.at(-1)).toMatchObject({ type: 'gameOver' });

    const lobby = t.server.ctx.lobbies.get(lobbyId)!;
    expect(lobby.status).toBe('waiting');
    expect(lobby.members.map((m) => m.username)).toEqual(['alice', 'bob']);
    expect(t.server.ctx.users.get(host.userId)).toMatchObject({ games_played: 1, wins: 0 });
    expect(t.server.ctx.users.get(guest.userId)).toMatchObject({ games_played: 1, wins: 1 });

    // The offline player sees the result when they come back.
    const back = await clientForToken(t.base, third.token, third.userId);
    clients.push(back);
    expect(back.hello.lobby).toBeNull();
    const r = await back.emit<PublicGameState>('game:resume', { gameId });
    expect(r.ok && r.data!.finished).toBe(true);
  });
});

describe('admin actions reach live sockets', () => {
  it('deleting a user mid-game hands their seat to a bot and kicks their socket', async () => {
    const { host, guest } = await players(Array(20).fill(1));
    const gameId = await startTwoPlayerGame(host, guest);
    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token;
    const revoked = new Promise((res) => guest.socket.once('session:revoked', res));
    expect((await http(t.base, 'DELETE', `/api/admin/users/${guest.userId}`, { session: admin })).status).toBe(200);
    await revoked;
    expect(t.server.ctx.games.get(gameId)!.seats[1]).toMatchObject({ controller: 'bot', userId: null });
  });

  it('renaming a user updates their lobby seat', async () => {
    const { host } = await players([]);
    await host.emit('lobby:create', { createPassword: CREATE_PW, name: 'R', password: 'pw' });
    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token;
    await http(t.base, 'PATCH', `/api/admin/users/${host.userId}`, { session: admin, body: { username: 'alicia' } });
    expect(t.server.ctx.lobbies.forUser(host.userId)!.members[0].username).toBe('alicia');
  });
});
