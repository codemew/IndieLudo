import type { Color, GameState, PlayerStats } from './types.js';

export type AwardKey = 'cells' | 'captures' | 'sixes' | 'revenges' | 'machoHome' | 'risks' | 'friendlyFire' | 'babyFace' | 'firstBlood';

export interface Award {
  key: AwardKey;
  icon: string;
  title: string;
  /** Everyone who shares the best score (ties all win it). */
  colors: Color[];
  value: number;
}

export const COUNTED: { key: Exclude<AwardKey, 'firstBlood' | 'babyFace'>; icon: string; title: string }[] = [
  { key: 'cells', icon: '👣', title: 'Most cells travelled' },
  { key: 'captures', icon: '⚔️', title: 'Most tokens captured' },
  { key: 'sixes', icon: '🎲', title: 'Most sixes' },
  { key: 'revenges', icon: '😤', title: 'Most revenges taken' },
  { key: 'machoHome', icon: '🥸', title: 'Most macho' },
  // Shown as a steel ball on the results screen (there is no emoji for one); 🔘 is the fallback.
  { key: 'risks', icon: '🔘', title: 'Balls of steel' },
  { key: 'friendlyFire', icon: '🗡️', title: 'Et tu, Brute?' },
];

export const EMPTY_STATS: PlayerStats = { cells: 0, captures: 0, sixes: 0, revenges: 0, machoHome: 0, staches: 0, homeRuns: 0, risks: 0, friendlyFire: 0, firstBlood: false, owed: {} };

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
  // The comedy trophy, the other way round: the fewest tokens that grew a moustache. Only when
  // there's a difference to laugh at (somebody else grew more), so it's never everyone's.
  const staches = colors.map((c) => playerStats(state, c).staches ?? 0);
  const fewest = Math.min(...staches);
  if (Math.max(...staches) > fewest) {
    awards.push({ key: 'babyFace', icon: '👶', title: 'Baby face', value: fewest, colors: colors.filter((_, i) => staches[i] === fewest) });
  }
  const fb = colors.filter((c) => playerStats(state, c).firstBlood);
  if (fb.length) awards.push({ key: 'firstBlood', icon: '🩸', title: 'First blood', colors: fb, value: 1 });
  return awards;
}
