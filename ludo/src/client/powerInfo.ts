import type { Power } from '../shared/types.js';

/** How each power ups power is named and shown: the orb on its star, and the badge on the token that has it. */
export const POWER_INFO: Record<Power, { icon: string; name: string; what: string }> = {
  double: { icon: '2×', name: 'Double move', what: 'moves twice as far (as rolled when twice would overshoot)' },
  shield: { icon: '🛡️', name: 'Shield', what: 'the first capture fails and breaks the shield' },
  cloak: { icon: '👻', name: 'Invisibility cloak', what: 'only you can see it; landing on it still captures it' },
  vampire: { icon: '🧛', name: 'Vampire', what: "can raid another player's home column and capture there, and comes out at their start" },
};

export const GOLDEN_INFO = { icon: '👑', name: 'Golden token', what: 'leaves base on any roll, and a capture sends it to its start square' };
