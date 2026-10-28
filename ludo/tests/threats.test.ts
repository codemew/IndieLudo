import { describe, expect, it } from 'vitest';
import { BASE, HOME, absoluteSquare } from '../src/shared/board.js';
import { legalMoves } from '../src/shared/rules.js';
import { THREAT_RANGE, threatenedTokens } from '../src/shared/threats.js';
import { COLORS, type Color } from '../src/shared/types.js';
import { game, withQueue } from './helpers.js';

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

describe('threatenedTokens agrees with the real rules, everywhere', () => {
  /** Ground truth from the rules engine: can `hunter` capture `victim` with one roll of 1..5? */
  function capturableWithOneToFive(colors: Color[], hunter: Color, q: number, victim: Color, p: number): boolean {
    for (let die = 1; die <= THREAT_RANGE; die++) {
      const s = withQueue(game(colors), [die]);
      s.turn.seat = s.seats.findIndex((x) => x.color === hunter); // seats are in board order, not `colors` order
      for (const c of colors) s.tokens[c] = [BASE, BASE, BASE, BASE];
      s.tokens[hunter][0] = q;
      s.tokens[victim][0] = p;
      if (legalMoves(s).some((m) => m.tokenId === 0 && m.captures.some((c) => c.color === victim && c.tokenId === 0))) return true;
    }
    return false;
  }

  it('for every pair of colours, every victim square and every hunter square', () => {
    const pairs: [Color, Color][] = COLORS.flatMap((a) => COLORS.filter((b) => b !== a).map((b) => [a, b] as [Color, Color]));
    let checked = 0;
    let inDanger = 0;
    const gaps = new Set<number>();
    for (const [victim, hunter] of pairs) {
      const colors = [victim, hunter];
      for (let p = BASE; p < HOME; p++) {
        for (let q = BASE; q < HOME; q++) {
          const s = game(colors);
          s.tokens[victim] = [p, BASE, BASE, BASE];
          s.tokens[hunter] = [q, BASE, BASE, BASE];
          const ours = threatenedTokens(s).has(`${victim}:0`);
          const truth = capturableWithOneToFive(colors, hunter, q, victim, p);
          if (ours !== truth) throw new Error(`${hunter}@${q} vs ${victim}@${p}: threatened=${ours}, rules say ${truth}`);
          checked++;
          if (truth) {
            inDanger++;
            gaps.add((absoluteSquare(victim, p)! - absoluteSquare(hunter, q)! + 52) % 52);
          }
        }
      }
    }
    expect(checked).toBe(12 * 57 * 57);
    expect(inDanger).toBeGreaterThan(0);
    // Danger only ever comes from 1 to 5 squares behind, and every one of those distances occurs.
    expect([...gaps].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
