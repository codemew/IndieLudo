import { io as ioClient, type Socket } from 'socket.io-client';
import type { Ack, GameUpdate, Hello } from '../src/shared/protocol.js';
import type { PublicLobby } from '../src/shared/types.js';
import { DEFAULTS, mergeConfig, type ConfigOverrides } from '../src/server/config.js';
import { startServer, type LudoServer, type StartOptions } from '../src/server/server.js';

export const CREATE_PW = 'create-pw';
export const ADMIN_PW = 'admin-pw';

export interface TestServer {
  server: LudoServer;
  base: string;
  close: () => Promise<void>;
}

export async function startTestServer(over: ConfigOverrides = {}, opts: StartOptions = {}): Promise<TestServer> {
  const config = mergeConfig(DEFAULTS, {
    lobbyCreatePassword: CREATE_PW,
    adminPassword: ADMIN_PW,
    dbPath: ':memory:',
    port: 0,
    ...over,
    https: { enabled: false, ...over.https },
  });
  const server = await startServer(config, {
    gateDelayMs: 0,
    staticDir: null,
    log: () => {},
    botDelayMs: 10,
    animScale: 0,
    // Long by default so tests control every human move themselves.
    autoMoveDelayMs: 60_000,
    randomInt: () => 0,
    ...opts,
  });
  const base = `${server.secure ? 'https' : 'http'}://127.0.0.1:${server.port}`;
  return { server, base, close: () => server.close() };
}

export async function http(base: string, method: string, path: string, opts: { body?: unknown; device?: string; session?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.device) headers['X-Device-Token'] = opts.device;
  if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, json, headers: res.headers };
}

export async function verifiedDevice(t: TestServer): Promise<string> {
  const r = await http(t.base, 'POST', '/api/gate/verify', { body: { code: t.server.ctx.gate.current } });
  if (r.status !== 200) throw new Error(`gate failed ${r.status}`);
  return r.json.deviceToken;
}

export async function signup(t: TestServer, username: string, device?: string): Promise<{ token: string; userId: number; device: string }> {
  const d = device ?? (await verifiedDevice(t));
  const r = await http(t.base, 'POST', '/api/users', { body: { username }, device: d });
  if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.token, userId: r.json.user.id, device: d };
}

export interface TestClient {
  socket: Socket;
  hello: Hello;
  userId: number;
  token: string;
  emit: <T = unknown>(event: string, payload?: unknown) => Promise<Ack<T>>;
  /** Resolves with the next game:state matching the predicate. */
  nextState: (pred?: (u: GameUpdate) => boolean, timeoutMs?: number) => Promise<GameUpdate>;
  states: GameUpdate[];
  lobbyStates: (PublicLobby | null)[];
  close: () => void;
}

export function connectSocket(base: string, token: string, extra: Record<string, unknown> = {}): Socket {
  return ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, rejectUnauthorized: false, ...extra } as any);
}

export async function client(t: TestServer, name: string): Promise<TestClient> {
  const { token, userId } = await signup(t, name);
  return clientForToken(t.base, token, userId);
}

export function clientForToken(base: string, token: string, userId: number): Promise<TestClient> {
  const socket = connectSocket(base, token);
  const states: GameUpdate[] = [];
  const lobbyStates: (PublicLobby | null)[] = [];
  const waiters: { pred: (u: GameUpdate) => boolean; resolve: (u: GameUpdate) => void }[] = [];
  socket.on('game:state', (u: GameUpdate) => {
    states.push(u);
    for (const w of [...waiters]) {
      if (w.pred(u)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(u);
      }
    }
  });
  socket.on('lobby:state', (l: PublicLobby | null) => lobbyStates.push(l));
  return new Promise((resolve, reject) => {
    socket.once('connect_error', reject);
    socket.once('hello', (hello: Hello) =>
      resolve({
        socket,
        hello,
        userId,
        token,
        states,
        lobbyStates,
        emit: (event, payload = {}) => socket.timeout(4000).emitWithAck(event, payload).catch(() => ({ ok: false, error: 'TIMEOUT' })) as any,
        nextState: (pred = () => true, timeoutMs = 4000) =>
          new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for game:state')), timeoutMs);
            waiters.push({ pred, resolve: (u) => (clearTimeout(timer), res(u)) });
          }),
        close: () => socket.disconnect(),
      }),
    );
  });
}

export async function createLobby(c: TestClient, name = 'R', password = 'pw'): Promise<string> {
  const r = await c.emit<PublicLobby>('lobby:create', { createPassword: CREATE_PW, name, password });
  if (!r.ok) throw new Error(r.error);
  return r.data!.id;
}

/** Host creates a lobby, guest joins and readies up, host starts. Returns the game id. */
export async function startTwoPlayerGame(host: TestClient, guest: TestClient): Promise<string> {
  const created = await host.emit<PublicLobby>('lobby:create', { createPassword: CREATE_PW, name: 'Test', password: 'pw' });
  if (!created.ok) throw new Error(created.error);
  const joined = await guest.emit('lobby:join', { lobbyId: created.data!.id, password: 'pw' });
  if (!joined.ok) throw new Error(joined.error);
  await guest.emit('lobby:ready', { ready: true });
  const first = host.nextState();
  const started = await host.emit('lobby:start', {});
  if (!started.ok) throw new Error(started.error);
  return (await first).state.id;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
