import { describe, expect, it } from 'vitest';
import { isSideways } from '../../src/client/rotateHint.js';

describe('isSideways', () => {
  it('a phone turned sideways', () => {
    expect(isSideways({ orientationType: 'landscape-primary', screenW: 844, screenH: 390, typing: false })).toBe(true);
    // Without an orientation type, fall back on the screen's sides.
    expect(isSideways({ screenW: 844, screenH: 390, typing: false })).toBe(true);
  });

  it('an upright phone with the keyboard open is not sideways (the bug)', () => {
    expect(isSideways({ orientationType: 'portrait-primary', screenW: 390, screenH: 844, typing: true })).toBe(false);
    expect(isSideways({ orientationType: 'portrait-primary', screenW: 390, screenH: 844, typing: false })).toBe(false);
  });

  it('never while typing, and never on tablets or desktops', () => {
    expect(isSideways({ orientationType: 'landscape-primary', screenW: 844, screenH: 390, typing: true })).toBe(false);
    expect(isSideways({ orientationType: 'landscape-primary', screenW: 1180, screenH: 820, typing: false })).toBe(false);
  });
});
