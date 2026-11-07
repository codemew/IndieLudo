import { afterEach, describe, expect, it } from 'vitest';
import type { OnlineUser, PublicLobby } from '../src/shared/types.js';
import { scriptedDice } from './helpers.js';
import {
  ADMIN_PW,
  CREATE_PW,
  client,
  clientForToken,
  createLobby,
  http,
  signup,
  startTestServer,
  startTwoPlayerGame,
  verifiedDevice,
  wait,
  type TestClient,
  type TestServer,
} from './serverHelpers.js';

const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

async function server() {
  // Every connection here comes from 127.0.0.1, which a real lookup calls "Local network"; this stub names it.
  t = await startTestServer(
    {},
    { dice: scriptedDice(Array(80).fill(1)), presenceDelayMs: 10, isp: { lookup: (ip) => (ip.includes('127.0.0.1') ? 'Test Telecom' : '') } },
  );
}

async function join(name: string, ua?: string): Promise<TestClient> {
  const { token, userId } = await signup(t, name);
  const c = ua ? await clientWithUa(token, userId, ua) : await clientForToken(t.base, token, userId);
  clients.push(c);
  return c;
}

/** Socket.io in Node sends no browser user agent unless told to. */
async function clientWithUa(token: string, userId: number, ua: string): Promise<TestClient> {
  const { io } = await import('socket.io-client');
  const socket = io(t.base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { 'user-agent': ua } } as never);
  await new Promise((r) => socket.once('hello', r));
  return {
    socket,
    userId,
    token,
    emit: (e: string, p: unknown = {}) => new Promise((r) => socket.emit(e, p, r)),
    close: () => socket.disconnect(),
  } as unknown as TestClient;
}

/** The next online list matching `pred` that `c` receives. */
function nextOnline(c: TestClient, pred: (l: OnlineUser[]) => boolean, ms = 2000): Promise<OnlineUser[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no matching users:online')), ms);
    const on = (l: OnlineUser[]) => {
      if (!pred(l)) return;
      clearTimeout(timer);
      c.socket.off('users:online', on);
      resolve(l);
    };
    c.socket.on('users:online', on);
  });
}

