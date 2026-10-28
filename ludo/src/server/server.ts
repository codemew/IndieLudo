import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { NET_PING_INTERVAL_MS, NET_PING_TIMEOUT_MS } from '../shared/net.js';
import { apiRouter } from './api.js';
import { compressedAssets } from './assets.js';
import { DEFAULT_SFU, type Config } from './config.js';
import type { Ctx } from './context.js';
import { openDb, type DB } from './db.js';
import { cryptoDice, type DiceFn } from './dice.js';
import { GameManager } from './gameManager.js';
import { Gate } from './gate.js';
import { LobbyManager, humanIds } from './lobbies.js';
import { NetStatsTracker } from './netStats.js';
import { DeviceService, SessionService } from './sessions.js';
import { attachSocketHandlers, lobbyBroadcaster, rooms, type LudoServerIO } from './socket.js';
import { loadTls, type TlsMaterial } from './tls.js';
import { UserService } from './users.js';
import { VoiceManager } from './voice.js';
import { VoiceServer } from './sfu.js';

/** The package.json version (same path from src/server and dist/server). */
const APP_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
/** Ping stats are only sent when they change, but at least this often. */
const NET_RESEND_MS = 15_000;

export interface StartOptions {
  db?: DB;
  dice?: DiceFn;
  randomInt?: (min: number, max: number) => number;
  log?: (msg: string) => void;
  gateDelayMs?: number;
  botDelayMs?: number;
  autoMoveDelayMs?: number;
  animScale?: number;
  /** How often players' pings are measured (ms); tests shorten it. */
  netIntervalMs?: number;
  /** Built client to serve; null disables static serving. Defaults to ./dist/client when present. */
  staticDir?: string | null;
  onGateRotate?: (code: string, reason: 'manual' | 'brute-force') => void;
}

export interface LudoServer {
  ctx: Ctx;
  io: LudoServerIO;
  /** Port of the main (HTTPS, or HTTP when HTTPS is off) server. */
  port: number;
  redirectPort: number | null;
  secure: boolean;
  tls: TlsMaterial | null;
  close(): Promise<void>;
}

function listen(server: http.Server | https.Server, port: number): Promise<number> {
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, () => {
      server.off('error', rej);
      res((server.address() as AddressInfo).port);
    });
  });
}

const HOST_RE = /^[a-z0-9.\-]+$|^\[[0-9a-f:.]+\]$/i;

