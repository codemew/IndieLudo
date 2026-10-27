import crypto from 'node:crypto';

export type DiceFn = () => number;

/**
 * Server-side die roll. crypto.randomInt draws from the OS CSPRNG and uses rejection
 * sampling, so every face is exactly equally likely. Clients never generate rolls.
 */
export const cryptoDice: DiceFn = () => crypto.randomInt(1, 7);
