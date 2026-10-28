import type { Color, GameState, PlayerStats } from './types.js';

export type AwardKey = 'cells' | 'captures' | 'sixes' | 'revenges' | 'machoHome' | 'firstBlood';

export interface Award {
  key: AwardKey;
  icon: string;
  title: string;
  /** Everyone who shares the best score (ties all win it). */
  colors: Color[];
  value: number;
}

export const COUNTED: { key: Exclude<AwardKey, 'firstBlood'>; icon: string; title: string }[] = [
  { key: 'cells', icon: '👣', title: 'Most cells travelled' },
  { key: 'captures', icon: '⚔️', title: 'Most tokens captured' },
  { key: 'sixes', icon: '🎲', title: 'Most sixes' },
  { key: 'revenges', icon: '😤', title: 'Most revenges taken' },
  { key: 'machoHome', icon: '🥸', title: 'Most macho' },
];

export const EMPTY_STATS: PlayerStats = { cells: 0, captures: 0, sixes: 0, revenges: 0, machoHome: 0, firstBlood: false, owed: {} };

export function playerStats(state: GameState, color: Color): PlayerStats {
  const s = state.stats?.[color];
  return s ? { ...EMPTY_STATS, ...s } : EMPTY_STATS;
}

/**
 * The end-of-game awards: the best score in each stat (only if someone scored at all; ties are
 * shared) and first blood.
 */
export function gameAwards(state: GameState): Award[] {
  const colors = state.seats.map((s) => s.color);
  const awards: Award[] = [];
  for (const a of COUNTED) {
    const best = Math.max(0, ...colors.map((c) => playerStats(state, c)[a.key] ?? 0));
    if (best === 0) continue;
    awards.push({ ...a, value: best, colors: colors.filter((c) => (playerStats(state, c)[a.key] ?? 0) === best) });
  }
  const fb = colors.filter((c) => playerStats(state, c).firstBlood);
  if (fb.length) awards.push({ key: 'firstBlood', icon: '🩸', title: 'First blood', colors: fb, value: 1 });
  return awards;
}
