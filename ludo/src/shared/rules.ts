import { BASE, HOME, LAST_TRACK, absoluteSquare, isSafeSquare } from './board.js';
import { COLORS, type Color, type GameEvent, type GameState, type LegalMove, type Seat } from './types.js';

/**
 * Pure Ludo rules engine. Functions mutate the given state in place and return
 * the events that happened, so callers can persist the state and animate the events.
 * Nothing in here does IO or generates randomness.
 */

export class RuleError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const TOKENS_PER_PLAYER = 4;
const SIX = 6;
const MAX_SIXES = 3;

export function createGameState(opts: {
  id: string;
  lobbyId: string;
  seats: Omit<Seat, 'timeouts'>[];
  firstSeat?: number;
  now?: number;
}): GameState {
  const seats = [...opts.seats]
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
    .map((s) => ({ ...s, timeouts: 0 }));
  if (seats.length < 2 || seats.length > 4) throw new RuleError('BAD_SEAT_COUNT');
  if (new Set(seats.map((s) => s.color)).size !== seats.length) throw new RuleError('DUPLICATE_COLOR');
  const tokens = { red: [], green: [], yellow: [], blue: [] } as Record<Color, number[]>;
  for (const s of seats) tokens[s.color] = Array(TOKENS_PER_PLAYER).fill(BASE);
  return {
    id: opts.id,
    lobbyId: opts.lobbyId,
    version: 1,
    seats,
    tokens,
    turn: { seat: (opts.firstSeat ?? 0) % seats.length, phase: 'rolling', queue: [], sixes: 0, bonus: 0, deadline: 0, auto: false },
    ranks: [],
    finished: false,
    createdAt: opts.now ?? Date.now(),
  };
}

export function currentColor(state: GameState): Color {
  return state.seats[state.turn.seat].color;
}

export function isPlayerDone(state: GameState, color: Color): boolean {
  return state.ranks.includes(color);
}

function allHome(state: GameState, color: Color): boolean {
  return state.tokens[color].every((p) => p === HOME);
}

/** Where a token would end up with the given die, or null if it cannot move. */
export function targetProgress(progress: number, die: number): number | null {
  if (progress === BASE) return die === SIX ? 0 : null;
  if (progress >= HOME) return null;
  const to = progress + die;
  return to <= HOME ? to : null;
}

function capturesAt(state: GameState, mover: Color, to: number): LegalMove['captures'] {
  const abs = absoluteSquare(mover, to);
  if (abs === null || isSafeSquare(abs)) return [];
  const captures: LegalMove['captures'] = [];
  for (const seat of state.seats) {
    if (seat.color === mover) continue;
    state.tokens[seat.color].forEach((p, tokenId) => {
      if (absoluteSquare(seat.color, p) === abs) captures.push({ color: seat.color, tokenId });
    });
  }
  return captures;
}

/** Every (die, token) pair the current player may play right now. */
export function legalMoves(state: GameState): LegalMove[] {
  if (state.finished || state.turn.phase !== 'moving') return [];
  const color = currentColor(state);
  const moves: LegalMove[] = [];
  state.turn.queue.forEach((die, dieIndex) => {
    state.tokens[color].forEach((from, tokenId) => {
      const to = targetProgress(from, die);
      if (to === null) return;
      moves.push({ dieIndex, die, tokenId, from, to, captures: capturesAt(state, color, to) });
    });
  });
  return moves;
}

/**
 * Collapses moves that lead to the same outcome (same die value, tokens on the same
 * square). When only one remains the server can play it without asking.
 */
export function distinctChoices(moves: LegalMove[]): LegalMove[] {
  const seen = new Map<string, LegalMove>();
  for (const m of moves) {
    const key = `${m.die}:${m.from}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

export function applyRoll(state: GameState, value: number): GameEvent[] {
  if (state.finished) throw new RuleError('GAME_OVER');
  if (state.turn.phase !== 'rolling') throw new RuleError('WRONG_PHASE');
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new RuleError('BAD_DIE');
  const turn = state.turn;
  const color = currentColor(state);
  const events: GameEvent[] = [];
  turn.queue.push(value);
  events.push({ type: 'roll', color, value, queue: [...turn.queue] });
  if (value === SIX) {
    turn.sixes++;
    if (turn.sixes >= MAX_SIXES) {
      // Nothing has moved during the rolling phase, so nullifying the turn is just dropping the queue.
      events.push({ type: 'penalty', color, queue: [...turn.queue] });
      turn.queue = [];
      turn.bonus = 0;
      endTurn(state, events);
    }
    return events;
  }
  turn.phase = 'moving';
  evaluateForfeit(state, events);
  return events;
}

export function applyMove(state: GameState, dieIndex: number, tokenId: number): GameEvent[] {
  if (state.finished) throw new RuleError('GAME_OVER');
  if (state.turn.phase !== 'moving') throw new RuleError('WRONG_PHASE');
  const move = legalMoves(state).find((m) => m.dieIndex === dieIndex && m.tokenId === tokenId);
  if (!move) throw new RuleError('ILLEGAL_MOVE');
  const turn = state.turn;
  const color = currentColor(state);
  const events: GameEvent[] = [];

  state.tokens[color][tokenId] = move.to;
  turn.queue.splice(dieIndex, 1);
  events.push({ type: 'move', color, tokenId, from: move.from, to: move.to, die: move.die });

  for (const c of move.captures) {
    events.push({ type: 'capture', color, victim: c.color, tokenId: c.tokenId, from: state.tokens[c.color][c.tokenId] });
    state.tokens[c.color][c.tokenId] = BASE;
    turn.bonus++;
  }

  if (move.to === HOME) {
    events.push({ type: 'home', color, tokenId });
    if (allHome(state, color)) {
      state.ranks.push(color);
      events.push({ type: 'rank', color, rank: state.ranks.length });
      const remaining = state.seats.filter((s) => !isPlayerDone(state, s.color));
      if (remaining.length <= 1) {
        for (const s of remaining) {
          state.ranks.push(s.color);
          events.push({ type: 'rank', color: s.color, rank: state.ranks.length });
        }
        state.finished = true;
        turn.queue = [];
        turn.bonus = 0;
        events.push({ type: 'gameOver', ranks: [...state.ranks] });
        return events;
      }
      turn.queue = [];
      turn.bonus = 0;
      endTurn(state, events);
      return events;
    }
  }

  evaluateForfeit(state, events);
  return events;
}

/**
 * Ends the turn when the queue is spent or none of the remaining dice can move.
 * Dice are only discarded together: one die can become playable after another is used
 * (a 3 waiting on a 6 to bring a token out of base).
 */
function evaluateForfeit(state: GameState, events: GameEvent[]): void {
  const turn = state.turn;
  if (turn.queue.length === 0) {
    endTurn(state, events);
    return;
  }
  if (legalMoves(state).length === 0) {
    events.push({ type: 'noMoves', color: currentColor(state), discarded: [...turn.queue] });
    turn.queue = [];
    endTurn(state, events);
  }
}

function endTurn(state: GameState, events: GameEvent[]): void {
  const turn = state.turn;
  const color = currentColor(state);
  turn.queue = [];
  turn.sixes = 0;
  turn.phase = 'rolling';
  if (turn.bonus > 0 && !isPlayerDone(state, color)) {
    turn.bonus--;
    events.push({ type: 'bonus', color });
    return;
  }
  turn.bonus = 0;
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const next = (turn.seat + i) % n;
    if (!isPlayerDone(state, state.seats[next].color)) {
      turn.seat = next;
      events.push({ type: 'turn', color: state.seats[next].color });
      return;
    }
  }
}
