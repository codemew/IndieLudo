import { BASE, absoluteSquare, boardFor, isSafeSquare, isSecondLap, onTrack, raidOf } from '../shared/board.js';
import { powerOf, viewFor } from '../shared/powers.js';
import { currentColor, isTeammate, legalMoves } from '../shared/rules.js';
import type { Color, GameState, LegalMove, Power } from '../shared/types.js';

/** How much a bot wants each power (power ups). */
const POWER_WANT: Record<Power, number> = { double: 30, shield: 25, cloak: 25, vampire: 20 };

/** True if an opponent token sits 1..6 squares behind the given absolute square (a teammate is no threat). */
function threatened(state: GameState, me: Color, abs: number): boolean {
  const b = boardFor(state);
  if (isSafeSquare(abs, b)) return false;
  for (const seat of state.seats) {
    if (seat.color === me || isTeammate(state, me, seat.color)) continue;
    for (const p of state.tokens[seat.color]) {
      const theirs = absoluteSquare(seat.color, p, b);
      if (theirs === null) continue;
      const gap = (abs - theirs + b.trackLength) % b.trackLength;
      if (gap >= 1 && gap <= 6) return true;
    }
  }
  return false;
}

function score(state: GameState, actor: Color, m: LegalMove): number {
  const b = boardFor(state);
  // The token's own colour: the player's, or with turn sharing their partner's.
  const me = m.color ?? actor;
  // Capturing a teammate (Team-up) is a last resort: only when no other move is legal.
  let s = m.captures.reduce((n, c) => n + (isTeammate(state, me, c.color) ? -1000 : 100), 0);
  if (m.to === b.home) s += 80;
  if (m.from === BASE) s += 60;
  if (onTrack(m.from, b) && m.to > b.last && m.to < b.home) s += 40;
  // Going round again only to capture someone; otherwise head home.
  if (m.lap) s -= 50;
  // Power ups: a vampire raids a home column for the captures there (counted above), not for the detour.
  if (m.raid) s -= 30;
  if (m.orb) s += POWER_WANT[m.orb];
  s += (m.breaks?.length ?? 0) * 15;
  // A shielded token can afford to stand in harm's way.
  const shielded = powerOf(state, me, m.tokenId) === 'shield';
  const fromAbs = absoluteSquare(me, m.from, b);
  const toAbs = absoluteSquare(me, m.to, b);
  if (toAbs !== null) {
    if (isSafeSquare(toAbs, b)) s += 30;
    else if (threatened(state, me, toAbs)) s -= shielded ? 8 : 25;
  }
  if (fromAbs !== null && threatened(state, me, fromAbs) && (toAbs === null || !threatened(state, me, toAbs))) s += shielded ? 6 : 20;
  // Prefer moving tokens further along (a second-lap token counts as one lap further; a raiding vampire stays where it was).
  const along = m.to === b.home ? b.home : raidOf(m.to) ? Math.max(m.from, 0) : isSecondLap(m.to, b) ? m.to - 6 : m.to;
  // Between tokens on the same square, move the one with the smaller moustache: the macho one
  // stays put, and a clean-shaven one that captures grows a moustache of its own.
  const kills = state.kills?.[me]?.[m.tokenId] ?? 0;
  return s + along / 10 - kills / 1000;
}

/**
 * Simple heuristic: capture > finish > leave base > reach safety > advance; never a teammate unless
 * forced. It plays fair with power ups: it judges the board as its player sees it, so opponents'
 * cloaked tokens neither scare it nor tempt it (landing on one still captures it).
 */
export function chooseMove(state: GameState): LegalMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  const me = currentColor(state);
  // Its own and its partner's moves are all in the view, in the same order.
  const seen = viewFor({ ...state, legalMoves: moves }, me);
  let best = 0;
  let bestScore = -Infinity;
  seen.legalMoves.forEach((m, i) => {
    const s = score(seen, me, m);
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  });
  return moves[best];
}
