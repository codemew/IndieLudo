import crypto from 'node:crypto';
import { boardOf, BOARD_SIZES, type BoardSize } from '../shared/board.js';
import { MAX_SEATS, MAX_SPECTATORS, SWAP_REQUEST_MS, type AdminLobby, type Color, type LobbyMember, type LobbySpectator, type LobbyStatus, type LobbySummary, type PublicLobby, type SwapEnd, type SwapRequest } from '../shared/types.js';
import type { DB } from './db.js';
import { AppError } from './errors.js';

export interface Lobby {
  id: string;
  name: string;
  hostId: number;
  passwordHash: string;
  /** The seats: players and bots. */
  members: LobbyMember[];
  /** People without a seat, watching. Lobbies saved before spectators existed lack it. */
  spectators: LobbySpectator[];
  status: LobbyStatus;
  gameId: string | null;
  createdAt: number;
  /** When the last connected human went offline; null while anyone is online. */
  allOfflineSince: number | null;
  /** Team-up: the next game is 2v2 (diagonal partners). Lobbies saved before Team-up lack it. */
  teams?: boolean;
  /** Seats, and the board the next game is played on. Lobbies saved before 5 and 6 seats lack it (4). */
  size?: BoardSize;
}

/** `{ avatar }` for a member or spectator, or nothing when there is none (keeps saved lobbies small). */
const avatarOf = (who: { avatar?: string }): { avatar?: string } => (who.avatar ? { avatar: who.avatar } : {});

export interface LobbyUser {
  id: number;
  username: string;
  avatar?: string;
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
  /** `admin` when an admin closed it; otherwise it emptied out or sat idle. */
  onClosed?: (lobby: Lobby, byAdmin: boolean) => void;
  /** A colour-swap request ended (answered, cancelled, expired, or a player left). */
  onSwapEnded?: (req: SwapRequest, how: SwapEnd) => void;
  /** Picks seat colours; crypto.randomInt by default, injectable so tests get fixed colours. */
  randomInt?: (min: number, max: number) => number;
  /** Lifetime wins of a player, looked up whenever the lobby is sent so it is always current. */
  winsOf?: (userId: number) => number;
}

export const MAX_MEMBERS = MAX_SEATS;

/** A lobby's seats (4, 5 or 6) and their colours. */
const sizeOf = (l: Lobby): BoardSize => l.size ?? 4;
const colorsOf = (l: Lobby): readonly Color[] => boardOf(sizeOf(l)).colors;

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

/** Every person in the lobby, seated players first, then spectators. */
export function humanIds(lobby: Pick<Lobby, 'members' | 'spectators'>): number[] {
  return [...lobby.members.filter((m) => !m.isBot && m.userId !== null).map((m) => m.userId!), ...lobby.spectators.map((s) => s.userId)];
}

/** A bot is named after the seat it sits on: "Bot Red", "Bot Green"… */
export function botName(color: Color): string {
  return `Bot ${color[0].toUpperCase()}${color.slice(1)}`;
}

export class LobbyManager {
  private lobbies = new Map<string, Lobby>();
  private byUser = new Map<number, string>();
  /** Pending colour-swap requests by asker (one each), with their expiry timers. */
  private swaps = new Map<number, { req: SwapRequest; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;

  constructor(private opts: LobbyManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Reloads persisted lobbies after a restart; everybody starts offline. */
  load(): void {
    const rows = this.opts.db.prepare('SELECT data FROM lobbies').all() as { data: string }[];
    for (const row of rows) {
      const lobby = JSON.parse(row.data) as Lobby;
      lobby.spectators ??= [];
      for (const s of lobby.spectators) s.connected = false;
      for (const m of lobby.members) {
        m.connected = m.isBot;
        // Lobbies saved before bots were renamed on a swap may hold a "Bot Red" on the green seat.
        if (m.isBot) m.username = botName(m.color);
      }
      lobby.allOfflineSince = this.now();
      this.lobbies.set(lobby.id, lobby);
      for (const id of humanIds(lobby)) this.byUser.set(id, lobby.id);
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
        hostName: [...l.members, ...l.spectators].find((m) => m.userId === l.hostId)?.username ?? '?',
        status: l.status,
        players: l.members.length,
        watching: l.spectators.length,
        teams: Boolean(l.teams),
        size: sizeOf(l),
      }));
  }

