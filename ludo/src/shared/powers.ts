import { BASE, HIDDEN, absoluteSquare, boardFor } from './board.js';
import { POWERS, TEAMMATE, type Color, type GameEvent, type GameState, type LegalMove, type Power } from './types.js';

/**
 * Power ups and the golden token: the state helpers the rules engine uses, the orb shuffles, and
 * what each phone may see of a game with cloaked tokens.
 */

/**
 * The next number in [0, 1) from the game's own seed (mulberry32), which moves on. The rules stay
 * free of real randomness: the server seeds each game once, and keeps the seed to itself.
 */
export function nextRandom(state: GameState): number {
  let t = ((state.orbSeed ?? 1) + 0x6d2b79f5) >>> 0;
  state.orbSeed = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(state: GameState, list: readonly T[]): T {
  return list[Math.floor(nextRandom(state) * list.length)];
}

/** An orb on every star, each power once in shuffled order (a 5- or 6-player board adds random ones). */
export function initialOrbs(state: GameState): { square: number; power: Power }[] {
  const stars = [...boardFor(state).stars].sort((a, b) => a - b);
  const deck: Power[] = [...POWERS];
  while (deck.length < stars.length) deck.push(pick(state, POWERS));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return stars.map((square, i) => ({ square, power: deck[i] }));
}

export function powerOf(state: Pick<GameState, 'powers'>, color: Color, tokenId: number): Power | null {
  return state.powers?.[color]?.[tokenId] ?? null;
}

/** A player's tokens' powers, created on first use. */
export function powersOf(state: GameState, color: Color): (Power | null)[] {
  state.powers ??= {};
  return (state.powers[color] ??= [null, null, null, null]);
}

export function isGolden(state: Pick<GameState, 'golden'>, color: Color, tokenId: number): boolean {
  return state.golden?.[color] === tokenId;
}

/** The orb on the square a move ends on, if any (only on the shared track). */
export function orbAt(state: GameState, color: Color, to: number): Power | null {
  if (!state.orbs?.length) return null;
  const abs = absoluteSquare(color, to, boardFor(state));
  return abs === null ? null : (state.orbs.find((o) => o.square === abs)?.power ?? null);
}

/** Turns until a taken orb comes back: a round of play. */
export function orbRespawnTurns(state: GameState): number {
  return state.seats.length;
}

/**
 * On each turn change: taken orbs count down, and the ones due come back on a random star without
 * one, with a random power. Tokens on the star don't matter (it would give away where a cloaked one
 * is); a token already there takes the orb only by landing on it again.
 */
export function tickOrbs(state: GameState, events: GameEvent[]): void {
  if (!state.powerUps || !state.orbsDue?.length) return;
  state.orbsDue = state.orbsDue.map((t) => Math.max(0, t - 1));
  const b = boardFor(state);
  while (state.orbsDue.includes(0)) {
    const busy = new Set((state.orbs ?? []).map((o) => o.square));
    const free = [...b.stars].filter((s) => !busy.has(s)).sort((x, y) => x - y);
    if (!free.length) return;
    state.orbsDue.splice(state.orbsDue.indexOf(0), 1);
    const orb = { square: pick(state, free), power: pick(state, POWERS) };
    (state.orbs ??= []).push(orb);
    events.push({ type: 'orb', ...orb });
  }
}

/** Whose cloaked tokens a viewer sees: their own and, in Team-up, their partner's. Spectators see none. */
export function seesCloaked(state: Pick<GameState, 'teams'>, viewer: Color | null, color: Color): boolean {
  return viewer !== null && (viewer === color || (Boolean(state.teams) && TEAMMATE[viewer] === color));
}

/** A cloaked token on the board that this viewer may not see. Nothing is hidden once the game is over. */
export function hiddenFrom(state: GameState, viewer: Color | null, color: Color, tokenId: number): boolean {
  if (state.finished || powerOf(state, color, tokenId) !== 'cloak' || seesCloaked(state, viewer, color)) return false;
  const p = state.tokens[color][tokenId];
  return p !== BASE && p !== boardFor(state).home;
}

/**
 * The game as one phone may see it: the orb seed left out, and opponents' cloaked tokens moved to
 * HIDDEN, along with every legal move of theirs and every capture of them a move would make.
 * `viewer`: the colour of the player looking, or null for someone watching.
 */
export function viewFor<T extends GameState & { legalMoves?: LegalMove[] }>(state: T, viewer: Color | null): T {
  if (!state.powerUps) return state;
  const { orbSeed: _seed, ...rest } = state;
  const out = rest as T;
  const hidden = new Set<string>();
  for (const seat of state.seats) state.tokens[seat.color].forEach((_p, id) => hiddenFrom(state, viewer, seat.color, id) && hidden.add(`${seat.color}:${id}`));
  if (!hidden.size) return out;
  out.tokens = Object.fromEntries(
    Object.entries(state.tokens).map(([c, ps]) => [c, ps.map((p, id) => (hidden.has(`${c}:${id}`) ? HIDDEN : p))]),
  ) as GameState['tokens'];
  if (state.legalMoves) {
    const actor = state.seats[state.turn.seat].color;
    const seen = (t: { color: Color; tokenId: number }) => !hidden.has(`${t.color}:${t.tokenId}`);
    out.legalMoves = state.legalMoves
      .filter((m) => seen({ color: m.color ?? actor, tokenId: m.tokenId }))
      .map((m) => ({ ...m, captures: m.captures.filter(seen), ...(m.breaks && { breaks: m.breaks.filter(seen) }) }));
  }
  return out;
}

/** The events one phone gets: a cloaked token's moves only reach those who can see it. */
export function eventsFor(state: Pick<GameState, 'teams'>, events: GameEvent[], viewer: Color | null): GameEvent[] {
  return events.filter((e) => e.type !== 'move' || !e.cloaked || seesCloaked(state, viewer, e.color));
}
