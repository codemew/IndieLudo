import { lookup } from 'node:dns/promises';
import type { Server, Socket } from 'socket.io';
import { isIPv4, isLocalAddress, localRouteFor, type LocalRoute } from '../shared/ice.js';
import { RELAY_LIMITS, SCHEMAS, matchesSchema, type Ack, type ClientToServer, type Hello, type Schema, type ServerToClient, type VoiceFramesOut, type VoiceSignalKind } from '../shared/protocol.js';
import type { Color } from '../shared/types.js';
import type { Ctx } from './context.js';
import type { Lobby } from './lobbies.js';
import { AppError } from './errors.js';
import { TokenBucket } from './rateLimit.js';
import { iceServersFor } from './turn.js';

interface SocketData {
  userId: number;
  username: string;
  sessionId: number;
  ip: string;
  bucket: TokenBucket;
}

export type LudoServerIO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
type LudoSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

/** A whole family can share one public IP: 8 phones, each briefly with 2 sockets while reconnecting. */
export const MAX_SOCKETS_PER_IP = 24;
export const MAX_SOCKETS_PER_USER = 20;
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SEC = 10;

export const rooms = {
  user: (id: number) => `user:${id}`,
  session: (id: number) => `session:${id}`,
  lobby: (id: string) => `lobby:${id}`,
  game: (id: string) => `game:${id}`,
};

/** How long the server waits for a first ping when it needs one now (to decide on local voice routes). */
const PING_NOW_TIMEOUT_MS = 1000;

/**
 * The public IPv4 address behind the Host a phone used, if it is one: an IP written in the URL,
 * or a name resolved through DNS. Null for local addresses and anything that doesn't resolve.
 */
export async function publicHostAddress(host: string | undefined, resolve: (name: string) => Promise<string> = async (n) => (await lookup(n, { family: 4 })).address): Promise<string | null> {
  const name = (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!name || name.includes(':')) return null;
  const address = /^\d+\.\d+\.\d+\.\d+$/.test(name) ? name : await resolve(name).catch(() => null);
  return address && !isLocalAddress(address) ? address : null;
}

function clientIp(socket: LudoSocket, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address;
}

