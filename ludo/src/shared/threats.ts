import { LAST_TRACK, TRACK_LENGTH, absoluteSquare, isSafeSquare } from './board.js';
import type { Color, GameState } from './types.js';

/**
 * How close behind an opponent must be for a token to be "in danger": 1 to 5 squares, so an
 * ordinary roll could capture it (a 6 usually means more rolls first). Wider would be true
 * most of the game and the warning would stop meaning anything.
 */
export const THREAT_RANGE = 5;

/**
 * Tokens an opponent could capture with one roll: "color:tokenId" keys. Not on safe squares
 * (stars and start squares), not in a home column, and only if the opponent's own path really
 * passes that square (it would turn off into its home column first otherwise).
 */
export function threatenedTokens(state: Pick<GameState, 'seats' | 'tokens'>): Set<string> {
  const out = new Set<string>();
  const colors: Color[] = state.seats.map((s) => s.color);
  for (const color of colors) {
    state.tokens[color].forEach((p, tokenId) => {
      const abs = absoluteSquare(color, p);
      if (abs === null || isSafeSquare(abs)) return;
      const hunted = colors.some(
        (other) =>
          other !== color &&
          state.tokens[other].some((q) => {
            const from = absoluteSquare(other, q);
            if (from === null) return false;
            const gap = (abs - from + TRACK_LENGTH) % TRACK_LENGTH;
            return gap >= 1 && gap <= THREAT_RANGE && q + gap <= LAST_TRACK;
          }),
      );
      if (hunted) out.add(`${color}:${tokenId}`);
    });
  }
  return out;
}
