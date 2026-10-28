import { describe, expect, it } from 'vitest';
import { BASE } from '../src/shared/board.js';
import { HOP_MS, KILL_SLOWDOWN, MAX_MOUSTACHE, hopMs, moustacheLevel, moveMs, settleMs } from '../src/shared/heft.js';
import { applyMove, killsOf } from '../src/shared/rules.js';
import { game, withQueue } from './helpers.js';

describe('heft: moustache levels and how heavily a token moves', () => {
  it('uses the approved speeds: ×1.35, ×1.8, ×2.5, ×3.5, and stops at 4 kills', () => {
    expect(MAX_MOUSTACHE).toBe(4);
    expect([...KILL_SLOWDOWN]).toEqual([1, 1.35, 1.8, 2.5, 3.5]);
    expect([0, 1, 2, 3, 4, 5, 9].map(moustacheLevel)).toEqual([0, 1, 2, 3, 4, 4, 4]);
    expect(hopMs(0)).toBe(HOP_MS);
    expect(hopMs(4)).toBeCloseTo(HOP_MS * 3.5);
    expect(hopMs(7)).toBe(hopMs(4));
  });

  it('a whole move is every hop plus the final jiggle (none at 0 kills)', () => {
    expect(settleMs(0)).toBe(0);
    expect(moveMs(0, 4)).toBe(4 * HOP_MS);
    expect(moveMs(4, 4)).toBeCloseTo(4 * HOP_MS * 3.5 + settleMs(4));
    expect(moveMs(1, 4)).toBeLessThan(moveMs(2, 4));
  });
});

describe('kills per token', () => {
  it('the capturing token gains a kill, the captured one goes home with none, moves carry the weight', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5
    killsOf(s, 'yellow')[0] = 3; // a heavy yellow token...
    const events = applyMove(s, 0, 0); // ...captured by red
    expect(events.find((e) => e.type === 'move')).toMatchObject({ tokenId: 0, kills: 0 });
    expect(killsOf(s, 'red')).toEqual([1, 0, 0, 0]);
    expect(killsOf(s, 'yellow')).toEqual([0, 0, 0, 0]);

    // The bonus roll: the same red token moves again, now one kill heavier.
    s.turn = { ...s.turn, phase: 'moving', queue: [2] };
    expect(applyMove(s, 0, 0).find((e) => e.type === 'move')).toMatchObject({ kills: 1 });
  });

  it('counts every token separately and keeps counting past the moustache limit', () => {
    const s = game();
    const k = killsOf(s, 'red');
    k[2] = 6;
    expect(moustacheLevel(k[2])).toBe(4);
    expect(k).toEqual([0, 0, 6, 0]);
    expect(s.kills).toEqual({ red: [0, 0, 6, 0] });
  });
});