export function attachSocketHandlers(io: LudoServerIO, ctx: Ctx, log: (msg: string) => void = console.log): void {
  const perIp = new Map<string, number>();
  const perUser = new Map<number, number>();
  const inc = <K>(m: Map<K, number>, k: K, d: number) => {
    const v = (m.get(k) ?? 0) + d;
    if (v <= 0) m.delete(k);
    else m.set(k, v);
    return v;
  };

  // Only authenticated sessions with a player account get a socket at all.
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const auth = typeof token === 'string' ? ctx.sessions.resolve(token) : undefined;
    if (!auth?.user) return next(new Error('UNAUTHORIZED'));
    const ip = clientIp(socket, ctx.config.trustProxy);
    if ((perIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP || (perUser.get(auth.user.id) ?? 0) >= MAX_SOCKETS_PER_USER) {
      return next(new Error('TOO_MANY_CONNECTIONS'));
    }
    socket.data = {
      userId: auth.user.id,
      username: auth.user.username,
      sessionId: auth.session.id,
      ip,
      bucket: new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC),
    };
    next();
  });

  io.on('connection', (socket) => {
    const { userId, sessionId, ip } = socket.data;
    inc(perIp, ip, 1);
    const userSockets = inc(perUser, userId, 1);
    socket.join([rooms.user(userId), rooms.session(sessionId)]);
    ctx.net.add(socket.id, userId);

    if (userSockets === 1) {
      ctx.lobbies.setConnected(userId, true);
      ctx.games.setConnected(userId, true);
    }

    const lobby = ctx.lobbies.forUser(userId);
    if (lobby) socket.join(rooms.lobby(lobby.id));
    const game = lobby?.gameId ? ctx.games.get(lobby.gameId) : undefined;
    if (game) socket.join(rooms.game(game.id));
    // A phone on the internet tells us the address the server is reached at from outside.
    if (!ctx.config.voice.sfu?.announcedIp && !isLocalAddress(ip)) {
      void publicHostAddress(socket.handshake.headers.host).then((a) => a && ctx.sfu.learnPublicAddress(a));
    }
    const hello: Hello = {
      appVersion: ctx.appVersion,
      user: { id: userId, username: socket.data.username },
      lobby: lobby ? ctx.lobbies.toPublic(lobby) : null,
      game: game ? ctx.games.publicState(game) : null,
    };
    socket.emit('hello', hello);

    /**
     * Wraps a handler with the rate limit, strict schema check and error mapping.
     * Clients that flood are disconnected.
     */
    const on = <E extends keyof ClientToServer>(event: E, schema: Schema | null, handler: (payload: any) => Ack | void | Promise<Ack | void>) => {
      socket.on(event, ((payload: unknown, ack: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (r: Ack) => void) : () => {};
        if (!socket.data.bucket.take()) {
          log(`[ratelimit] disconnecting user ${userId} (${ip}) for flooding`);
          socket.disconnect(true);
          return;
        }
        if (schema && !matchesSchema(payload, schema)) {
          log(`[anticheat] user ${userId} sent malformed ${event}: ${JSON.stringify(payload)?.slice(0, 200)}`);
          reply({ ok: false, error: 'BAD_PAYLOAD' });
          return;
        }
        const fail = (err: unknown) => {
          if (err instanceof AppError) reply({ ok: false, error: err.code });
          else {
            log(`[socket] ${event} failed: ${(err as Error).stack ?? err}`);
            reply({ ok: false, error: 'INTERNAL' });
          }
        };
        try {
          const r = handler(payload);
          if (r instanceof Promise) r.then((v) => reply(v ?? { ok: true }), fail);
          else reply(r ?? { ok: true });
        } catch (err) {
          fail(err);
        }
      }) as any);
    };

    /**
     * Whether this phone may use local-network voice routes: on IPv4 and a ping under
     * voice.localMaxPingMs (measured now if there is no ping yet).
     */
    const localRoute = async (): Promise<LocalRoute> => {
      let rtt = ctx.net.rttOf(socket.id);
      if (rtt === null && isIPv4(ip)) {
        rtt = await new Promise<number | null>((resolve) => {
          const t0 = performance.now();
          socket.timeout(PING_NOW_TIMEOUT_MS).emit('net:ping', (err: Error | null) => {
            const ms = err ? null : performance.now() - t0;
            ctx.net.record(socket.id, ms);
            resolve(ms);
          });
        });
      }
      return localRouteFor(ip, rtt, ctx.config.voice.localMaxPingMs);
    };

    // The current name, not the one this socket connected with: the player may have renamed
    // themselves since (the home screen's name tag), and a lobby they join must show the new one.
    const me = () => {
      const fresh = ctx.users.get(userId)?.username;
      if (fresh) socket.data.username = fresh;
      return { id: userId, username: socket.data.username };
    };
    /** Joins all of this user's sockets to the lobby room, then sends them the state they missed. */
    const joinLobbyRoom = (lobby: Lobby) => {
      io.in(rooms.user(userId)).socketsJoin(rooms.lobby(lobby.id));
      io.to(rooms.user(userId)).emit('lobby:state', ctx.lobbies.toPublic(lobby));
    };

    on('lobby:list', SCHEMAS.empty, () => ({ ok: true, data: ctx.lobbies.summaries() }));
    on('net:probe', SCHEMAS.empty, () => ({ ok: true }));

    on('lobby:create', SCHEMAS.lobbyCreate, (p) => {
      const l = ctx.lobbies.create(me(), p);
      joinLobbyRoom(l);
      return { ok: true, data: ctx.lobbies.toPublic(l) };
    });

    on('lobby:join', SCHEMAS.lobbyJoin, (p) => {
      const l = ctx.lobbies.join(me(), p.lobbyId, p.password, p.watch === true);
      joinLobbyRoom(l);
      const game = l.gameId ? ctx.games.get(l.gameId) : undefined;
      if (game) {
        // Watching a game already under way: straight to the board.
        io.in(rooms.user(userId)).socketsJoin(rooms.game(game.id));
        io.to(rooms.user(userId)).emit('game:state', { state: ctx.games.publicState(game) });
      }
      return { ok: true, data: ctx.lobbies.toPublic(l) };
    });

    on('lobby:leave', SCHEMAS.empty, () => {
      const l = ctx.lobbies.forUser(userId);
      ctx.lobbies.leave(userId);
      if (l) {
        io.in(rooms.user(userId)).socketsLeave([rooms.lobby(l.id), ...(l.gameId ? [rooms.game(l.gameId)] : [])]);
        io.to(rooms.user(userId)).emit('lobby:state', null);
      }
    });

    on('lobby:ready', SCHEMAS.lobbyReady, (p) => void ctx.lobbies.setReady(userId, p.ready));
    on('lobby:color', SCHEMAS.lobbyColor, (p) => void ctx.lobbies.setColor(userId, p.color as Color));
    on('lobby:swapAsk', SCHEMAS.lobbyColor, (p) => {
      const r = ctx.lobbies.askSwap(userId, p.color as Color);
      if (!r.swapped) io.to(rooms.user(r.req.to)).emit('lobby:swapRequest', r.req);
      return { ok: true, data: { swapped: r.swapped } };
    });
    on('lobby:swapAnswer', SCHEMAS.swapAnswer, (p) => void ctx.lobbies.answerSwap(userId, p.from, p.accept));
    on('lobby:swapCancel', SCHEMAS.empty, () => void ctx.lobbies.cancelSwap(userId));
    on('lobby:addBot', SCHEMAS.lobbyAddBot, (p) => void ctx.lobbies.addBot(userId, p.color as Color | undefined));
    on('lobby:removeBot', SCHEMAS.lobbyColor, (p) => void ctx.lobbies.removeBot(userId, p.color as Color));
    on('lobby:fillBots', SCHEMAS.empty, () => void ctx.lobbies.fillBots(userId));
    on('lobby:mode', SCHEMAS.lobbyMode, (p) => void ctx.lobbies.setTeams(userId, p.teams));
    on('lobby:spectate', SCHEMAS.empty, () => void ctx.lobbies.spectate(userId));
    on('lobby:sit', SCHEMAS.lobbyColor, (p) => void ctx.lobbies.sit(userId, p.color as Color));

    on('lobby:kick', SCHEMAS.lobbyKick, (p) => {
      const l = ctx.lobbies.kick(userId, p.userId);
      io.in(rooms.user(p.userId)).socketsLeave(rooms.lobby(l.id));
      io.to(rooms.user(p.userId)).emit('lobby:state', null);
    });

    on('lobby:start', SCHEMAS.empty, () => {
      const l = ctx.lobbies.checkStart(userId);
      const state = ctx.games.create(l);
      io.in(rooms.lobby(l.id)).socketsJoin(rooms.game(state.id));
      ctx.lobbies.markPlaying(l.id, state.id);
      io.to(rooms.game(state.id)).emit('game:state', { state: ctx.games.publicState(state) });
    });

    const resync = (gameId: string, r: Ack): Ack => {
      if (!r.ok && (r.error === 'STALE_VERSION' || r.error === 'WRONG_PHASE' || r.error === 'NOT_YOUR_TURN')) {
        const state = ctx.games.get(gameId);
        if (state) socket.emit('game:state', { state: ctx.games.publicState(state) });
      }
      return r;
    };

    // Game intents are schema-checked inside GameManager, which also logs tampering.
    on('game:roll', null, (p) => resync(p?.gameId, ctx.games.roll(userId, p)));
    on('game:move', null, (p) => resync(p?.gameId, ctx.games.move(userId, p)));

    on('game:resume', SCHEMAS.gameRef, (p) => {
      const state = ctx.games.find(p.gameId);
      const watching = state && ctx.lobbies.get(state.lobbyId)?.spectators.some((s) => s.userId === userId);
      if (!state || !(watching || state.seats.some((s) => s.userId === userId))) return { ok: false, error: 'NO_GAME' };
      if (!state.finished) socket.join(rooms.game(state.id));
      return { ok: true, data: ctx.games.publicState(state) };
    });

    on('game:takeback', SCHEMAS.gameRef, (p) => ctx.games.takeback(userId, p.gameId));
    on('game:surrender', null, (p) => ctx.games.surrender(userId, p));
    on('game:respawn', null, (p) => ctx.games.respawn(userId, p));

    // ---- Lobby voice chat: membership and relaying only; audio goes peer to peer. ----

    on('voice:get', SCHEMAS.voiceRef, (p) => ({ ok: true, data: ctx.voice.stateFor(p.lobbyId, userId) }));
    on('voice:join', SCHEMAS.voiceRef, async (p) => {
      const state = ctx.voice.join(p.lobbyId, userId, socket.id);
      return { ok: true, data: { state, iceServers: iceServersFor(ctx.config.voice, userId), sfu: ctx.sfu.enabled, local: await localRoute() } };
    });
    // The built-in voice server. Setting up a connection takes a moment (ports, the offer), so
    // these answer asynchronously; the membership checks come first, as everywhere else.
    const sfuCall = (event: 'voice:sfuJoin' | 'voice:sfuAnswer' | 'voice:sfuCand', schema: Schema, run: (p: any) => Promise<unknown>) => {
      socket.on(event, ((payload: unknown, ack: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (r: Ack) => void) : () => {};
        if (!socket.data.bucket.take()) {
          socket.disconnect(true);
          return;
        }
        if (!matchesSchema(payload, schema)) return reply({ ok: false, error: 'BAD_PAYLOAD' });
        const p = payload as { lobbyId: string };
        if (!ctx.voice.isIn(p.lobbyId, userId)) return reply({ ok: false, error: 'NOT_IN_VOICE' });
        run(p).then(
          (data) => reply(data === undefined ? { ok: true } : { ok: true, data }),
          (err) => {
            if (!(err instanceof AppError)) log(`[voice] ${event} failed: ${(err as Error).stack ?? err}`);
            reply({ ok: false, error: err instanceof AppError ? err.code : 'SFU_ERROR' });
          },
        );
      }) as any);
    };
    // Local-network routes for phones that qualify, or when the phone asks after the internet route failed.
    sfuCall('voice:sfuJoin', SCHEMAS.sfuJoin, async (p) => ctx.sfu.join(p.lobbyId, userId, { local: p.local === true || (await localRoute()).ok }));
    sfuCall('voice:sfuAnswer', SCHEMAS.sfuSdp, (p) => ctx.sfu.answer(p.lobbyId, userId, p.sdp));
    sfuCall('voice:sfuCand', SCHEMAS.sfuSdp, async (p) => {
      let list: unknown;
      try {
        list = JSON.parse(p.sdp);
      } catch {
        throw new AppError('BAD_PAYLOAD');
      }
      if (!Array.isArray(list) || list.length > 20) throw new AppError('BAD_PAYLOAD');
      for (const c of list) if (c && typeof c.candidate === 'string' && c.candidate.length < 512) await ctx.sfu.candidate(p.lobbyId, userId, c);
    });
    on('voice:leave', SCHEMAS.voiceRef, (p) => void ctx.voice.leave(p.lobbyId, userId));
    on('voice:mute', SCHEMAS.voiceMute, (p) => void ctx.voice.setMuted(p.lobbyId, userId, p.muted));
    on('voice:bitrate', SCHEMAS.voiceBitrate, (p) => void ctx.voice.setBitrate(p.lobbyId, userId, p.kbps));
    on('voice:enabled', SCHEMAS.voiceEnabled, (p) => void ctx.voice.setEnabled(p.lobbyId, userId, p.enabled));
    on('voice:reboot', SCHEMAS.voiceRef, (p) => void ctx.voice.reboot(p.lobbyId, userId));
    on('voice:signal', SCHEMAS.voiceSignal, (p) => {
      const kind = p.kind as VoiceSignalKind;
      if (kind !== 'offer' && kind !== 'answer' && kind !== 'ring' && kind !== 'cand') return { ok: false, error: 'BAD_PAYLOAD' };
      // Offers and answers carry an SDP, late candidates their JSON; a ring carries none.
      if ((kind === 'ring') !== (p.sdp.length === 0)) return { ok: false, error: 'BAD_PAYLOAD' };
      const target = ctx.voice.relayTarget(p.lobbyId, userId, p.to);
      io.to(target).emit('voice:signal', { lobbyId: p.lobbyId, from: userId, kind, call: p.call, sdp: p.sdp });
    });

    // Relayed voice: many small messages, so it has its own limit and doesn't count against the
    // game's flood protection. Late audio is skipped by the receiving phone (voiceRelay.ts).
    const relayBucket = new TokenBucket(RELAY_LIMITS.burst, RELAY_LIMITS.perSecond);
    socket.on('voice:frames', (p: unknown) => {
      if (!relayBucket.take()) return;
      const msg = p as Partial<VoiceFramesOut> | null;
      if (!msg || typeof msg.lobbyId !== 'string' || msg.lobbyId.length > 64) return;
      const to = msg.to, frames = msg.frames as unknown[];
      if (!Array.isArray(to) || to.length < 1 || to.length > RELAY_LIMITS.maxTargets || !to.every((id) => Number.isSafeInteger(id))) return;
      if (!Array.isArray(frames) || frames.length < 1 || frames.length > RELAY_LIMITS.maxFrames) return;
      if (!frames.every((f) => (Buffer.isBuffer(f) || f instanceof ArrayBuffer) && f.byteLength > 0 && f.byteLength <= RELAY_LIMITS.maxFrameBytes)) return;
      for (const id of new Set(to)) {
        let target: string;
        try {
          target = ctx.voice.relayTarget(msg.lobbyId, userId, id);
        } catch {
          continue; // not both in this voice channel
        }
        io.to(target).emit('voice:frames', { lobbyId: msg.lobbyId, from: userId, frames: frames as ArrayBuffer[] });
      }
    });

    socket.on('disconnect', () => {
      ctx.voice.dropSocket(socket.id);
      ctx.net.remove(socket.id);
      inc(perIp, ip, -1);
      if (inc(perUser, userId, -1) === 0) {
        ctx.lobbies.setConnected(userId, false);
        ctx.games.setConnected(userId, false);
      }
    });
  });
}

/**
 * Wiring for lobby broadcasts; kept separate so the LobbyManager can be built first. The lobby
 * list goes to every phone, so it is only sent when it changed: someone getting ready or a
 * phone dropping offline changes the lobby, not the list.
 */
export function lobbyBroadcaster(getIo: () => LudoServerIO | undefined, getCtx: () => Ctx | undefined) {
  let lastList = '';
  return (lobbyId: string) => {
    const io = getIo();
    const ctx = getCtx();
    if (!io || !ctx) return;
    const lobby = ctx.lobbies.get(lobbyId);
    io.to(rooms.lobby(lobbyId)).emit('lobby:state', lobby ? ctx.lobbies.toPublic(lobby) : null);
    if (!lobby) io.in(rooms.lobby(lobbyId)).socketsLeave(rooms.lobby(lobbyId));
    const list = ctx.lobbies.summaries();
    const key = JSON.stringify(list);
    if (key === lastList) return;
    lastList = key;
    io.emit('lobby:list', list);
  };
}
