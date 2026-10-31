/** Dice luck: every roll is counted by face, on the server and in the phones' copy, and shown as shares that add up to 100. */
import { describe, expect, it } from 'vitest';
import { BASE, HOME } from '../src/shared/board.js';
import { applyRollUpdate, rollUpdateOf } from '../src/shared/rollUpdate.js';
import { countRoll, normalRange, rollCounts, rollOutliers, rollShares } from '../src/shared/rolls.js';
import { applyMove, applyRoll, legalMoves, statsOf } from '../src/shared/rules.js';
import type { PlayerStats, PublicGameState } from '../src/shared/types.js';
import { game } from './helpers.js';

describe('counting rolls', () => {
  it('every face is counted for the player who rolled it, and the sixes count agrees', () => {
    const s = game();
    s.tokens.red = [10, BASE, BASE, BASE];
    applyRoll(s, 2);
    applyMove(s, legalMoves(s)[0].tokenId, 0);
    expect(statsOf(s, 'red').rolls).toEqual([0, 1, 0, 0, 0, 0]);
    // The next player's roll (5, nothing to move) is theirs alone.
    applyRoll(s, 5);
    expect(rollCounts(s, 'red')).toEqual([0, 1, 0, 0, 0, 0]);
    expect(rollCounts(s, 'yellow')).toEqual([0, 0, 0, 0, 1, 0]);
    expect(rollCounts(s, 'green')).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('sixes lost to the three-sixes penalty, and a six nobody can use, are rolls too', () => {
    const s = game();
    s.tokens.red = [10, BASE, BASE, BASE];
    applyRoll(s, 6);
    applyRoll(s, 6);
    applyRoll(s, 6); // the penalty: the three are lost, but they were rolled
    expect(statsOf(s, 'red').rolls![5]).toBe(3);
    expect(statsOf(s, 'red').sixes).toBe(3);
    const t = game();
    t.tokens.red = [52, 53, HOME, HOME];
    applyRoll(t, 6); // no move for it
    expect(statsOf(t, 'red').rolls![5]).toBe(1);
  });

  it('a game saved before rolls were counted reads as no rolls, and starts counting', () => {
    const s = game();
    s.stats = { red: { cells: 0, captures: 0, sixes: 2, revenges: 0, firstBlood: false, owed: {} } };
    expect(rollCounts(s, 'red')).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rollCounts({ stats: undefined }, 'red')).toEqual([0, 0, 0, 0, 0, 0]);
    s.tokens.red = [10, BASE, BASE, BASE];
    applyRoll(s, 3);
    expect(rollCounts(s, 'red')).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it("the phones' copy of a slim roll update counts the same as the server, for any face", () => {
    for (const die of [1, 2, 3, 4, 5, 6]) {
      const s = game();
      s.tokens.red = [10, 20, BASE, BASE];
      const before: PublicGameState = { ...structuredClone(s), legalMoves: [], serverNow: 1 };
      const events = applyRoll(s, die);
      s.version++;
      const after: PublicGameState = { ...structuredClone(s), legalMoves: legalMoves(s), serverNow: 1 };
      const u = rollUpdateOf(after, events);
      if (!u) continue; // a roll that ends the turn goes out in full instead
      const mine = applyRollUpdate(before, u)!;
      expect(mine.stats?.red?.rolls).toEqual(after.stats?.red?.rolls);
      expect(mine.stats?.red?.sixes).toBe(after.stats?.red?.sixes);
    }
  });

  it('countRoll starts from zeros', () => {
    const st = { cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {} } as PlayerStats;
    countRoll(st, 4);
    countRoll(st, 4);
    expect(st.rolls).toEqual([0, 0, 0, 2, 0, 0]);
  });
});

describe('shares', () => {
  it('always add up to exactly 100 (plain rounding gives 99 and 101)', () => {
    expect(rollShares([1, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100); // 16.67 each: 6 × 17 would be 102
    expect(rollShares([1, 1, 1, 0, 0, 0])).toEqual([34, 33, 33, 0, 0, 0]); // 33.3 each: 3 × 33 would be 99
    for (let n = 0; n < 200; n++) {
      const counts = Array.from({ length: 6 }, (_, i) => ((n * 7919 + i * 104729) % 13) + (n % 3 === 0 ? 0 : i));
      if (counts.every((c) => c === 0)) continue;
      expect(rollShares(counts).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it('exact shares stay exact; no rolls gives zeros; a face never rolled is 0%', () => {
    expect(rollShares([5, 5, 0, 0, 0, 0])).toEqual([50, 50, 0, 0, 0, 0]);
    expect(rollShares([0, 0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rollShares([0, 0, 0, 0, 0, 12])).toEqual([0, 0, 0, 0, 0, 100]);
  });
});

describe('unusual rolls', () => {
  it('a perfectly even or slightly lopsided row marks nothing; a clear outlier is marked', () => {
    expect(rollOutliers([17, 17, 17, 17, 16, 16])).toEqual([null, null, null, null, null, null]);
    expect(rollOutliers([12, 14, 18, 20, 18, 18])).toEqual([null, null, null, null, null, null]);
    expect(rollOutliers([4, 17, 17, 16, 16, 30])).toEqual(['low', null, null, null, null, 'high']);
  });

  it('too few rolls to say anything: nothing is marked, even for all sixes', () => {
    expect(rollOutliers([0, 0, 0, 0, 0, 19])).toEqual([null, null, null, null, null, null]);
    expect(rollOutliers([0, 0, 0, 0, 0, 20])).toEqual([null, null, null, null, null, 'high']);
    expect(rollOutliers([0, 0, 0, 0, 0, 0])).toEqual([null, null, null, null, null, null]);
  });

  it('the usual range narrows with more rolls', () => {
    expect(normalRange(40)).toEqual([5, 28]);
    expect(normalRange(100)).toEqual([9, 24]);
    expect(normalRange(1000)).toEqual([14, 19]);
    expect(normalRange(1)[0]).toBe(0);
  });
});
