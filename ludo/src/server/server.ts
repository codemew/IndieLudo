import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { apiRouter } from './api.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { openDb, type DB } from './db.js';
import { cryptoDice, type DiceFn } from './dice.js';
import { GameManager } from './gameManager.js';
import { Gate } from './gate.js';
import { LobbyManager } from './lobbies.js';
import { DeviceService, SessionService } from './sessions.js';
import { attachSocketHandlers, lobbyBroadcaster, rooms, type LudoServerIO } from './socket.js';
import { loadTls, type TlsMaterial } from './tls.js';
import { UserService } from './users.js';
import { VoiceManager } from './voice.js';

export interface StartOptions {
  db?: DB;
  dice?: DiceFn;
  randomInt?: (min: number, max: number) => number;
  log?: (msg: string) => void;
  gateDelayMs?: number;
  botDelayMs?: number;
  autoMoveDelayMs?: number;
  animScale?: number;
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
      lobbies.finishGame(state.lobbyId);
    },
  });

  const lobbies: LobbyManager = new LobbyManager({
    db,
    lobbyCreatePassword: config.lobbyCreatePassword,
    maxLobbies: config.maxLobbies,
    lobbyIdleCloseSec: config.lobbyIdleCloseSec,
    onChange: (lobbyId) => broadcastLobby(lobbyId),
    onLeaveGame: (lobby, userId) => lobby.gameId && games.leave(lobby.gameId, userId),
    // Voice belongs to the lobby: leaving it (or being kicked or dropped) leaves the channel.
    onMemberLeft: (lobby, userId) => voice.leave(lobby.id, userId),
    onClosed: (lobby) => {
      voice.close(lobby.id);
      if (lobby.gameId) games.abort(lobby.gameId);
    },
  });

  const voice: VoiceManager = new VoiceManager({
    isMember: (lobbyId, userId) => Boolean(lobbies.get(lobbyId)?.members.some((m) => m.userId === userId && !m.isBot)),
    isHost: (lobbyId, userId) => lobbies.get(lobbyId)?.hostId === userId,
    onChange: (state) => io?.to(rooms.lobby(state.lobbyId)).emit('voice:state', state),
  });

  const gate = new Gate({ ...config.gate, onRotate: opts.onGateRotate });

  lobbies.load();
  const restored = games.restore();
  // Reconcile after a restart: lobbies whose game ended reopen, games without a lobby stop.
  for (const lobby of lobbies.all()) {
    if (lobby.status === 'playing' && (!lobby.gameId || !games.get(lobby.gameId))) lobbies.finishGame(lobby.id);
  }
  if (restored) log(`[games] restored ${restored} unfinished game(s)`);

  ctx = {
    config,
    db,
    users,
    devices,
    sessions,
    gate,
    lobbies,
    games,
    voice,
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
          scriptSrc: ["'self'"],
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
  app.use('/api', express.json({ limit: '4kb' }), apiRouter(ctx, { gateDelayMs: opts.gateDelayMs }));

  const staticDir = opts.staticDir === undefined ? resolve('dist/client') : opts.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use('/assets', express.static(join(staticDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(staticDir, { index: 'index.html', maxAge: 0 }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
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
    // Re-run auth on recovery so revoked sessions cannot slip back in.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
  }) as LudoServerIO;
  attachSocketHandlers(io, ctx, log);

  const sweeper = setInterval(() => lobbies.sweep(), 30_000);
  sweeper.unref();

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
      games.shutdown();
      await new Promise<void>((r) => io!.close(() => r()));
      if (redirect) await new Promise<void>((r) => redirect!.close(() => r()));
      main.closeAllConnections?.();
      if (!opts.db) db.close();
    },
  };
}
