import { BASE, boardFor, boardOf, absoluteSquare, isSafeSquare, isSecondLap, type Board, type BoardSize } from './board.js';
import { moustacheLevel } from './heft.js';
import { countRoll } from './rolls.js';
import { TEAMMATE, type Color, type GameEvent, type GameState, type LegalMove, type PlayerStats, type Seat } from './types.js';

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
  /** Team-up: 2v2, diagonal partners. Needs all four seats of the 4-player board. */
  teams?: boolean;
  /** The 4- (default), 5- or 6-player board. */
  board?: BoardSize;
}): GameState {
  const { colors } = boardOf(opts.board);
  const seats = [...opts.seats]
    .sort((a, b) => colors.indexOf(a.color) - colors.indexOf(b.color))
    .map((s) => ({ ...s, timeouts: 0 }));
  if (seats.length < 2 || seats.length > colors.length) throw new RuleError('BAD_SEAT_COUNT');
  if (seats.some((s) => !colors.includes(s.color))) throw new RuleError('INVALID_COLOR');
  if (new Set(seats.map((s) => s.color)).size !== seats.length) throw new RuleError('DUPLICATE_COLOR');
  if (opts.teams && (seats.length !== 4 || colors.length !== 4)) throw new RuleError('TEAMS_NEED_FOUR');
  const tokens = { red: [], green: [], yellow: [], blue: [], purple: [], orange: [] } as Record<Color, number[]>;
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
    firstBlood: false,
    ...(opts.teams && { teams: true }),
    ...(opts.board && opts.board !== 4 && { board: opts.board }),
  };
}

/** Each token's captures since it last left base, created on first use (older saved games have none). */
export function killsOf(state: GameState, color: Color): number[] {
  state.kills ??= {};
  return (state.kills[color] ??= [0, 0, 0, 0]);
}

/** Each token's extra lap used so far (0 or 1), created on first use (older saved games have none). */
export function extraLapsOf(state: GameState, color: Color): number[] {
  state.extraLaps ??= {};
  return (state.extraLaps[color] ??= [0, 0, 0, 0]);
}

/** Whether this token still has its extra lap (to go round again, or for a wildcard entry). Doesn't change the state. */
export function hasExtraLap(state: GameState, color: Color, tokenId: number): boolean {
  return !state.extraLaps?.[color]?.[tokenId];
}

/** The player's match stats, created on first use (games saved before stats existed have none). */
export function statsOf(state: GameState, color: Color): PlayerStats {
  state.stats ??= {};
  return (state.stats[color] ??= { cells: 0, captures: 0, sixes: 0, revenges: 0, machoHome: 0, staches: 0, homeRuns: 0, risks: 0, friendlyFire: 0, firstBlood: false, owed: {} });
}

/** Team-up partners (never true in a classic game). */
export function isTeammate(state: Pick<GameState, 'teams'>, a: Color, b: Color): boolean {
  return Boolean(state.teams) && TEAMMATE[a] === b;
}

/** Who won: the first to finish, or in Team-up the first team with both partners home. Empty while playing. */
export function winnersOf(state: Pick<GameState, 'teams' | 'ranks'>): Color[] {
  const first = state.ranks[0];
  if (!first) return [];
  return state.teams ? [first, TEAMMATE[first]!] : [first];
}

export function currentColor(state: GameState): Color {
  return state.seats[state.turn.seat].color;
}

/** Finished (all home) or surrendered: no more turns. */
export function isPlayerDone(state: GameState, color: Color): boolean {
  return state.ranks.includes(color) || Boolean(state.surrendered?.includes(color));
}

/**
 * The last player still in takes the next place, then those who surrendered (the last to
 * give up ranks highest), and the game is over. In Team-up, `winner`'s team comes first and
 * the other team after it, each in the order: finished, still playing, surrendered.
 */
