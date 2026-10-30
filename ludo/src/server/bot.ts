import { BASE, HOME, LAST_TRACK, absoluteSquare, isSafeSquare, isSecondLap, onTrack } from '../shared/board.js';
import { currentColor, isTeammate, legalMoves } from '../shared/rules.js';
import type { Color, GameState, LegalMove } from '../shared/types.js';

/** True if an opponent token sits 1..6 squares behind the given absolute square (a teammate is no threat). */
function threatened(state: GameState, me: Color, abs: number): boolean {
  if (isSafeSquare(abs)) return false;
  for (const seat of state.seats) {
    if (seat.color === me || isTeammate(state, me, seat.color)) continue;
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
  // Capturing a teammate (Team-up) is a last resort: only when no other move is legal.
  let s = m.captures.reduce((n, c) => n + (isTeammate(state, me, c.color) ? -1000 : 100), 0);
  if (m.to === HOME) s += 80;
  if (m.from === BASE) s += 60;
  if (onTrack(m.from) && m.to > LAST_TRACK && m.to < HOME) s += 40;
  // Going round again only to capture someone; otherwise head home.
  if (m.lap) s -= 50;
  const fromAbs = absoluteSquare(me, m.from);
  const toAbs = absoluteSquare(me, m.to);
  if (toAbs !== null) {
    if (isSafeSquare(toAbs)) s += 30;
    else if (threatened(state, me, toAbs)) s -= 25;
  }
  if (fromAbs !== null && threatened(state, me, fromAbs) && (toAbs === null || !threatened(state, me, toAbs))) s += 20;
  // Prefer moving tokens further along (a second-lap token counts as one lap further).
  const along = m.to === HOME ? 56 : isSecondLap(m.to) ? m.to - 6 : m.to;
  // Between tokens on the same square, move the one with the smaller moustache: the macho one
  // stays put, and a clean-shaven one that captures grows a moustache of its own.
  const kills = state.kills?.[me]?.[m.tokenId] ?? 0;
  return s + along / 10 - kills / 1000;
}

/** Simple heuristic: capture > finish > leave base > reach safety > advance; never a teammate unless forced. */
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
