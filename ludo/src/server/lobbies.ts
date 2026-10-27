import crypto from 'node:crypto';
import { COLORS, type Color, type LobbyMember, type LobbyStatus, type LobbySummary, type PublicLobby } from '../shared/types.js';
import type { DB } from './db.js';
import { AppError } from './errors.js';

export interface Lobby {
  id: string;
  name: string;
  hostId: number;
  passwordHash: string;
  members: LobbyMember[];
  status: LobbyStatus;
  gameId: string | null;
  createdAt: number;
  /** When the last connected human went offline; null while anyone is online. */
  allOfflineSince: number | null;
}

export interface LobbyUser {
  id: number;
  username: string;
}

export interface LobbyManagerOptions {
  db: DB;
  lobbyCreatePassword: string;
  maxLobbies: number;
  lobbyIdleCloseSec: number;
  now?: () => number;
  /** Called after any change; `lobby` is null when it was closed. */
  onChange?: (lobbyId: string, lobby: Lobby | null) => void;
  /** A member left (or was removed) while the lobby's game is running. */
  onLeaveGame?: (lobby: Lobby, userId: number) => void;
  /** A human member left, was kicked, or was dropped after a game. */
  onMemberLeft?: (lobby: Lobby, userId: number) => void;
  onClosed?: (lobby: Lobby) => void;
}

export const MAX_MEMBERS = 4;