function endGame(state: GameState, events: GameEvent[], winner?: Color): void {
  if (state.teams && winner) {
    const surrendered = state.surrendered ?? [];
    const order = (team: Color[]) => [
      ...state.ranks.filter((c) => team.includes(c)),
      ...team.filter((c) => !state.ranks.includes(c) && !surrendered.includes(c)),
      ...surrendered.filter((c) => team.includes(c)),
    ];
    const winners = order([winner, TEAMMATE[winner]!]);
    state.ranks = [...winners, ...order(state.seats.map((s) => s.color).filter((c) => !winners.includes(c)))];
  } else {
    for (const s of state.seats.filter((x) => !isPlayerDone(state, x.color))) {
      state.ranks.push(s.color);
      events.push({ type: 'rank', color: s.color, rank: state.ranks.length });
    }
    for (const c of [...(state.surrendered ?? [])].reverse()) {
      state.ranks.push(c);
      events.push({ type: 'rank', color: c, rank: state.ranks.length });
    }
  }
  state.finished = true;
  state.turn.queue = [];
  state.turn.bonus = 0;
  events.push({ type: 'gameOver', ranks: [...state.ranks] });
}

/**
 * A player gives up, at any point of the game (not only on their turn). Their tokens that
 * aren't home go back to base, clean-shaven, and they take no more turns. If that leaves one
 * player, the game ends. In Team-up their team concedes: the other team wins at once.
 */
export function applySurrender(state: GameState, color: Color): GameEvent[] {
  if (state.finished) throw new RuleError('GAME_OVER');
  if (!state.seats.some((s) => s.color === color)) throw new RuleError('NOT_SEATED');
  if (isPlayerDone(state, color)) throw new RuleError('ALREADY_OUT');
  const { home } = boardFor(state);
  const events: GameEvent[] = [{ type: 'surrender', color, from: [...state.tokens[color]] }];
  state.surrendered = [...(state.surrendered ?? []), color];
  const kills = killsOf(state, color);
  state.tokens[color] = state.tokens[color].map((p, i) => {
    if (p === home) return p;
    kills[i] = 0;
    return BASE;
  });
  if (state.teams) {
    endGame(state, events, state.seats.find((s) => s.color !== color && s.color !== TEAMMATE[color])!.color);
    return events;
  }
  if (state.seats.filter((s) => !isPlayerDone(state, s.color)).length <= 1) {
    endGame(state, events);
    return events;
  }
  // Mid-turn: the turn passes on, whatever was rolled.
  if (currentColor(state) === color) endTurn(state, events);
  return events;
}

function allHome(state: GameState, color: Color): boolean {
  return state.tokens[color].every((p) => p === boardFor(state).home);
}

/**
 * Tokens this player may send from home back to base (a wildcard entry): home, with their extra
 * lap unused, while the game is on and they haven't surrendered. A finished player may too.
 */
export function respawnable(state: GameState, color: Color): number[] {
  if (state.finished || state.surrendered?.includes(color) || !state.seats.some((s) => s.color === color)) return [];
  const { home } = boardFor(state);
  return state.tokens[color].flatMap((p, i) => (p === home && hasExtraLap(state, color, i) ? [i] : []));
}

/**
 * A wildcard entry, at any time (it costs no turn): the tokens go from home back to base, keep
 * their moustaches, and need a 6 to come out again. It uses up each token's extra lap, so a
 * token does it at most once and can't go round again after it. A finished player who does
 * it gives up their place and plays on: all four must be home again to finish.
 */
export function applyRespawn(state: GameState, color: Color, tokenIds: number[]): GameEvent[] {
  if (state.finished) throw new RuleError('GAME_OVER');
  if (!state.seats.some((s) => s.color === color)) throw new RuleError('NOT_SEATED');
  if (state.surrendered?.includes(color)) throw new RuleError('SURRENDERED');
  const ids = [...new Set(tokenIds)];
  if (!ids.length || ids.length !== tokenIds.length || ids.some((i) => !Number.isInteger(i) || i < 0 || i >= TOKENS_PER_PLAYER)) throw new RuleError('BAD_TOKENS');
  if (ids.some((i) => state.tokens[color][i] !== boardFor(state).home)) throw new RuleError('NOT_HOME');
  if (ids.some((i) => !hasExtraLap(state, color, i))) throw new RuleError('NO_LAPS_LEFT');
  const laps = extraLapsOf(state, color);
  for (const i of ids) {
    state.tokens[color][i] = BASE;
    laps[i] = 1;
  }
  const mine = statsOf(state, color);
  mine.risks = (mine.risks ?? 0) + ids.length;
  const place = state.ranks.indexOf(color);
  if (place >= 0) state.ranks.splice(place, 1);
  return [{ type: 'respawn', color, tokenIds: ids.sort((a, b) => a - b), ...(place >= 0 && { unranked: place + 1 }) }];
}

