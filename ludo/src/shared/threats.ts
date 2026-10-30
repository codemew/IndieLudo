import { absoluteSquare, boardFor, isSafeSquare, isSecondLap } from './board.js';
import { TEAMMATE, type Color, type GameState } from './types.js';

/**
 * How close behind an opponent must be for a token to be "in danger": 1 to 5 squares, so an
 * ordinary roll could capture it (a 6 usually means more rolls first). Wider would be true
 * most of the game and the warning would stop meaning anything.
 */
export const THREAT_RANGE = 5;

/**
 * Tokens an opponent could capture with one roll: "color:tokenId" keys. Not on safe squares
 * (stars and start squares), not in a home column, and only if the opponent's own path can pass
 * that square: on its first lap it can go round again instead of turning home, while on its
 * second lap (or with its extra lap used by a wildcard entry) it turns home after its last
 * track square. In Team-up a teammate is no threat: partners don't hunt each other.
 */
export function threatenedTokens(state: Pick<GameState, 'seats' | 'tokens' | 'extraLaps' | 'teams' | 'board'>): Set<string> {
  const b = boardFor(state);
  const out = new Set<string>();
  const colors: Color[] = state.seats.map((s) => s.color);
  for (const color of colors) {
    state.tokens[color].forEach((p, tokenId) => {
      const abs = absoluteSquare(color, p, b);
      if (abs === null || isSafeSquare(abs, b)) return;
      const hunted = colors.some(
        (other) =>
          other !== color &&
          !(state.teams && TEAMMATE[other] === color) &&
          state.tokens[other].some((q, id) => {
            const from = absoluteSquare(other, q, b);
            if (from === null) return false;
            const gap = (abs - from + b.trackLength) % b.trackLength;
            if (gap < 1 || gap > THREAT_RANGE) return false;
            if (isSecondLap(q, b)) return q + gap <= b.lap2Last;
            // A token with no extra lap left turns home after its last track square.
            return !state.extraLaps?.[other]?.[id] || q + gap <= b.last;
          }),
      );
      if (hunted) out.add(`${color}:${tokenId}`);
    });
  }
  return out;
}
