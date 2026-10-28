import { describe, expect, it } from 'vitest';
import { BASE } from '../src/shared/board.js';
import { THREAT_RANGE, threatenedTokens } from '../src/shared/threats.js';
import { game } from './helpers.js';

describe('threatenedTokens', () => {
  it('an opponent 1 to 5 squares behind threatens a token; 6 or more does not', () => {
    expect(THREAT_RANGE).toBe(5);
    const s = game(); // red and yellow
    s.tokens.red = [5, BASE, BASE, BASE]; // absolute 5
    for (const gap of [1, 3, 5]) {
      s.tokens.yellow = [(5 - gap - 26 + 52) % 52, BASE, BASE, BASE]; // yellow progress for absolute 5 - gap
      expect(threatenedTokens(s), `gap ${gap}`).toEqual(new Set(['red:0']));
    }
    for (const gap of [6, 7]) {
      s.tokens.yellow = [(5 - gap - 26 + 52) % 52, BASE, BASE, BASE];
      expect(threatenedTokens(s), `gap ${gap}`).toEqual(new Set());
    }
  });

  it('only from behind: an opponent ahead is no threat', () => {
    const s = game();
    s.tokens.red = [3, BASE, BASE, BASE]; // absolute 3
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5, ahead of red by 2
    expect(threatenedTokens(s)).toEqual(new Set(['yellow:0'])); // ...and red is right behind yellow
  });

  it('safe squares, base and home columns are never in danger', () => {
    const s = game();
    s.tokens.red = [8, BASE, 52, BASE]; // absolute 8 is a star; 52 is red's home column
    s.tokens.yellow = [30, BASE, BASE, BASE]; // absolute 4: 4 behind the star
    expect(threatenedTokens(s)).toEqual(new Set());
    s.tokens.red = [0, BASE, BASE, BASE]; // red's start square
    s.tokens.yellow = [49, BASE, BASE, BASE]; // absolute 23... far away anyway
    expect(threatenedTokens(s)).toEqual(new Set());
  });

  it('no threat from an opponent that turns into its own home column first', () => {
    const s = game();
    // Yellow at progress 48 (absolute 22) has only 2 track squares left before its home column.
    s.tokens.yellow = [48, BASE, BASE, BASE];
    s.tokens.red = [24, BASE, BASE, BASE]; // absolute 24: 2 ahead, reachable (48 + 2 = 50)
    expect(threatenedTokens(s).has('red:0')).toBe(true);
    s.tokens.red = [25, BASE, BASE, BASE]; // absolute 25: 3 ahead, yellow would need 51 (home column)
    expect(threatenedTokens(s).has('red:0')).toBe(false);
  });
});