export function hashLobbyPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyLobbyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Constant-time comparison of two secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export class LobbyManager {
  private lobbies = new Map<string, Lobby>();
  private byUser = new Map<number, string>();
  private readonly now: () => number;

  constructor(private opts: LobbyManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Reloads persisted lobbies after a restart; everybody starts offline. */
  load(): void {
    const rows = this.opts.db.prepare('SELECT data FROM lobbies').all() as { data: string }[];
    for (const row of rows) {
      const lobby = JSON.parse(row.data) as Lobby;
      for (const m of lobby.members) m.connected = m.isBot;
      lobby.allOfflineSince = this.now();
      this.lobbies.set(lobby.id, lobby);
      for (const m of lobby.members) if (m.userId !== null) this.byUser.set(m.userId, lobby.id);
    }
  }

  get(id: string): Lobby | undefined {
    return this.lobbies.get(id);
  }

  forUser(userId: number): Lobby | undefined {
    const id = this.byUser.get(userId);
    return id ? this.lobbies.get(id) : undefined;
  }

  all(): Lobby[] {
    return [...this.lobbies.values()];
  }

  summaries(): LobbySummary[] {
    return this.all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => ({
        id: l.id,
        name: l.name,
        hostName: l.members.find((m) => m.userId === l.hostId)?.username ?? '?',
        status: l.status,
        players: l.members.length,
      }));
  }

  toPublic(l: Lobby): PublicLobby {
    return { id: l.id, name: l.name, hostId: l.hostId, status: l.status, members: l.members.map((m) => ({ ...m })), gameId: l.gameId };
  }

  create(user: LobbyUser, input: { createPassword: string; name: string; password: string }): Lobby {
    if (!safeEqual(input.createPassword, this.opts.lobbyCreatePassword)) throw new AppError('WRONG_CREATE_PASSWORD', 403);
    const name = input.name.trim();
    if (!name || name.length > 32) throw new AppError('INVALID_NAME');
    if (!input.password) throw new AppError('PASSWORD_REQUIRED');
    if (this.lobbies.size >= this.opts.maxLobbies) throw new AppError('TOO_MANY_LOBBIES', 503);
    this.leaveWaitingLobby(user.id);
    const lobby: Lobby = {
      id: crypto.randomBytes(6).toString('base64url'),
      name,
      hostId: user.id,
      passwordHash: hashLobbyPassword(input.password),
      members: [{ color: COLORS[0], userId: user.id, username: user.username, isBot: false, ready: false, connected: true }],
      status: 'waiting',
      gameId: null,
      createdAt: this.now(),
      allOfflineSince: null,
    };
    this.lobbies.set(lobby.id, lobby);
    this.byUser.set(user.id, lobby.id);
    this.changed(lobby);
    return lobby;
  }

  join(user: LobbyUser, lobbyId: string, password: string): Lobby {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new AppError('LOBBY_NOT_FOUND', 404);
    if (lobby.members.some((m) => m.userId === user.id)) return lobby;
    if (!verifyLobbyPassword(password, lobby.passwordHash)) throw new AppError('WRONG_LOBBY_PASSWORD', 403);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    if (lobby.members.length >= MAX_MEMBERS) throw new AppError('LOBBY_FULL', 409);
    this.leaveWaitingLobby(user.id);
    lobby.members.push({ color: this.freeColor(lobby), userId: user.id, username: user.username, isBot: false, ready: false, connected: true });
    this.byUser.set(user.id, lobby.id);
    this.changed(lobby);
    return lobby;
  }

  /** A user may only sit in one lobby; switching away from a running game is refused. */
  private leaveWaitingLobby(userId: number): void {
    const current = this.forUser(userId);
    if (!current) return;
    if (current.status === 'playing') throw new AppError('ALREADY_IN_GAME', 409);
    this.leave(userId);
  }

  leave(userId: number): void {
    const lobby = this.forUser(userId);
    if (!lobby) return;
    lobby.members = lobby.members.filter((m) => m.userId !== userId);
    this.byUser.delete(userId);
    if (lobby.status === 'playing') this.opts.onLeaveGame?.(lobby, userId);
    this.opts.onMemberLeft?.(lobby, userId);
    const humans = lobby.members.filter((m) => !m.isBot);
    if (humans.length === 0) {
      this.close(lobby);
      return;
    }
    if (lobby.hostId === userId) lobby.hostId = humans[0].userId!;
    this.changed(lobby);
  }

  setColor(userId: number, color: Color): Lobby {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    if (!COLORS.includes(color)) throw new AppError('INVALID_COLOR');
    if (member.color === color) return lobby;
    if (lobby.members.some((m) => m.color === color)) throw new AppError('COLOR_TAKEN', 409);
    member.color = color;
    this.changed(lobby);
    return lobby;
  }

  setReady(userId: number, ready: boolean): Lobby {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    member.ready = ready;
    this.changed(lobby);
    return lobby;
  }

  addBot(userId: number): Lobby {
    const lobby = this.hostLobby(userId);
    if (lobby.members.length >= MAX_MEMBERS) throw new AppError('LOBBY_FULL', 409);
    const color = this.freeColor(lobby);
    lobby.members.push({ color, userId: null, username: `Bot ${color[0].toUpperCase()}${color.slice(1)}`, isBot: true, ready: true, connected: true });
    this.changed(lobby);
    return lobby;
  }

  removeBot(userId: number, color: Color): Lobby {
    const lobby = this.hostLobby(userId);
    const idx = lobby.members.findIndex((m) => m.isBot && m.color === color);
    if (idx < 0) throw new AppError('NOT_FOUND', 404);
    lobby.members.splice(idx, 1);
    this.changed(lobby);
    return lobby;
  }

  kick(hostId: number, targetId: number): Lobby {
    const lobby = this.hostLobby(hostId);
    if (targetId === hostId) throw new AppError('CANNOT_KICK_SELF');
    if (!lobby.members.some((m) => m.userId === targetId)) throw new AppError('NOT_FOUND', 404);
    this.leave(targetId);
    return lobby;
  }

  /** Validates that the host may start now. The caller creates the game and calls markPlaying. */
  checkStart(userId: number): Lobby {
    const lobby = this.hostLobby(userId);
    if (lobby.members.length < 2) throw new AppError('NOT_ENOUGH_PLAYERS');
    // The host starting the game counts as being ready.
    if (lobby.members.some((m) => !m.isBot && m.userId !== lobby.hostId && !m.ready)) throw new AppError('NOT_ALL_READY');
    return lobby;
  }

  markPlaying(lobbyId: string, gameId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return;
    lobby.status = 'playing';
    lobby.gameId = gameId;
    this.changed(lobby);
  }

  /**
   * After a game: drop bots and humans who are still offline (so no ghost seats linger),
   * reset readiness and reopen the lobby, or close it if no connected human is left.
   */
  finishGame(lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return;
    for (const m of lobby.members) {
      if (!m.isBot && !m.connected && m.userId !== null) {
        this.byUser.delete(m.userId);
        this.opts.onMemberLeft?.(lobby, m.userId);
      }
    }
    lobby.members = lobby.members.filter((m) => !m.isBot && m.connected);
    for (const m of lobby.members) m.ready = false;
    lobby.status = 'waiting';
    lobby.gameId = null;
    if (lobby.members.length === 0) {
      this.close(lobby);
      return;
    }
    if (!lobby.members.some((m) => m.userId === lobby.hostId)) lobby.hostId = lobby.members[0].userId!;
    this.changed(lobby);
  }

  setConnected(userId: number, connected: boolean): void {
    const lobby = this.forUser(userId);
    if (!lobby) return;
    const member = lobby.members.find((m) => m.userId === userId);
    if (!member || member.connected === connected) return;
    member.connected = connected;
    const anyoneOnline = lobby.members.some((m) => !m.isBot && m.connected);
    lobby.allOfflineSince = anyoneOnline ? null : (lobby.allOfflineSince ?? this.now());
    this.changed(lobby);
  }

  renameUser(userId: number, username: string): void {
    const lobby = this.forUser(userId);
    const member = lobby?.members.find((m) => m.userId === userId);
    if (!lobby || !member) return;
    member.username = username;
    this.changed(lobby);
  }

  /** Closes lobbies whose humans have all been offline for longer than lobbyIdleCloseSec. */
  sweep(): number {
    const now = this.now();
    let closed = 0;
    for (const lobby of this.all()) {
      if (lobby.allOfflineSince !== null && now - lobby.allOfflineSince >= this.opts.lobbyIdleCloseSec * 1000) {
        this.close(lobby);
        closed++;
      }
    }
    return closed;
  }

  private close(lobby: Lobby): void {
    this.lobbies.delete(lobby.id);
    for (const m of lobby.members) if (m.userId !== null && this.byUser.get(m.userId) === lobby.id) this.byUser.delete(m.userId);
    this.opts.db.prepare('DELETE FROM lobbies WHERE id = ?').run(lobby.id);
    this.opts.onClosed?.(lobby);
    this.opts.onChange?.(lobby.id, null);
  }

  private changed(lobby: Lobby): void {
    this.opts.db
      .prepare('INSERT INTO lobbies (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(lobby.id, JSON.stringify(lobby));
    this.opts.onChange?.(lobby.id, lobby);
  }

  private freeColor(lobby: Lobby): Color {
    const color = COLORS.find((c) => !lobby.members.some((m) => m.color === c));
    if (!color) throw new AppError('LOBBY_FULL', 409);
    return color;
  }

  private memberOf(userId: number): { lobby: Lobby; member: LobbyMember } {
    const lobby = this.forUser(userId);
    const member = lobby?.members.find((m) => m.userId === userId);
    if (!lobby || !member) throw new AppError('NOT_IN_LOBBY', 404);
    return { lobby, member };
  }

  private hostLobby(userId: number): Lobby {
    const { lobby } = this.memberOf(userId);
    if (lobby.hostId !== userId) throw new AppError('NOT_HOST', 403);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    return lobby;
  }
}
