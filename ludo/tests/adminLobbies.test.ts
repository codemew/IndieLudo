import { afterEach, describe, expect, it } from 'vitest';
import { scriptedDice } from './helpers.js';
import { ADMIN_PW, client, createLobby, http, startTestServer, verifiedDevice, wait, type TestClient, type TestServer } from './serverHelpers.js';

describe('admin: closing lobbies', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  const adminToken = async () => (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token as string;

  async function lobbyWithTwo() {
    t = await startTestServer({}, { dice: scriptedDice(Array(50).fill(1)) });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId, password: 'pw' });
    return { host, guest, lobbyId };
  }

  it('lists lobbies with their members, and only admins may', async () => {
    const { host, lobbyId } = await lobbyWithTwo();
    expect((await http(t.base, 'GET', '/api/admin/lobbies', { session: host.token })).status).toBe(403);
    const r = await http(t.base, 'GET', '/api/admin/lobbies', { session: await adminToken() });
    expect(r.status).toBe(200);
    expect(r.json).toEqual([
      expect.objectContaining({
        id: lobbyId,
        hostName: 'alice',
        status: 'waiting',
        players: 2,
        members: [
          { username: 'alice', isBot: false, connected: true },
          { username: 'bob', isBot: false, connected: true },
        ],
      }),
    ]);
  });

  it('closes a lobby mid-game: everyone is told, the game stops, the lobby is gone', async () => {
    const { host, guest, lobbyId } = await lobbyWithTwo();
    await guest.emit('lobby:ready', { ready: true });
    const first = host.nextState();
    await host.emit('lobby:start', {});
    const gameId = (await first).state.id;
    await host.emit('voice:join', { lobbyId });

    const told = new Promise((res) => guest.socket.once('lobby:closed', res));
    const admin = await adminToken();
    expect((await http(t.base, 'DELETE', `/api/admin/lobbies/${lobbyId}`, { session: host.token })).status).toBe(403);
    expect((await http(t.base, 'DELETE', `/api/admin/lobbies/${lobbyId}`, { session: admin })).status).toBe(200);
    expect(await told).toEqual({ byAdmin: true });
    await wait(50);

    expect(guest.lobbyStates.at(-1)).toBeNull();
    expect(host.lobbyStates.at(-1)).toBeNull();
    expect(t.server.ctx.lobbies.get(lobbyId)).toBeUndefined();
    expect(t.server.ctx.games.get(gameId)).toBeUndefined();
    expect(t.server.ctx.voice.state(lobbyId).participants).toEqual([]);
    // Both are free to start or join another lobby.
    expect(await host.emit('lobby:create', { createPassword: 'create-pw', name: 'Again', password: 'pw' })).toMatchObject({ ok: true });
    expect((await http(t.base, 'DELETE', `/api/admin/lobbies/${lobbyId}`, { session: admin })).json).toEqual({ error: 'LOBBY_NOT_FOUND' });
  });
});

describe('players renaming themselves', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('changes the name everywhere: account, lobby seat and running game', async () => {
    t = await startTestServer({}, { dice: scriptedDice(Array(50).fill(1)) });
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    await bob.emit('lobby:ready', { ready: true });
    const first = alice.nextState();
    await alice.emit('lobby:start', {});
    await first;

    const seen = bob.nextState((u) => u.state.seats.some((s) => s.username === 'Alicia'));
    const r = await http(t.base, 'PATCH', '/api/me', { session: alice.token, body: { username: 'Alicia' } });
    expect(r).toMatchObject({ status: 200, json: { user: { id: alice.userId, username: 'Alicia' } } });
    await seen;
    expect(t.server.ctx.lobbies.get(lobbyId)!.members.find((m) => m.userId === alice.userId)!.username).toBe('Alicia');
    expect((await http(t.base, 'GET', '/api/me', { session: alice.token })).json.user.username).toBe('Alicia');
  });

  it('a name changed on the home screen is the one used when they then create or join a lobby (the bug)', async () => {
    t = await startTestServer();
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    // Both rename while connected but not in any lobby; the sockets were opened with the old names.
    await http(t.base, 'PATCH', '/api/me', { session: alice.token, body: { username: 'Alicia' } });
    await http(t.base, 'PATCH', '/api/me', { session: bob.token, body: { username: 'Bobby' } });
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    const lobby = t.server.ctx.lobbies.get(lobbyId)!;
    expect(lobby.members.map((m) => m.username)).toEqual(['Alicia', 'Bobby']);
    expect(t.server.ctx.lobbies.summaries()[0].hostName).toBe('Alicia');
    // Watching too.
    await bob.emit('lobby:leave', {});
    await http(t.base, 'PATCH', '/api/me', { session: bob.token, body: { username: 'Roberto' } });
    await bob.emit('lobby:join', { lobbyId, password: 'pw', watch: true });
    expect(t.server.ctx.lobbies.get(lobbyId)!.spectators.map((s) => s.username)).toEqual(['Roberto']);
  });

  it('rejects taken and invalid names, accounts-less admin sessions, and rapid renames', async () => {
    t = await startTestServer();
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    const rename = (username: unknown, session = alice.token) => http(t.base, 'PATCH', '/api/me', { session, body: { username } });
    expect((await rename('BOB')).json).toEqual({ error: 'USERNAME_TAKEN' });
    expect((await rename('a')).json).toEqual({ error: 'INVALID_USERNAME' });
    expect((await rename('no spaces!')).json).toEqual({ error: 'INVALID_USERNAME' });
    expect((await rename(42)).json).toEqual({ error: 'INVALID_USERNAME' });
    expect((await http(t.base, 'PATCH', '/api/me', { body: { username: 'zed' } })).status).toBe(401);
    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token;
    expect((await rename('root', admin)).status).toBe(404);
    // 5 per minute per player (the four failures above count).
    expect((await rename('Alice2')).status).toBe(200);
    expect((await rename('Alice3')).json).toEqual({ error: 'RATE_LIMITED' });
  });
});
