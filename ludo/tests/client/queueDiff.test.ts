import { describe, expect, it } from 'vitest';
import { freshDice } from '../../src/client/queueDiff.js';

describe('freshDice', () => {
  it('a new roll: only the added die is new', () => {
    expect(freshDice([6], [6, 2])).toEqual([false, true]);
    expect(freshDice([6, 6], [6, 6, 3])).toEqual([false, false, true]);
  });
  it('a move uses one die: the rest stay put', () => {
    expect(freshDice([6, 2], [2])).toEqual([false]);
    expect(freshDice([6, 6, 3], [6, 3])).toEqual([false, false]);
  });
  it('a new turn or an empty queue before it: everything is new', () => {
    expect(freshDice([], [4])).toEqual([true]);
    expect(freshDice([2], [6])).toEqual([true]);
  });
  it('a redraw with nothing changed: nothing is new', () => {
    expect(freshDice([6, 2], [6, 2])).toEqual([false, false]);
  });
});
