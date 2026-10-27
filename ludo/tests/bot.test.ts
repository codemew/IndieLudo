import { describe, expect, it } from 'vitest';
import { BASE } from '../src/shared/board.js';
import { legalMoves } from '../src/shared/rules.js';
import { chooseMove } from '../src/server/bot.js';
import { game, withQueue } from './helpers.js';

describe('bot', () => {
  it('always returns a legal move (random positions)', () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 16807) % 2147483647), seed % n);
    for (let i = 0; i < 2000; i++) {
      const s = withQueue(game(['red', 'green', 'yellow', 'blue']), [rand(6) + 1, rand(6) + 1].slice(0, rand(2) + 1));
      for (const c of ['red', 'green', 'yellow', 'blue'] as const) s.tokens[c] = s.tokens[c].map(() => rand(58) - 1);
      const moves = legalMoves(s);
      const pick = chooseMove(s);
      if (moves.length === 0) expect(pick).toBeNull();
      else expect(moves).toContainEqual(pick);
    }
  });

  it('prefers a capture', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [2, 20, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5 = red progress 5
    expect(chooseMove(s)).toMatchObject({ tokenId: 0, to: 5 });
  });

  it('brings a token out of base with a 6 when nothing better exists', () => {
    const s = withQueue(game(), [6]);
    s.tokens.red = [10, BASE, BASE, BASE];
    expect(chooseMove(s)!.from).toBe(BASE);
  });

  it('returns null when there is nothing to do', () => {
    expect(chooseMove(game())).toBeNull();
  });
});
