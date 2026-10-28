/**
 * The faces a token pulls for a moment: on a star (safe), after capturing (yum), while being
 * sent home (ouch), and when an opponent gets right behind it (flee). Each has its own
 * animation in styles.css (.tok-emoji.r-<anim>).
 */
export type ReactionKind = 'safe' | 'yum' | 'ouch' | 'flee';

/** How long a reaction plays; keep in step with .tok-emoji in styles.css. */
export const REACTION_MS = 1785;

export interface Reaction {
  face: string;
  anim: string;
}

export const REACTIONS: Record<ReactionKind, readonly Reaction[]> = {
  safe: [
    { face: '😌', anim: 'sigh' }, // relieved: a happy little sway
    { face: '😎', anim: 'shades' }, // cool: drops in, a slow nod
    { face: '🥳', anim: 'party' }, // spins in and wiggles
    { face: '😇', anim: 'halo' }, // floats up, glowing
  ],
  yum: [
    { face: '😋', anim: 'chew' }, // chews and licks its lips
    { face: '🤤', anim: 'drool' }, // a slow, satisfied wobble
    { face: '😈', anim: 'devil' }, // grows and shakes with glee
    { face: '😏', anim: 'smug' }, // tilts its head, very pleased
  ],
  ouch: [
    { face: '😵', anim: 'dizzy' }, // spins all the way home
    { face: '😭', anim: 'sob' }, // sobs
    { face: '😱', anim: 'scream' }, // jumps and trembles
    { face: '😖', anim: 'squash' }, // squashed flat, then springs back
  ],
  flee: [
    { face: '🏃', anim: 'sprint' }, // runs on the spot, legs going
    { face: '😰', anim: 'sweat' }, // nervous little shakes
    { face: '🥶', anim: 'shiver' }, // frozen with fear: shivers
  ],
};

/** A random reaction of that kind, never the same one twice in a row. */
export function pickReaction(kind: ReactionKind, last: string | undefined, rand: () => number = Math.random): Reaction {
  const options = REACTIONS[kind].filter((r) => r.anim !== last);
  return options[Math.floor(rand() * options.length)] ?? REACTIONS[kind][0];
}