/**
 * Where a token could end up with this die. Usually one place; a token about to turn into its
 * home column on its first lap may instead go round the board once more (`lap`), unless it has
 * used its extra lap already (`canLap` false).
 */
export function targetsFor(progress: number, die: number, canLap = true, b: Board = boardOf(4)): { to: number; lap?: true }[] {
  if (progress === BASE) return die === SIX ? [{ to: 0 }] : [];
  const t = progress + die;
  if (isSecondLap(progress, b)) {
    if (t <= b.lap2Last) return [{ to: t }];
    const column = t - b.lap2Last - 1 + b.last + 1; // past its last track square: into the home column
    return column <= b.home ? [{ to: column }] : [];
  }
  if (progress >= b.home) return [];
  if (canLap && progress <= b.last && t > b.last) return [{ to: t }, { to: t - b.last - 1 + b.lap2First, lap: true }];
  return t <= b.home ? [{ to: t }] : [];
}

/** Where a token would end up with the given die heading home, or null if it cannot move. */
export function targetProgress(progress: number, die: number, b: Board = boardOf(4)): number | null {
  return targetsFor(progress, die, true, b)[0]?.to ?? null;
}

function capturesAt(state: GameState, mover: Color, to: number): LegalMove['captures'] {
  const b = boardFor(state);
  const abs = absoluteSquare(mover, to, b);
  if (abs === null || isSafeSquare(abs, b)) return [];
  const captures: LegalMove['captures'] = [];
  for (const seat of state.seats) {
    if (seat.color === mover) continue;
    state.tokens[seat.color].forEach((p, tokenId) => {
      if (absoluteSquare(seat.color, p, b) === abs) captures.push({ color: seat.color, tokenId });
    });
  }
  return captures;
}

/** Every (die, token) pair the current player may play right now. Captures include a teammate's tokens: allowed, though rarely wise. */
export function legalMoves(state: GameState): LegalMove[] {
  if (state.finished || state.turn.phase !== 'moving') return [];
  const color = currentColor(state);
  const moves: LegalMove[] = [];
  state.turn.queue.forEach((die, dieIndex) => {
    state.tokens[color].forEach((from, tokenId) => {
      for (const { to, lap } of targetsFor(from, die, hasExtraLap(state, color, tokenId), boardFor(state))) {
        moves.push({ dieIndex, die, tokenId, from, to, captures: capturesAt(state, color, to), ...(lap && { lap }) });
      }
    });
  });
  return moves;
}

/**
 * Collapses moves that lead to the same outcome (same die value, tokens on the same square).
 * When only one remains the server can play it without asking. Tokens sharing a square but
 * with different moustaches (captures), or one with its extra lap used and one without, are
 * different choices: the player may want to send the clean-shaven one forward and keep the
 * macho one safe, so that is left to them.
 */