  adminList(): AdminLobby[] {
    const byId = new Map(this.summaries().map((s) => [s.id, s]));
    return this.all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => ({
        ...byId.get(l.id)!,
        createdAt: l.createdAt,
        members: [
          ...l.members.map((m) => ({ username: m.username, isBot: m.isBot, connected: m.connected })),
          ...l.spectators.map((s) => ({ username: s.username, isBot: false, connected: s.connected, watching: true })),
        ],
      }));
  }

  toPublic(l: Lobby): PublicLobby {
    const winsOf = this.opts.winsOf;
    return {
      id: l.id,
      name: l.name,
      hostId: l.hostId,
      status: l.status,
      members: l.members.map((m) => (m.isBot || m.userId === null || !winsOf ? { ...m } : { ...m, wins: winsOf(m.userId) })),
      spectators: l.spectators.map((s) => (winsOf ? { ...s, wins: winsOf(s.userId) } : { ...s })),
      gameId: l.gameId,
      teams: Boolean(l.teams),
      size: sizeOf(l),
    };
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
      members: [{ color: this.randomColor(boardOf(4).colors), userId: user.id, username: user.username, ...avatarOf(user), isBot: false, ready: false, connected: true }],
      spectators: [],
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

  /**
   * Joins on a free seat, or with `watch` as a spectator. Watching is the only way into a
   * lobby whose game is running or whose seats are all taken.
   */
  join(user: LobbyUser, lobbyId: string, password: string, watch = false): Lobby {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new AppError('LOBBY_NOT_FOUND', 404);
    if (humanIds(lobby).includes(user.id)) return lobby;
    if (!verifyLobbyPassword(password, lobby.passwordHash)) throw new AppError('WRONG_LOBBY_PASSWORD', 403);
    if (watch) {
      if (lobby.spectators.length >= MAX_SPECTATORS) throw new AppError('TOO_MANY_WATCHING', 409);
    } else {
      if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
      if (lobby.members.length >= sizeOf(lobby)) throw new AppError('LOBBY_FULL', 409);
    }
    this.leaveWaitingLobby(user.id);
    if (watch) lobby.spectators.push({ userId: user.id, username: user.username, ...avatarOf(user), connected: true });
    else lobby.members.push({ color: this.freeColor(lobby), userId: user.id, username: user.username, ...avatarOf(user), isBot: false, ready: false, connected: true });
    this.byUser.set(user.id, lobby.id);
    this.changed(lobby);
    return lobby;
  }

  /** A user may only be in one lobby; leaving a seat in a running game this way is refused. */
  private leaveWaitingLobby(userId: number): void {
    const current = this.forUser(userId);
    if (!current) return;
    if (current.status === 'playing' && current.members.some((m) => m.userId === userId)) throw new AppError('ALREADY_IN_GAME', 409);
    this.leave(userId);
  }

  leave(userId: number): void {
    const lobby = this.forUser(userId);
    if (!lobby) return;
    this.dropSwaps((r) => r.from === userId || r.to === userId, 'cancelled');
    const seated = lobby.members.some((m) => m.userId === userId);
    lobby.members = lobby.members.filter((m) => m.userId !== userId);
    lobby.spectators = lobby.spectators.filter((s) => s.userId !== userId);
    this.byUser.delete(userId);
    if (seated && lobby.status === 'playing') this.opts.onLeaveGame?.(lobby, userId);
    this.opts.onMemberLeft?.(lobby, userId);
    const humans = humanIds(lobby);
    if (humans.length === 0) {
      this.close(lobby);
      return;
    }
    if (lobby.hostId === userId) lobby.hostId = humans[0];
    this.changed(lobby);
  }

  /** Gives up your seat to watch instead (between games). */
  spectate(userId: number): Lobby {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    if (lobby.spectators.length >= MAX_SPECTATORS) throw new AppError('TOO_MANY_WATCHING', 409);
    this.dropSwaps((r) => r.from === userId || r.to === userId, 'cancelled');
    lobby.members = lobby.members.filter((m) => m !== member);
    lobby.spectators.push({ userId, username: member.username, ...avatarOf(member), connected: member.connected });
    this.changed(lobby);
    return lobby;
  }

  /** A spectator takes the open seat `color` (between games). */
  sit(userId: number, color: Color): Lobby {
    const lobby = this.forUser(userId);
    const spectator = lobby?.spectators.find((s) => s.userId === userId);
    if (!lobby || !spectator) throw new AppError('NOT_WATCHING', 409);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    if (!colorsOf(lobby).includes(color)) throw new AppError('INVALID_COLOR');
    if (lobby.members.some((m) => m.color === color)) throw new AppError('COLOR_TAKEN', 409);
    lobby.spectators = lobby.spectators.filter((s) => s !== spectator);
    lobby.members.push({ color, userId, username: spectator.username, ...avatarOf(spectator), isBot: false, ready: false, connected: spectator.connected });
    this.changed(lobby);
    return lobby;
  }

  setColor(userId: number, color: Color): Lobby {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    if (!colorsOf(lobby).includes(color)) throw new AppError('INVALID_COLOR');
    if (member.color === color) return lobby;
    if (lobby.members.some((m) => m.color === color)) throw new AppError('COLOR_TAKEN', 409);
    // Any swap request involving this player was about the old colour.
    this.dropSwaps((r) => r.from === userId || r.to === userId, 'cancelled');
    member.color = color;
    this.changed(lobby);
    return lobby;
  }

  /**
   * Ask the player on `color` to swap colours. A bot can't answer, so swapping with a bot
   * happens at once; so does asking someone who is already asking you. Otherwise the request
   * waits SWAP_REQUEST_MS for an answer.
   */
  askSwap(userId: number, color: Color): { swapped: true; lobby: Lobby } | { swapped: false; req: SwapRequest } {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    const other = lobby.members.find((m) => m.color === color);
    if (!other) throw new AppError('SEAT_EMPTY', 409);
    if (other === member) throw new AppError('SAME_SEAT');
    if (other.isBot || this.swaps.get(other.userId!)?.req.to === userId) {
      if (!other.isBot) this.dropSwaps((r) => r.from === other.userId, 'accepted');
      this.dropSwaps((r) => r.from === userId, 'cancelled');
      [member.color, other.color] = [other.color, member.color];
      if (other.isBot) other.username = botName(other.color); // a bot is named after its seat
      this.changed(lobby);
      return { swapped: true, lobby };
    }
    this.dropSwaps((r) => r.from === userId, 'cancelled');
    const req: SwapRequest = {
      lobbyId: lobby.id,
      from: userId,
      fromName: member.username,
      to: other.userId!,
      fromColor: member.color,
      toColor: other.color,
      expiresAt: this.now() + SWAP_REQUEST_MS,
    };
    const timer = setTimeout(() => this.dropSwaps((r) => r === req, 'expired'), SWAP_REQUEST_MS);
    timer.unref?.();
    this.swaps.set(userId, { req, timer });
    return { swapped: false, req };
  }

  /** The asked player's answer. Fails if the request lapsed or either colour changed since. */
  answerSwap(userId: number, from: number, accept: boolean): Lobby {
    const entry = this.swaps.get(from);
    if (!entry || entry.req.to !== userId) throw new AppError('SWAP_EXPIRED', 409);
    const { req } = entry;
    const lobby = this.lobbies.get(req.lobbyId);
    const asker = lobby?.members.find((m) => m.userId === from);
    const me = lobby?.members.find((m) => m.userId === userId);
    if (!lobby || lobby.status !== 'waiting' || asker?.color !== req.fromColor || me?.color !== req.toColor) {
      this.dropSwaps((r) => r === req, 'expired');
      throw new AppError('SWAP_EXPIRED', 409);
    }
    this.dropSwaps((r) => r === req, accept ? 'accepted' : 'declined');
    if (accept) {
      [asker.color, me.color] = [me.color, asker.color];
      this.changed(lobby);
    }
    return lobby;
  }

  /** The asker changed their mind. */
  cancelSwap(userId: number): void {
    this.dropSwaps((r) => r.from === userId, 'cancelled');
  }

  pendingSwaps(lobbyId: string): SwapRequest[] {
    return [...this.swaps.values()].map((e) => e.req).filter((r) => r.lobbyId === lobbyId);
  }

  private dropSwaps(match: (r: SwapRequest) => boolean, how: SwapEnd): void {
    for (const [from, e] of this.swaps) {
      if (!match(e.req)) continue;
      clearTimeout(e.timer);
      this.swaps.delete(from);
      this.opts.onSwapEnded?.(e.req, how);
    }
  }

  setReady(userId: number, ready: boolean): Lobby {
    const { lobby, member } = this.memberOf(userId);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    member.ready = ready;
    this.changed(lobby);
    return lobby;
  }

  /**
   * Host: Classic or Team-up for the next game. Everyone else's "ready" is cleared, since the
   * game they said yes to has changed.
   */
  setTeams(userId: number, teams: boolean): Lobby {
    const lobby = this.hostLobby(userId);
    if (Boolean(lobby.teams) === teams) return lobby;
    if (teams && sizeOf(lobby) !== 4) throw new AppError('TEAMS_NEED_FOUR');
    lobby.teams = teams;
    for (const m of lobby.members) m.ready = m.isBot;
    this.changed(lobby);
    return lobby;
  }

  /**
   * Host: how many seats (4, 5 or 6), so which board the next game is played on. Team-up is only
   * for 4. Players on a colour the smaller board lacks move to a free one; a board too small for
   * everyone seated is refused. Everyone else's "ready" is cleared, as for the mode.
   */
  setSize(userId: number, size: BoardSize): Lobby {
    const lobby = this.hostLobby(userId);
    if (!BOARD_SIZES.includes(size)) throw new AppError('BAD_PAYLOAD');
    if (sizeOf(lobby) === size) return lobby;
    if (lobby.members.length > size) throw new AppError('TOO_MANY_PLAYERS', 409);
    this.dropSwaps((r) => r.lobbyId === lobby.id, 'cancelled');
    lobby.size = size;
    if (size !== 4) lobby.teams = false;
    const colors = boardOf(size).colors;
    for (const m of lobby.members.filter((x) => !colors.includes(x.color))) {
      m.color = this.freeColor(lobby);
      if (m.isBot) m.username = botName(m.color);
    }
    for (const m of lobby.members) m.ready = m.isBot;
    this.changed(lobby);
    return lobby;
  }

  /** Adds a bot on the seat the host tapped (`color`), or on a random free seat if none was given. */
  addBot(userId: number, color?: Color): Lobby {
    const lobby = this.hostLobby(userId);
    if (lobby.members.length >= sizeOf(lobby)) throw new AppError('LOBBY_FULL', 409);
    if (color !== undefined && !colorsOf(lobby).includes(color)) throw new AppError('INVALID_COLOR');
    if (color !== undefined && lobby.members.some((m) => m.color === color)) throw new AppError('COLOR_TAKEN', 409);
    const seat = color ?? this.freeColor(lobby);
    lobby.members.push({ color: seat, userId: null, username: botName(seat), isBot: true, ready: true, connected: true });
    this.changed(lobby);
    return lobby;
  }

  /** A bot on every open seat: with the host watching, that's a bot battle. */
  fillBots(userId: number): Lobby {
    const lobby = this.hostLobby(userId);
    for (const seat of colorsOf(lobby)) {
      if (!lobby.members.some((m) => m.color === seat)) lobby.members.push({ color: seat, userId: null, username: botName(seat), isBot: true, ready: true, connected: true });
    }
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
    if (!humanIds(lobby).includes(targetId)) throw new AppError('NOT_FOUND', 404);
    this.leave(targetId);
    return lobby;
  }

  /** Validates that the host may start now. The caller creates the game and calls markPlaying. */
  checkStart(userId: number): Lobby {
    const lobby = this.hostLobby(userId);
    if (lobby.members.length < 2) throw new AppError('NOT_ENOUGH_PLAYERS');
    if (lobby.teams && (sizeOf(lobby) !== 4 || lobby.members.length < 4)) throw new AppError('TEAMS_NEED_FOUR');
    // The host starting the game counts as being ready.
    if (lobby.members.some((m) => !m.isBot && m.userId !== lobby.hostId && !m.ready)) throw new AppError('NOT_ALL_READY');
    return lobby;
  }

  markPlaying(lobbyId: string, gameId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return;
    this.dropSwaps((r) => r.lobbyId === lobbyId, 'cancelled');
    lobby.status = 'playing';
    lobby.gameId = gameId;
    this.changed(lobby);
  }

  /**
   * After a game: drop bots and people who are still offline (so no ghost seats linger),
   * reset readiness and reopen the lobby, or close it if no connected human is left. After a
   * bot battle the bots stay seated, so the spectators can start another right away.
   */
  finishGame(lobbyId: string, keepBots = false): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return;
    const gone = [...lobby.members.filter((m) => !m.isBot && !m.connected && m.userId !== null).map((m) => m.userId!), ...lobby.spectators.filter((s) => !s.connected).map((s) => s.userId)];
    for (const id of gone) {
      this.byUser.delete(id);
      this.opts.onMemberLeft?.(lobby, id);
    }
    lobby.members = lobby.members.filter((m) => (m.isBot ? keepBots : m.connected));
    lobby.spectators = lobby.spectators.filter((s) => s.connected);
    for (const m of lobby.members) m.ready = m.isBot;
    lobby.status = 'waiting';
    lobby.gameId = null;
    const humans = humanIds(lobby);
    if (humans.length === 0) {
      this.close(lobby);
      return;
    }
    if (!humans.includes(lobby.hostId)) lobby.hostId = humans[0];
    this.changed(lobby);
  }

  setConnected(userId: number, connected: boolean): void {
    const lobby = this.forUser(userId);
    if (!lobby) return;
    const member = lobby.members.find((m) => m.userId === userId) ?? lobby.spectators.find((s) => s.userId === userId);
    if (!member || member.connected === connected) return;
    member.connected = connected;
    const anyoneOnline = lobby.members.some((m) => !m.isBot && m.connected) || lobby.spectators.some((s) => s.connected);
    lobby.allOfflineSince = anyoneOnline ? null : (lobby.allOfflineSince ?? this.now());
    this.changed(lobby);
  }

  /** The player changed their name or avatar: the lobby they are in shows it right away. */
  updateUser(userId: number, profile: { username: string; avatar?: string }): void {
    const lobby = this.forUser(userId);
    const member = lobby?.members.find((m) => m.userId === userId) ?? lobby?.spectators.find((s) => s.userId === userId);
    if (!lobby || !member) return;
    member.username = profile.username;
    if (profile.avatar) member.avatar = profile.avatar;
    else delete member.avatar;
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

  /** Admin: closes a lobby whatever its state. A running game in it is stopped. */
  closeByAdmin(lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new AppError('LOBBY_NOT_FOUND', 404);
    this.close(lobby, true);
  }

  private close(lobby: Lobby, byAdmin = false): void {
    this.dropSwaps((r) => r.lobbyId === lobby.id, 'cancelled');
    this.lobbies.delete(lobby.id);
    for (const id of humanIds(lobby)) if (this.byUser.get(id) === lobby.id) this.byUser.delete(id);
    this.opts.db.prepare('DELETE FROM lobbies WHERE id = ?').run(lobby.id);
    this.opts.onClosed?.(lobby, byAdmin);
    this.opts.onChange?.(lobby.id, null);
  }

  private changed(lobby: Lobby): void {
    this.opts.db
      .prepare('INSERT INTO lobbies (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(lobby.id, JSON.stringify(lobby));
    this.opts.onChange?.(lobby.id, lobby);
  }

  /** A random colour nobody in the lobby has: the host isn't always red, nor joiners green. */
  private freeColor(lobby: Lobby): Color {
    const free = colorsOf(lobby).filter((c) => !lobby.members.some((m) => m.color === c));
    if (!free.length) throw new AppError('LOBBY_FULL', 409);
    return this.randomColor(free);
  }

  private randomColor(options: readonly Color[]): Color {
    return options[(this.opts.randomInt ?? crypto.randomInt)(0, options.length)];
  }

  private memberOf(userId: number): { lobby: Lobby; member: LobbyMember } {
    const lobby = this.forUser(userId);
    const member = lobby?.members.find((m) => m.userId === userId);
    if (!lobby) throw new AppError('NOT_IN_LOBBY', 404);
    if (!member) throw new AppError('NOT_SEATED', 409); // watching
    return { lobby, member };
  }

  /** The host's lobby, between games. The host may be seated or watching. */
  private hostLobby(userId: number): Lobby {
    const lobby = this.forUser(userId);
    if (!lobby) throw new AppError('NOT_IN_LOBBY', 404);
    if (lobby.hostId !== userId) throw new AppError('NOT_HOST', 403);
    if (lobby.status !== 'waiting') throw new AppError('GAME_IN_PROGRESS', 409);
    return lobby;
  }
}
