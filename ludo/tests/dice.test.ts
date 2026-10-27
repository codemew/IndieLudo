import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cryptoDice } from '../src/server/dice.js';

afterEach(() => vi.restoreAllMocks());

describe('cryptoDice', () => {
  it('always returns an integer from 1 to 6', () => {
    for (let i = 0; i < 10_000; i++) {
      const v = cryptoDice();
      expect(Number.isInteger(v) && v >= 1 && v <= 6).toBe(true);
    }
  });

  it('is uniform (chi-square over 60k rolls)', () => {
    const n = 60_000;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) counts[cryptoDice() - 1]++;
    const expected = n / 6;
    const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // 5 degrees of freedom: p = 0.001 critical value is 20.52.
    expect(chi2).toBeLessThan(20.52);
    for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it('draws from crypto.randomInt', () => {
    const spy = vi.spyOn(crypto, 'randomInt');
    cryptoDice();
    expect(spy).toHaveBeenCalledWith(1, 7);
  });
});