describe('the Users tab: who is online, where, and on what phone', () => {
  it('lists everyone online with their phone, browser and ISP, live as they come, move and go', async () => {
    await server();
    const alice = await join('alice');
    const firstSeen = nextOnline(alice, (l) => l.some((u) => u.username === 'bob'));
    const bob = await join('bob', PIXEL_UA);
    let list = await firstSeen;
    const b = list.find((u) => u.username === 'bob')!;
    expect(b.where).toEqual({ kind: 'home' });
    expect(b.devices).toEqual([{ model: '', os: 'Android 10', browser: 'Chrome 130', isp: 'Test Telecom' }]);

    // Bob's phone sends its client hints: the real model and Android version replace Chrome's frozen ones.
    const hinted = nextOnline(alice, (l) => l.find((u) => u.username === 'bob')?.devices?.[0].model === 'Pixel 8');
    expect(
      (await bob.emit('device:info', { model: 'Pixel 8', platform: 'Android', platformVersion: '15.0.0', brand: 'Google Chrome', brandVersion: '131.0.1' })).ok,
    ).toBe(true);
    list = await hinted;
    expect(list.find((u) => u.username === 'bob')!.devices).toEqual([{ model: 'Pixel 8', os: 'Android 15', browser: 'Chrome 131', isp: 'Test Telecom' }]);

    // Where they are follows the lobbies.
    const inLobby = nextOnline(alice, (l) => l.find((u) => u.username === 'alice')?.where.kind === 'lobby');
    await createLobby(alice, 'Fam');
    expect((await inLobby).find((u) => u.username === 'alice')!.where).toEqual({ kind: 'lobby', lobby: 'Fam' });

    // Bob leaves: gone from the list.
    const gone = nextOnline(alice, (l) => !l.some((u) => u.username === 'bob'));
    bob.close();
    await gone;
  });

  it('a player can hide their phone: everyone then sees only that they are online', async () => {
    await server();
    const alice = await join('alice');
    const bob = await join('bob', PIXEL_UA);
    const hidden = nextOnline(alice, (l) => l.find((u) => u.username === 'bob')?.hidden === true);
    const r = await http(t.base, 'PATCH', '/api/me', { session: bob.token, body: { showDevice: false } });
    expect(r.status).toBe(200);
    expect(r.json.user.showDevice).toBe(false);
    const b = (await hidden).find((u) => u.username === 'bob')!;
    expect(b.devices).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('Android');
    expect((await http(t.base, 'GET', '/api/me', { session: bob.token })).json.user.showDevice).toBe(false);
    // Junk is refused without changing anything.
    expect((await http(t.base, 'PATCH', '/api/me', { session: bob.token, body: { showDevice: 'yes' } })).status).toBe(400);
  });

  it('device:info is checked strictly, and the list can be asked for', async () => {
    await server();
    const alice = await join('alice');
    expect(await alice.emit('device:info', { model: 'x'.repeat(65) })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await alice.emit('device:info', { ip: '1.2.3.4' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    const r = await alice.emit<OnlineUser[]>('users:list', {});
    expect(r.ok && r.data!.map((u) => u.username)).toEqual(['alice']);
  });
});

describe('the host leaving can close the lobby', () => {
  it('everyone in it is told and sent home; only the host, and only between games', async () => {
    await server();
    const alice = await join('alice');
    const bob = await join('bob');
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    expect(await bob.emit('lobby:close', {})).toEqual({ ok: false, error: 'NOT_HOST' });
    const told = new Promise((r) => bob.socket.once('lobby:closed', r));
    const emptied = new Promise((r) => bob.socket.on('lobby:state', (l: PublicLobby | null) => l === null && r(null)));
    expect((await alice.emit('lobby:close', {})).ok).toBe(true);
    expect(await told).toEqual({ byAdmin: false, byHost: true });
    await emptied;
    expect(t.server.ctx.lobbies.get(lobbyId)).toBeUndefined();
    expect(t.server.ctx.lobbies.forUser(bob.userId)).toBeUndefined();
  });

  it('not during a game: leaving then hands the seat to a bot, as before', async () => {
    await server();
    const alice = await join('alice');
    const bob = await join('bob');
    await startTwoPlayerGame(alice, bob);
    expect(await alice.emit('lobby:close', {})).toEqual({ ok: false, error: 'GAME_IN_PROGRESS' });
  });
});

describe('moving to another lobby from the home screen', () => {
  it("the old lobby's updates stop reaching you", async () => {
    await server();
    const alice = await join('alice');
    const bob = await join('bob');
    const carol = await join('carol');
    const first = await createLobby(alice, 'First');
    await bob.emit('lobby:join', { lobbyId: first, password: 'pw' });
    const second = await createLobby(carol, 'Second');
    // Bob, on his home screen, joins Second: he leaves First.
    expect((await bob.emit('lobby:join', { lobbyId: second, password: 'pw' })).ok).toBe(true);
    const seen: (string | null)[] = [];
    bob.socket.on('lobby:state', (l: PublicLobby | null) => seen.push(l?.name ?? null));
    await alice.emit('lobby:addBot', {}); // First changes
    await wait(100);
    expect(seen).toEqual([]);
  });
});

describe('admin: passwords', () => {
  const adminToken = async () =>
    (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token as string;

  it("changes a lobby's join password: who is in stays, joiners need the new one", async () => {
    await server();
    const alice = await join('alice');
    const bob = await join('bob');
    const lobbyId = await createLobby(alice);
    const admin = await adminToken();
    expect((await http(t.base, 'PATCH', `/api/admin/lobbies/${lobbyId}`, { session: alice.token, body: { password: 'new' } })).status).toBe(403);
    expect((await http(t.base, 'PATCH', `/api/admin/lobbies/${lobbyId}`, { session: admin, body: { password: '' } })).json.error).toBe('PASSWORD_REQUIRED');
    expect((await http(t.base, 'PATCH', '/api/admin/lobbies/nope', { session: admin, body: { password: 'x' } })).status).toBe(404);
    expect((await http(t.base, 'PATCH', `/api/admin/lobbies/${lobbyId}`, { session: admin, body: { password: 'new-pw' } })).status).toBe(200);
    expect(await bob.emit('lobby:join', { lobbyId, password: 'pw' })).toEqual({ ok: false, error: 'WRONG_LOBBY_PASSWORD' });
    expect((await bob.emit('lobby:join', { lobbyId, password: 'new-pw' })).ok).toBe(true);
    expect(t.server.ctx.lobbies.get(lobbyId)!.members.map((m) => m.username)).toEqual(['alice', 'bob']);
  });

  it('the creation password: remembered after one entry, changed in the panel, and accounts forgotten', async () => {
    await server();
    const alice = await join('alice');
    expect(alice.hello.user.canCreate).toBe(false);
    expect(await alice.emit('lobby:create', { name: 'A', password: 'pw', createPassword: '' })).toEqual({ ok: false, error: 'WRONG_CREATE_PASSWORD' });
    expect((await alice.emit('lobby:create', { name: 'A', password: 'pw', createPassword: CREATE_PW })).ok).toBe(true);
    await alice.emit('lobby:leave', {});
    // Remembered: no creation password now, and the app is told so.
    expect((await alice.emit('lobby:create', { name: 'B', password: 'pw', createPassword: '' })).ok).toBe(true);
    expect((await http(t.base, 'GET', '/api/me', { session: alice.token })).json.user.canCreate).toBe(true);

    const admin = await adminToken();
    let info = (await http(t.base, 'GET', '/api/admin/create-access', { session: admin })).json;
    expect(info).toEqual({ source: 'config', hosts: [expect.objectContaining({ userId: alice.userId, username: 'alice' })] });
    expect((await http(t.base, 'GET', '/api/admin/create-access', { session: alice.token })).status).toBe(403);

    // A new creation password: config.json's no longer works, and alice must enter the new one.
    expect((await http(t.base, 'PUT', '/api/admin/create-password', { session: admin, body: { password: 'abc' } })).json.error).toBe('PASSWORD_TOO_SHORT');
    info = (await http(t.base, 'PUT', '/api/admin/create-password', { session: admin, body: { password: 'brand-new' } })).json;
    expect(info).toEqual({ source: 'admin', hosts: [] });
    await alice.emit('lobby:leave', {});
    expect(await alice.emit('lobby:create', { name: 'C', password: 'pw', createPassword: CREATE_PW })).toEqual({ ok: false, error: 'WRONG_CREATE_PASSWORD' });
    expect((await alice.emit('lobby:create', { name: 'C', password: 'pw', createPassword: 'brand-new' })).ok).toBe(true);

    // Forget one account.
    expect((await http(t.base, 'DELETE', `/api/admin/create-access/${alice.userId}`, { session: admin })).status).toBe(200);
    expect(t.server.ctx.hosts.isTrusted(alice.userId)).toBe(false);

    // Back to config.json's.
    info = (await http(t.base, 'PUT', '/api/admin/create-password', { session: admin, body: { password: null } })).json;
    expect(info.source).toBe('config');
  });
});