function redirectServer(httpsPort: number): http.Server {
  return http.createServer((req, res) => {
    const rawHost = (req.headers.host ?? '').replace(/:\d+$/, '');
    const host = HOST_RE.test(rawHost) ? rawHost : 'localhost';
    const port = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(301, { Location: `https://${host}${port}${req.url ?? '/'}` });
    res.end();
  });
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<LudoServer> {
  const log = opts.log ?? console.log;
  const db = opts.db ?? openDb(config.dbPath);
  const users = new UserService(db);
  const devices = new DeviceService(db);
  const sessions = new SessionService(db);

  let io: LudoServerIO | undefined;
  let ctx: Ctx | undefined;
  const broadcastLobby = lobbyBroadcaster(() => io, () => ctx);

  const games: GameManager = new GameManager({
    db,
    dice: opts.dice ?? cryptoDice,
    randomInt: opts.randomInt,
    turnTimeoutSec: config.turnTimeoutSec,
    disconnectGraceSec: config.disconnectGraceSec,
    botDelayMs: opts.botDelayMs,
    autoMoveDelayMs: opts.autoMoveDelayMs,
    animScale: opts.animScale,
    log,
    onUpdate: (state, events) => io?.to(rooms.game(state.id)).emit('game:state', { state, events }),
    onGameOver: (state) => {
      for (const seat of state.seats) {
        if (seat.userId !== null && users.get(seat.userId)) users.recordGame(seat.userId, state.ranks[0] === seat.color);
      }
      lobbies.finishGame(state.lobbyId, state.botBattle === true);
    },
  });

  const lobbies: LobbyManager = new LobbyManager({
    db,
    lobbyCreatePassword: config.lobbyCreatePassword,
    maxLobbies: config.maxLobbies,
    lobbyIdleCloseSec: config.lobbyIdleCloseSec,
    onChange: (lobbyId) => broadcastLobby(lobbyId),
    onLeaveGame: (lobby, userId) => lobby.gameId && games.leave(lobby.gameId, userId),
    winsOf: (userId) => users.get(userId)?.wins ?? 0,
    randomInt: opts.randomInt,
    onSwapEnded: (req, how) => io?.to([rooms.user(req.from), rooms.user(req.to)]).emit('lobby:swapEnded', { from: req.from, to: req.to, how }),
    // Voice belongs to the lobby: leaving it (or being kicked or dropped) leaves the channel.
    onMemberLeft: (lobby, userId) => voice.leave(lobby.id, userId),
    onClosed: (lobby, byAdmin) => {
      // Sent while the members are still in the lobby room, just before it empties.
      if (byAdmin) io?.to(rooms.lobby(lobby.id)).emit('lobby:closed', { byAdmin: true });
      voice.close(lobby.id);
      sfu.close(lobby.id);
      if (lobby.gameId) games.abort(lobby.gameId);
    },
  });

  const voice: VoiceManager = new VoiceManager({
    isMember: (lobbyId, userId) => {
      const lobby = lobbies.get(lobbyId);
      return Boolean(lobby && humanIds(lobby).includes(userId));
    },
    isHost: (lobbyId, userId) => lobbies.get(lobbyId)?.hostId === userId,
    onChange: (state) => {
      // The voice server follows the channel: whoever left it (or a restart, or voice off) is dropped.
      sfu.sync(state.lobbyId, state.enabled ? state.participants.map((p) => p.userId) : []);
      io?.to(rooms.lobby(state.lobbyId)).emit('voice:state', state);
    },
  });
  const sfu = new VoiceServer({
    config: config.voice.sfu ?? DEFAULT_SFU,
    log,
    onSlots: (lobbyId, userId, slots) => io?.to(rooms.user(userId)).emit('voice:slots', { lobbyId, slots }),
    onLink: (lobbyId, userId, connected) => voice.setSfu(lobbyId, userId, connected),
  });

  const net = new NetStatsTracker();
  const gate = new Gate({ ...config.gate, onRotate: opts.onGateRotate });

  lobbies.load();
  const restored = games.restore();
  // Reconcile after a restart: lobbies whose game ended reopen, games without a lobby stop.
  for (const lobby of lobbies.all()) {
    if (lobby.status === 'playing' && (!lobby.gameId || !games.get(lobby.gameId))) lobbies.finishGame(lobby.id);
  }
  if (restored) log(`[games] restored ${restored} unfinished game(s)`);

  ctx = {
    appVersion: APP_VERSION,
    config,
    db,
    users,
    devices,
    sessions,
    gate,
    lobbies,
    games,
    voice,
    sfu,
    net,
    kickSessions: (ids) => {
      if (!io || ids.length === 0) return;
      const r = ids.map(rooms.session);
      io.to(r).emit('session:revoked');
      io.in(r).disconnectSockets(true);
    },
    kickUser: (userId) => {
      if (!io) return;
      io.to(rooms.user(userId)).emit('session:revoked');
      io.in(rooms.user(userId)).disconnectSockets(true);
    },
  };

  const tls = config.https.enabled
    ? await loadTls({
        certPath: config.https.certPath,
        keyPath: config.https.keyPath,
        autoSelfSigned: config.https.autoSelfSigned,
        certDir: config.certDir,
      })
    : null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'wasm-unsafe-eval' lets the page compile RNNoise's WebAssembly (noise removal for voice); it
          // allows no eval of JavaScript.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'wss:', 'ws:'],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      // HSTS only with a real certificate; pinning HTTPS to a self-signed cert would lock phones out.
      strictTransportSecurity: tls?.trusted ? { maxAge: 180 * 24 * 3600 } : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api', apiRouter(ctx, { gateDelayMs: opts.gateDelayMs }));

  // "Update app" navigates here. Browsers clear their cache for Clear-Site-Data reliably when it
  // comes with a page load (they finish clearing before showing it); then we go on to the game.
  // It only affects the asker's own saved copies of this site's files (not logins or local data).
  app.get('/refresh', (_req, res) => {
    res.setHeader('Clear-Site-Data', '"cache"');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Updating Ludo</title><meta http-equiv="refresh" content="0;url=/?fresh=${Date.now()}"><script>location.replace('/?fresh=' + Date.now())</script>`);
  });

  const staticDir = opts.staticDir === undefined ? resolve('dist/client') : opts.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    // Built files have the content hash in their name, so they can be kept for a year. The page
    // that names them must always be checked with the server, or phones keep an old build.
    const revalidate = (res: express.Response, path: string) => {
      if (/\.(html|webmanifest)$/.test(path)) res.setHeader('Cache-Control', 'no-cache');
    };
    app.use('/assets', compressedAssets(resolve(staticDir, 'assets')), express.static(join(staticDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(staticDir, { index: 'index.html', maxAge: 0, setHeaders: revalidate }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(staticDir, 'index.html'));
    });
  }

  const main = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : http.createServer(app);
  io = new Server(main, {
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
    connectTimeout: 10_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    // Compress WebSocket messages. Each game update repeats most of the one before, so with the
    // compressor's memory of earlier messages a 1.5 KB update shrinks to about 50 bytes (about
    // 28× less data over a game). Tiny messages, like pings and voice frames, aren't worth it.
    perMessageDeflate: { threshold: 128 },
    // Re-run auth on recovery so revoked sessions cannot slip back in.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
  }) as LudoServerIO;
  attachSocketHandlers(io, ctx, log);

  const sweeper = setInterval(() => lobbies.sweep(), 30_000);
  sweeper.unref();

  // Players' pings: one tiny ping per phone in a lobby, then one update per lobby, every 3 s.
  const netInterval = opts.netIntervalMs ?? NET_PING_INTERVAL_MS;
  const pingTimeout = Math.min(NET_PING_TIMEOUT_MS, Math.round(netInterval * 0.8));
  const lastNet = new Map<string, { key: string; at: number }>();
  const pinger = setInterval(() => {
    for (const [socketId, userId] of net.sockets()) {
      if (!lobbies.forUser(userId)) continue;
      const socket = io!.sockets.sockets.get(socketId);
      if (!socket) continue;
      const t0 = performance.now();
      socket.timeout(pingTimeout).emit('net:ping', (err: Error | null) => net.record(socketId, err ? null : performance.now() - t0));
    }
    setTimeout(() => {
      const live = new Set<string>();
      for (const lobby of lobbies.all()) {
        live.add(lobby.id);
        const players = humanIds(lobby).map((id) => net.forUser(id));
        // Unchanged since the last send (a steady connection): nothing to send.
        // A refresh every NET_RESEND_MS anyway, in case a phone missed one.
        const key = JSON.stringify(players);
        const last = lastNet.get(lobby.id);
        const now = Date.now();
        if (!players.length || (last?.key === key && now - last.at < NET_RESEND_MS)) continue;
        lastNet.set(lobby.id, { key, at: now });
        io!.to(rooms.lobby(lobby.id)).emit('net:stats', { lobbyId: lobby.id, players });
      }
      for (const id of lastNet.keys()) if (!live.has(id)) lastNet.delete(id);
    }, pingTimeout + 20).unref();
  }, netInterval);
  pinger.unref();

  const port = await listen(main, tls ? config.https.port : config.port);
  let redirect: http.Server | null = null;
  let redirectPort: number | null = null;
  // Port 0 means "any free port" (tests), so equal zeros still get their own redirect listener.
  if (tls && (config.https.httpRedirectPort !== config.https.port || config.https.port === 0)) {
    redirect = redirectServer(port);
    redirectPort = await listen(redirect, config.https.httpRedirectPort);
  }

  let closed = false;
  return {
    ctx,
    io,
    port,
    redirectPort,
    secure: Boolean(tls),
    tls,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      clearInterval(pinger);
      games.shutdown();
      sfu.shutdown();
      await new Promise<void>((r) => io!.close(() => r()));
      if (redirect) await new Promise<void>((r) => redirect!.close(() => r()));
      main.closeAllConnections?.();
      if (!opts.db) db.close();
    },
  };
}
