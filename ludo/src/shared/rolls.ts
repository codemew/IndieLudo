import type { Color, GameState, PlayerStats } from './types.js';

/** How many times a player rolled each face, index 0 = a 1 … index 5 = a 6. */
export const NO_ROLLS: readonly number[] = [0, 0, 0, 0, 0, 0];

/** Counts one roll (any roll, including a six lost to the three-sixes penalty). */
export function countRoll(stats: PlayerStats, value: number): void {
  const rolls = (stats.rolls ??= [0, 0, 0, 0, 0, 0]);
  rolls[value - 1]++;
}

/** A player's roll counts; all zeros for a game saved before they were counted. */
export function rollCounts(state: Pick<GameState, 'stats'>, color: Color): number[] {
  const rolls = state.stats?.[color]?.rolls;
  return NO_ROLLS.map((_, i) => rolls?.[i] ?? 0);
}

/**
 * The share of each face in a player's rolls, in whole percent that add up to exactly 100
 * (largest remainder: plain rounding can give 99 or 101). All zeros when nothing was rolled.
 */
export function rollShares(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left-- <= 0) break;
    shares[i]++;
  }
  return shares;
}
