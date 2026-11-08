import type { Power } from '../shared/types.js';

/**
 * How each power ups power is named and shown: the power-up on its star, the badge on the token
 * that has it, and the banner when a token takes it. `what`: what it does, said to its owner
 * ("Your token …"); `theirs`: the same, said to everyone else about another player's token.
 */
export const POWER_INFO: Record<Power, { icon: string; name: string; what: string; theirs: (name: string) => string }> = {
  double: {
    icon: '2×',
    name: 'Double move',
    what: 'moves twice as far (as rolled when twice would overshoot)',
    theirs: (name) => `${name}'s token moves twice as far`,
  },
  shield: {
    icon: '🛡️',
    name: 'Shield',
    what: 'survives the first capture (not a vampire): the shield breaks instead',
    theirs: (name) => `${name}'s token survives the first capture (a vampire's still counts)`,
  },
  cloak: {
    icon: '👻',
    name: 'Invisibility cloak',
    what: 'is invisible to everyone else; landing on it still captures it',
    theirs: (name) => `${name}'s token has vanished; landing on it still captures it`,
  },
  vampire: {
    icon: '🧛',
    name: 'Vampire',
    what: "can raid other players' home columns and capture there, and captures shielded tokens too",
    theirs: (name) => `${name}'s token can raid home columns and goes through shields`,
  },
};

export const GOLDEN_INFO = { icon: '👑', name: 'Golden token', what: 'leaves base on any roll, and a capture sends it to its start square' };
