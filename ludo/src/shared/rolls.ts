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

/** Fewer rolls than this say nothing about the dice: nothing is called unusual. */
export const MIN_ROLLS_FOR_LUCK = 20;

/**
 * How many standard deviations from a sixth a face's count must be before it is marked. A results
 * screen tests 6 faces for each of up to 6 players at once, so the bar has to be high: at 2 SD a
 * fair game showed a mark more often than not (54–72% of simulated games); at 3.3 SD it is 3–5% of games.
 */
export const UNUSUAL_SD = 3.3;

/**
 * Which faces came up more or less often than a fair die almost ever does with this many rolls
 * (see UNUSUAL_SD). A player rolls only a few dozen times a game, so a lopsided row is normal and
 * only the rare cell beyond that is worth a look.
 */
export function rollOutliers(counts: readonly number[]): ('high' | 'low' | null)[] {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n < MIN_ROLLS_FOR_LUCK) return counts.map(() => null);
  const expected = n / 6;
  const margin = UNUSUAL_SD * Math.sqrt((n * 5) / 36);
  return counts.map((c) => (c > expected + margin ? 'high' : c < expected - margin ? 'low' : null));
}

/** The shares (in whole percent) a fair die stays within with `n` rolls before a cell is marked: a sixth ± UNUSUAL_SD standard deviations. */
export function normalRange(n: number): [number, number] {
  const sd = Math.sqrt(5 / 36 / n) * 100;
  return [Math.max(0, Math.round(100 / 6 - UNUSUAL_SD * sd)), Math.min(100, Math.round(100 / 6 + UNUSUAL_SD * sd))];
}
