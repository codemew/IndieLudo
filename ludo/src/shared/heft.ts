/**
 * The moustache and the weight a token gains from its captures (approved on the review page):
 * each capture grows its moustache a level, up to 4, and makes it hop more slowly and heavily.
 * The server uses the same numbers to wait out the slower moves before bots and timers act.
 */
export const MAX_MOUSTACHE = 4;
/** How much slower each hop is, by the moving token's kills: noticeable at 1, very heavy at 4. */
export const KILL_SLOWDOWN = [1, 1.35, 1.8, 2.5, 3.5] as const;
/** One square's hop for a token with no kills. */
export const HOP_MS = 170;
/** Leaving base is one longer jump. */
export const BASE_EXIT_HOPS = 1.5;

export const moustacheLevel = (kills: number): number => Math.max(0, Math.min(MAX_MOUSTACHE, Math.floor(kills)));
export const hopMs = (kills: number): number => HOP_MS * KILL_SLOWDOWN[moustacheLevel(kills)];
/** The jiggle after a heavy token lands for the last time. */
export const settleMs = (kills: number): number => (moustacheLevel(kills) ? 380 + 110 * moustacheLevel(kills) : 0);
/** A whole move on screen: every hop plus the final jiggle. */
export const moveMs = (kills: number, hops: number): number => hops * hopMs(kills) + settleMs(kills);
