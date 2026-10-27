import { BASE, HOME, LAST_TRACK, absoluteSquare, isSafeSquare } from '../shared/board.js';
import { currentColor, legalMoves } from '../shared/rules.js';
import type { Color, GameState, LegalMove } from '../shared/types.js';

/** True if an opponent token sits 1..6 squares behind the given absolute square. */
function threatened(state: GameState, me: Color, abs: number): boolean {
  if (isSafeSquare(abs)) return false;
  for (const seat of state.seats) {
    if (seat.color === me) continue;
    for (const p of state.tokens[seat.color]) {
      const theirs = absoluteSquare(seat.color, p);
      if (theirs === null) continue;
      const gap = (abs - theirs + 52) % 52;
      if (gap >= 1 && gap <= 6) return true;
    }
  }
  return false;
}

function score(state: GameState, me: Color, m: LegalMove): number {
  let s = m.captures.length * 100;
  if (m.to === HOME) s += 80;
  if (m.from === BASE) s += 60;
  if (m.from <= LAST_TRACK && m.to > LAST_TRACK && m.to < HOME) s += 40;
  const fromAbs = absoluteSquare(me, m.from);
  const toAbs = absoluteSquare(me, m.to);
  if (toAbs !== null) {
    if (isSafeSquare(toAbs)) s += 30;
    else if (threatened(state, me, toAbs)) s -= 25;
  }
  if (fromAbs !== null && threatened(state, me, fromAbs) && (toAbs === null || !threatened(state, me, toAbs))) s += 20;
  return s + m.to / 10;
}

/** Simple heuristic: capture > finish > leave base > reach safety > advance. */
export function chooseMove(state: GameState): LegalMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  const me = currentColor(state);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = score(state, me, m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}
