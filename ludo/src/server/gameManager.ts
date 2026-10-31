import crypto from 'node:crypto';
import { SCHEMAS, matchesSchema, type Ack } from '../shared/protocol.js';
import { BASE } from '../shared/board.js';
import { BASE_EXIT_HOPS, moveMs } from '../shared/heft.js';
import { RuleError, applyMove, applyRespawn, applyRoll, applySurrender, createGameState, distinctChoices, legalMoves } from '../shared/rules.js';
import { FIRST_BLOOD_MS, MAX_MISSED_TURNS, SURRENDER_MS, WILDCARD_MS, WILDCARD_STAGGER_MS, tempoOf, type GameEvent, type GameState, type PublicGameState, type Seat } from '../shared/types.js';
import { chooseMove } from './bot.js';
import type { DB } from './db.js';
import type { DiceFn } from './dice.js';
import type { Lobby } from './lobbies.js';


export interface GameManagerOptions {
  db: DB;
  dice: DiceFn;
  turnTimeoutSec: number;
  disconnectGraceSec: number;
  /** "Thinking" pause before a bot acts, on top of the time the clients spend animating. */
  botDelayMs?: number;
  /** Pause before the server plays a human's only possible move. */
  autoMoveDelayMs?: number;
  /** Scales the animation time the server waits out before acting (0 in tests). */
  animScale?: number;
  randomInt?: (min: number, max: number) => number;
  onUpdate?: (state: PublicGameState, events?: GameEvent[]) => void;
  onGameOver?: (state: GameState) => void;
  log?: (msg: string) => void;
}

interface LiveGame {
  state: GameState;
  timer?: NodeJS.Timeout;
  graceTimers: Map<number, NodeJS.Timeout>;
  /** Recently applied action ids, oldest first, for idempotent retries. */
  seen: Set<string>;
  /** Events of the last change, so the next timer can wait until clients finish animating them. */
  lastEvents: GameEvent[];
}

const SEEN_LIMIT = 500;
/** A bot battle's bots don't stop to "think": they act as soon as the phones finish animating. */
const BOT_BATTLE_THINK_MS = 100;
const FINISHED_RETENTION_MS = 10 * 60_000;

export class GameManager {
  private games = new Map<string, LiveGame>();
  private readonly botDelayMs: number;
  private readonly autoMoveDelayMs: number;
  private readonly animScale: number;
  private readonly randomInt: (min: number, max: number) => number;

  constructor(private opts: GameManagerOptions) {
    this.botDelayMs = opts.botDelayMs ?? 1400;
    this.autoMoveDelayMs = opts.autoMoveDelayMs ?? 700;
    this.animScale = opts.animScale ?? 1;
    this.randomInt = opts.randomInt ?? ((min, max) => crypto.randomInt(min, max));
  }

  get(gameId: string): GameState | undefined {
    return this.games.get(gameId)?.state;
  }