export function distinctChoices(moves: LegalMove[], state?: GameState): LegalMove[] {
  const color = state && currentColor(state);
  const kills = color ? state.kills?.[color] : undefined;
  const laps = color ? state.extraLaps?.[color] : undefined;
  const seen = new Map<string, LegalMove>();
  for (const m of moves) {
    const key = `${m.die}:${m.from}:${m.lap ? 'lap' : ''}:${kills?.[m.tokenId] ?? 0}:${laps?.[m.tokenId] ?? 0}`;
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
  const stats = statsOf(state, color);
  countRoll(stats, value);
  if (value === SIX) stats.sixes++;
  turn.queue.push(value);
  events.push({ type: 'roll', color, value, queue: [...turn.queue] });
  if (value === SIX) {
    // A six nobody can use (every token left is already in the home lane, where even the
    // first square + 6 overshoots) earns no extra roll: the turn is simply over.
    if (!state.tokens[color].some((p) => targetProgress(p, SIX, boardFor(state)) !== null)) {
      events.push({ type: 'noMoves', color, discarded: [...turn.queue] });
      turn.queue = [];
      endTurn(state, events);
      return events;
    }
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

/** `lap`: take the token round the board again instead of into its home column (when it may). */
export function applyMove(state: GameState, dieIndex: number, tokenId: number, lap = false): GameEvent[] {
  if (state.finished) throw new RuleError('GAME_OVER');
  if (state.turn.phase !== 'moving') throw new RuleError('WRONG_PHASE');
  const move = legalMoves(state).find((m) => m.dieIndex === dieIndex && m.tokenId === tokenId && Boolean(m.lap) === lap);
  if (!move) throw new RuleError('ILLEGAL_MOVE');
  const turn = state.turn;
  const color = currentColor(state);
  const events: GameEvent[] = [];

  state.tokens[color][tokenId] = move.to;
  turn.queue.splice(dieIndex, 1);
  const kills = killsOf(state, color);
  events.push({ type: 'move', color, tokenId, from: move.from, to: move.to, die: move.die, kills: kills[tokenId] });
  const mine = statsOf(state, color);
  mine.cells += move.from === BASE ? 1 : move.die; // leaving base counts as 1
  if (move.lap) {
    // Going round again is a risk, and it uses up the token's extra lap.
    extraLapsOf(state, color)[tokenId] = 1;
    mine.risks = (mine.risks ?? 0) + 1;
  }

  for (const c of move.captures) {
    const from = state.tokens[c.color][c.tokenId];
    // Caught on its second lap: it starts over from base like any captured token, extra lap back.
    if (isSecondLap(from, boardFor(state))) extraLapsOf(state, c.color)[c.tokenId] = 0;
    killsOf(state, c.color)[c.tokenId] = 0;
    if (isTeammate(state, color, c.color)) {
      // Friendly fire (Team-up): no bonus roll, and the capturer's moustache shrinks a level,
      // and it counts for "Backstabber" rather than as a capture (or first blood, or a revenge).
      kills[tokenId] = Math.max(0, moustacheLevel(kills[tokenId]) - 1);
      mine.friendlyFire = (mine.friendlyFire ?? 0) + 1;
      events.push({ type: 'capture', color, victim: c.color, tokenId: c.tokenId, from, friendly: true });
    } else {
      const firstBlood = !state.firstBlood;
      state.firstBlood = true;
      const theirs = statsOf(state, c.color);
      mine.captures++;
      // The capturer's moustache grows (a clean-shaven one grows its first, counted for "Baby face");
      // the captured token goes home clean-shaven.
      if (kills[tokenId] === 0) mine.staches = (mine.staches ?? 0) + 1;
      kills[tokenId]++;
      if (firstBlood) mine.firstBlood = true;
      // Paying back a capture they made on us is a revenge; this one is now theirs to avenge.
      if ((mine.owed[c.color] ?? 0) > 0) {
        mine.owed[c.color]!--;
        mine.revenges++;
      }
      theirs.owed[color] = (theirs.owed[color] ?? 0) + 1;
      events.push({ type: 'capture', color, victim: c.color, tokenId: c.tokenId, from, ...(firstBlood && { firstBlood: true as const }) });
      turn.bonus++;
    }
    state.tokens[c.color][c.tokenId] = BASE;
  }

  if (move.to === boardFor(state).home) {
    events.push({ type: 'home', color, tokenId });
    // Every arrival counts, so a token back from a wildcard entry that makes it home again counts twice.
    mine.homeRuns = (mine.homeRuns ?? 0) + 1;
    // A token with a moustache (at least one capture) made it home: that counts for "most macho".
    if (kills[tokenId] > 0) mine.machoHome = (mine.machoHome ?? 0) + 1;
    if (allHome(state, color)) {
      state.ranks.push(color);
      events.push({ type: 'rank', color, rank: state.ranks.length });
      // Team-up ends when both partners are home; a classic game when one player is left.
      if (state.teams ? state.ranks.includes(TEAMMATE[color]!) : state.seats.filter((s) => !isPlayerDone(state, s.color)).length <= 1) {
        endGame(state, events, color);
        return events;
      }
      turn.queue = [];
      turn.bonus = 0;
      endTurn(state, events);
      return events;
    }
    // Reaching home earns a bonus roll, like a capture (not for the last token: that player is done).
    turn.bonus++;
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
