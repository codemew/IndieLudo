import { describe, expect, it } from 'vitest';
import { BASE, HOME } from '../src/shared/board.js';
import { moustacheLevel, moveMs } from '../src/shared/heft.js';
import { applyMove, legalMoves } from '../src/shared/rules.js';
import { playerStats } from '../src/shared/awards.js';
import { game, withQueue } from './helpers.js';

/**
 * Yellow has two tokens together on an ordinary square (absolute 5: not a star, not a start).
 * Red lands there with a 3 from absolute 2.
 */
function pair() {
  const s = withQueue(game(), [3]);
  s.tokens.red = [2, BASE, BASE, BASE];
  s.tokens.yellow = [31, 31, BASE, BASE]; // (26 + 31) % 52 = 5
  return s;
}

describe('two tokens on one ordinary square', () => {
  it('a token landing there captures both at once', () => {
    const s = pair();
    expect(legalMoves(s)[0].captures).toEqual([
      { color: 'yellow', tokenId: 0 },
      { color: 'yellow', tokenId: 1 },
    ]);
    const events = applyMove(s, 0, 0);
    expect(events.filter((e) => e.type === 'capture').map((e) => e.type === 'capture' && e.tokenId)).toEqual([0, 1]);
    expect(s.tokens.yellow).toEqual([BASE, BASE, BASE, BASE]);
    expect(s.tokens.red[0]).toBe(5);
  });

  it('the moustache grows once per token captured: two levels, and hops get heavier to match', () => {
    const s = pair();
    applyMove(s, 0, 0);
    expect(s.kills!.red![0]).toBe(2);
    expect(moustacheLevel(2)).toBe(2);
    expect(moveMs(2, 3)).toBeGreaterThan(moveMs(1, 3));
  });

  it('both captured tokens go home clean-shaven, whatever moustache they wore', () => {
    const s = pair();
    s.kills = { yellow: [3, 1, 0, 0] };
    applyMove(s, 0, 0);
    expect(s.kills.yellow).toEqual([0, 0, 0, 0]);
  });

  it('stats: two captures, one moustache grown (Baby face counts tokens, not captures), first blood once', () => {
    const s = pair();
    const events = applyMove(s, 0, 0);
    expect(playerStats(s, 'red')).toMatchObject({ captures: 2, staches: 1, firstBlood: true });
    expect(events.filter((e) => e.type === 'capture' && e.firstBlood)).toHaveLength(1);
    // Yellow now has two captures to avenge.
    expect(playerStats(s, 'yellow').owed).toEqual({ red: 2 });
  });

  it('revenge is paid per token: two owed captures paid back by one double capture', () => {
    const s = pair();
    s.stats = { red: { cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: { yellow: 2 } } };
    applyMove(s, 0, 0);
    expect(playerStats(s, 'red')).toMatchObject({ revenges: 2, owed: { yellow: 0 } });
  });

  it('each captured token earns a bonus roll, like a single capture does', () => {
    const s = pair();
    const events = applyMove(s, 0, 0);
    expect(events.filter((e) => e.type === 'bonus')).toHaveLength(1); // the first one starts now…
    expect(s.turn).toMatchObject({ seat: 0, phase: 'rolling', bonus: 1 }); // …and one more is waiting
  });

  it('a pair of different colours on one square is captured together too', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5
    s.tokens.green = [44, BASE, BASE, BASE]; // (13 + 44) % 52 = 5
    applyMove(s, 0, 0);
    expect([s.tokens.yellow[0], s.tokens.green[0]]).toEqual([BASE, BASE]);
    expect(s.kills!.red![0]).toBe(2);
  });

  it('a second-lap token in the pair is captured like any other', () => {
    const s = pair();
    s.tokens.yellow = [31, 89, BASE, BASE]; // second lap: (26 + 89 - 6) % 52 = 5
    applyMove(s, 0, 0);
    expect(s.tokens.yellow.slice(0, 2)).toEqual([BASE, BASE]);
  });

  it('on a star the pair is safe, and the mover simply joins them', () => {
    const s = withQueue(game(), [6]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [34, 34, BASE, BASE]; // (26 + 34) % 52 = 8: red's star
    expect(legalMoves(s).find((m) => m.tokenId === 0)!.captures).toEqual([]);
    applyMove(s, 0, 0);
    expect(s.tokens.yellow.slice(0, 2)).toEqual([34, 34]);
  });

  it('the double-moustached token counts for "most macho" once when it gets home', () => {
    const s = pair();
    applyMove(s, 0, 0);
    s.tokens.red[0] = 55;
    Object.assign(s.turn, { phase: 'moving', queue: [1], bonus: 0 });
    applyMove(s, 0, 0);
    expect(s.tokens.red[0]).toBe(HOME);
    expect(playerStats(s, 'red').machoHome).toBe(1);
  });
});