  /** Live game, or a finished one from the database (for players who missed the ending). */
  find(gameId: string): GameState | undefined {
    const live = this.games.get(gameId);
    if (live) return live.state;
    const row = this.opts.db.prepare('SELECT state_json FROM games WHERE id = ?').get(gameId) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as GameState) : undefined;
  }

  publicState(state: GameState): PublicGameState {
    return { ...state, legalMoves: legalMoves(state), serverNow: Date.now() };
  }

  create(lobby: Lobby): GameState {
    const seats: Omit<Seat, 'timeouts'>[] = lobby.members.map((m) => ({
      color: m.color,
      userId: m.userId,
      username: m.username,
      ...(m.avatar && { avatar: m.avatar }),
      controller: m.isBot ? 'bot' : 'human',
      connected: m.isBot || m.connected,
    }));
    const state = createGameState({
      id: crypto.randomUUID(),
      lobbyId: lobby.id,
      seats,
      firstSeat: this.randomInt(0, seats.length),
      teams: Boolean(lobby.teams),
      board: lobby.size,
    });
    if (seats.every((s) => s.controller === 'bot')) state.botBattle = true;
    const game: LiveGame = { state, graceTimers: new Map(), seen: new Set(), lastEvents: [] };
    this.games.set(state.id, game);
    for (const seat of state.seats) if (seat.controller === 'human' && !seat.connected) this.startGrace(game, seat);
    this.schedule(game);
    this.persist(game);
    return state;
  }

  /** Reloads unfinished games after a restart. Everyone is offline until they reconnect. */
  restore(): number {
    const rows = this.opts.db.prepare('SELECT state_json FROM games WHERE finished = 0').all() as { state_json: string }[];
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as GameState;
      const game: LiveGame = { state, graceTimers: new Map(), seen: new Set(), lastEvents: [] };
      this.games.set(state.id, game);
      for (const seat of state.seats) {
        if (seat.controller === 'bot') continue;
        seat.connected = false;
        if (seat.controller === 'human') this.startGrace(game, seat);
      }
      this.schedule(game);
      this.persist(game);
    }
    return rows.length;
  }

  roll(userId: number, payload: unknown): Ack {
    if (!matchesSchema(payload, SCHEMAS.roll)) return this.badPayload(userId, 'game:roll', payload);
    const p = payload as { gameId: string; version: number; actionId: string };
    return this.intent(userId, p, 'rolling', (state) => applyRoll(state, this.opts.dice()));
  }

  move(userId: number, payload: unknown): Ack {
    if (!matchesSchema(payload, SCHEMAS.move)) return this.badPayload(userId, 'game:move', payload);
    const p = payload as { gameId: string; version: number; actionId: string; dieIndex: number; tokenId: number; lap?: boolean };
    return this.intent(userId, p, 'moving', (state) => applyMove(state, p.dieIndex, p.tokenId, p.lap === true));
  }

  private badPayload(userId: number, event: string, payload: unknown): Ack {
    this.opts.log?.(`[anticheat] user ${userId} sent malformed ${event}: ${JSON.stringify(payload)?.slice(0, 200)}`);
    return { ok: false, error: 'BAD_PAYLOAD' };
  }

  /**
   * Validation order: duplicate action → seat ownership → phase → version → legality.
   * The die is only rolled after every check has passed.
   */
  private intent(
    userId: number,
    p: { gameId: string; version: number; actionId: string },
    phase: GameState['turn']['phase'],
    apply: (state: GameState) => GameEvent[],
  ): Ack {
    const game = this.games.get(p.gameId);
    if (!game) return { ok: false, error: 'NO_GAME' };
    const { state } = game;
    if (game.seen.has(p.actionId)) return { ok: true };
    if (state.finished) return { ok: false, error: 'GAME_OVER' };
    const seat = state.seats[state.turn.seat];
    if (seat.userId !== userId || seat.controller === 'bot') return { ok: false, error: 'NOT_YOUR_TURN' };
    if (state.turn.phase !== phase) return { ok: false, error: 'WRONG_PHASE' };
    if (p.version !== state.version) return { ok: false, error: 'STALE_VERSION' };
    const seatBefore = state.turn.seat;
    let events: GameEvent[];
    try {
      events = apply(state);
    } catch (err) {
      if (err instanceof RuleError) return { ok: false, error: err.code };
      throw err;
    }
    // Acting yourself takes the seat (and the rest of an auto-played turn) back.
    seat.controller = 'human';
    seat.timeouts = 0;
    state.turn.auto = false;
    this.remember(game, p.actionId);
    this.commit(game, events, seatBefore);
    return { ok: true };
  }

  /**
   * A player gives up, at any time (not only on their turn). Anyone seated can, also while a
   * takeover bot plays for them; a retry with the same action id is a no-op.
   */
  surrender(userId: number, payload: unknown): Ack {
    if (!matchesSchema(payload, SCHEMAS.surrender)) return this.badPayload(userId, 'game:surrender', payload);
    const p = payload as { gameId: string; actionId: string };
    return this.anytime(userId, p, 'surrendered', (state, seat) => applySurrender(state, seat.color));
  }

  /**
   * A wildcard entry: home tokens (a bitmask of token ids) go back to base. Any time, like a
   * surrender, and it doesn't take a seat back from a takeover bot.
   */
  respawn(userId: number, payload: unknown): Ack {
    if (!matchesSchema(payload, SCHEMAS.respawn)) return this.badPayload(userId, 'game:respawn', payload);
    const p = payload as { gameId: string; actionId: string; tokens: number };
    const ids = [0, 1, 2, 3].filter((i) => p.tokens & (1 << i));
    return this.anytime(userId, p, `made a wildcard entry (${ids.join(',')})`, (state, seat) => applyRespawn(state, seat.color, ids));
  }

  /**
   * An action a seated player may take whatever the turn (surrender, wildcard entry). A retry
   * with the same action id is a no-op. The current player's timer is paused for it, not reset.
   */
  private anytime(userId: number, p: { gameId: string; actionId: string }, what: string, apply: (state: GameState, seat: Seat) => GameEvent[]): Ack {
    const game = this.games.get(p.gameId);
    if (!game) return { ok: false, error: 'NO_GAME' };
    if (game.seen.has(p.actionId)) return { ok: true };
    const seat = game.state.seats.find((s) => s.userId === userId);
    if (!seat) return { ok: false, error: 'NOT_SEATED' };
    const seatBefore = game.state.turn.seat;
    let events: GameEvent[];
    try {
      events = apply(game.state, seat);
    } catch (err) {
      if (err instanceof RuleError) return { ok: false, error: err.code };
      throw err;
    }
    this.opts.log?.(`[game ${game.state.id}] ${seat.username} ${what}`);
    this.remember(game, p.actionId);
    this.commit(game, events, seatBefore, true);
    return { ok: true };
  }

  /** Hand a seat back from the takeover bot without making a move. */
  takeback(userId: number, gameId: string): Ack {
    const game = this.games.get(gameId);
    const seat = game?.state.seats.find((s) => s.userId === userId);
    if (!game || !seat) return { ok: false, error: 'NO_GAME' };
    if (seat.controller === 'takeover') {
      seat.controller = 'human';
      seat.timeouts = 0;
      this.touch(game);
    }
    return { ok: true };
  }

  setConnected(userId: number, connected: boolean): void {
    for (const game of this.games.values()) {
      if (game.state.finished) continue;
      const seat = game.state.seats.find((s) => s.userId === userId);
      if (!seat || seat.controller === 'bot' || seat.connected === connected) continue;
      seat.connected = connected;
      let controllerChanged = false;
      if (connected) {
        clearTimeout(game.graceTimers.get(userId));
        game.graceTimers.delete(userId);
        if (seat.controller === 'takeover') {
          seat.controller = 'human';
          seat.timeouts = 0;
          controllerChanged = true;
        }
      } else {
        this.startGrace(game, seat);
      }
      this.touch(game, controllerChanged);
    }
  }

  /** The player left the game for good: a bot plays their seat until the end. */
  leave(gameId: string, userId: number): void {
    const game = this.games.get(gameId);
    const seat = game?.state.seats.find((s) => s.userId === userId);
    if (!game || !seat || game.state.finished) return;
    clearTimeout(game.graceTimers.get(userId));
    game.graceTimers.delete(userId);
    seat.controller = 'bot';
    seat.userId = null;
    seat.connected = true;
    this.touch(game);
  }

  /** The player changed their name or avatar ('' = none): games in progress show it right away. */
  updateUser(userId: number, profile: { username: string; avatar: string }): void {
    for (const game of this.games.values()) {
      const seat = game.state.seats.find((s) => s.userId === userId);
      if (seat) {
        seat.username = profile.username;
        if (profile.avatar) seat.avatar = profile.avatar;
        else delete seat.avatar;
        this.touch(game, false);
      }
    }
  }

  /** Drops a game whose lobby closed (everyone gone). */
  abort(gameId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;
    this.clearTimers(game);
    game.state.finished = true;
    this.persist(game);
    this.games.delete(gameId);
  }

  shutdown(): void {
    for (const game of this.games.values()) this.clearTimers(game);
  }

  private startGrace(game: LiveGame, seat: Seat): void {
    if (seat.userId === null) return;
    const userId = seat.userId;
    clearTimeout(game.graceTimers.get(userId));
    game.graceTimers.set(
      userId,
      setTimeout(() => {
        game.graceTimers.delete(userId);
        if (!seat.connected && seat.controller === 'human' && !game.state.finished) {
          seat.controller = 'takeover';
          this.opts.log?.(`[game ${game.state.id}] ${seat.username} offline for ${this.opts.disconnectGraceSec}s; bot takes over`);
          this.touch(game);
        }
      }, this.opts.disconnectGraceSec * 1000),
    );
  }

  private remember(game: LiveGame, actionId: string): void {
    game.seen.add(actionId);
    if (game.seen.size > SEEN_LIMIT) game.seen.delete(game.seen.values().next().value!);
  }

  /**
   * Applies a game-logic change: new version, timers, persistence, broadcast. `pause`: someone
   * acted out of turn, so the current player keeps the time they had left (plus the animation).
   */
  private commit(game: LiveGame, events: GameEvent[], seatBefore: number, pause = false): void {
    game.state.version++;
    // Auto-play covers the rest of one turn only (bonus rolls included).
    if (game.state.turn.seat !== seatBefore) game.state.turn.auto = false;
    game.lastEvents = events;
    const left = game.state.turn.deadline - Date.now();
    this.schedule(game, pause && game.state.turn.seat === seatBefore && game.state.turn.deadline > 0 ? Math.max(0, left) : undefined);
    this.persist(game);
    this.opts.onUpdate?.(this.publicState(game.state), events);
    if (game.state.finished) {
      this.clearTimers(game);
      this.opts.onGameOver?.(game.state);
      // Late resumes are served from the database once the game leaves memory.
      setTimeout(() => this.games.delete(game.state.id), FINISHED_RETENTION_MS).unref();
    }
  }

  /**
   * Presence/controller change. The version is not bumped, so an opponent going offline
   * never invalidates the intent you are about to send. Timers are only reset when who
   * controls a seat changed, so presence changes never extend anyone's turn.
   */
  private touch(game: LiveGame, reschedule = true): void {
    if (reschedule) this.schedule(game);
    this.persist(game);
    this.opts.onUpdate?.(this.publicState(game.state));
  }

  /** `timeLeftMs`: the current player's time left, kept instead of a fresh full timer. */
  private schedule(game: LiveGame, timeLeftMs?: number): void {
    clearTimeout(game.timer);
    game.timer = undefined;
    const { state } = game;
    if (state.finished) return;
    // Clients are still animating the last change; nobody should act before they finish.
    const pace = this.animationMs(game.lastEvents) * tempoOf(state);
    game.lastEvents = [];
    const seat = state.seats[state.turn.seat];
    if (seat.controller !== 'human' || state.turn.auto) {
      state.turn.deadline = 0;
      const think = state.botBattle ? Math.min(this.botDelayMs, BOT_BATTLE_THINK_MS) : this.botDelayMs;
      game.timer = setTimeout(() => this.act(game, false), think + pace);
      return;
    }
    const timeoutMs = (timeLeftMs ?? this.opts.turnTimeoutSec * 1000) + pace;
    state.turn.deadline = Date.now() + timeoutMs;
    if (state.turn.phase === 'moving' && distinctChoices(legalMoves(state), state).length === 1) {
      game.timer = setTimeout(() => this.act(game, false), this.autoMoveDelayMs + pace);
      return;
    }
    game.timer = setTimeout(() => this.act(game, true), timeoutMs);
  }

  /** Roughly how long clients take to animate these events (mirrors screens/game.ts). */
  private animationMs(events: GameEvent[]): number {
    let ms = 0;
    for (const e of events) {
      if (e.type === 'roll') ms += 1200;
      else if (e.type === 'move') ms += moveMs(e.kills ?? 0, e.from === BASE ? BASE_EXIT_HOPS : e.die);
      else if (e.type === 'capture') ms += e.firstBlood ? 600 + FIRST_BLOOD_MS : 600;
      else if (e.type === 'penalty') ms += 1000;
      else if (e.type === 'noMoves') ms += 650;
      else if (e.type === 'bonus') ms += 500;
      else if (e.type === 'surrender') ms += SURRENDER_MS;
      else if (e.type === 'respawn') ms += WILDCARD_MS + WILDCARD_STAGGER_MS * (e.tokenIds.length - 1);
    }
    return ms * this.animScale;
  }

  /**
   * The server acts for the current seat: a bot, a forced single move, or a human whose
   * timer ran out. A missed timer auto-plays the rest of that turn; MAX_MISSED_TURNS missed
   * turns in a row hand the seat to a takeover bot.
   */
  private act(game: LiveGame, timedOut: boolean): void {
    const { state } = game;
    if (state.finished) return;
    const seat = state.seats[state.turn.seat];
    if (timedOut && seat.controller === 'human') {
      seat.timeouts++;
      if (seat.timeouts >= MAX_MISSED_TURNS) seat.controller = 'takeover';
      else state.turn.auto = true;
    }
    const seatBefore = state.turn.seat;
    let events: GameEvent[];
    if (state.turn.phase === 'rolling') {
      events = applyRoll(state, this.opts.dice());
    } else {
      const move = chooseMove(state);
      if (!move) return;
      events = applyMove(state, move.dieIndex, move.tokenId, move.lap === true);
    }
    this.commit(game, events, seatBefore);
  }

  private clearTimers(game: LiveGame): void {
    clearTimeout(game.timer);
    for (const t of game.graceTimers.values()) clearTimeout(t);
    game.graceTimers.clear();
  }

  private persist(game: LiveGame): void {
    const s = game.state;
    this.opts.db
      .prepare(
        `INSERT INTO games (id, lobby_id, state_json, version, updated_at, finished) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, version = excluded.version,
           updated_at = excluded.updated_at, finished = excluded.finished`,
      )
      .run(s.id, s.lobbyId, JSON.stringify(s), s.version, Date.now(), s.finished ? 1 : 0);
  }
}
