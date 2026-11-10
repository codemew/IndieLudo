// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeOf, tf } from '../../../src/client/board/render.js';
import { flush, setupDom, toasts } from './harness.js';

vi.mock('../../../src/client/sound.js', () => ({ play: vi.fn(), isMuted: () => false, setMuted: vi.fn(), unlock: vi.fn(), installUnlockListeners: vi.fn(), audioContext: () => null }));

let ui: typeof import('../../../src/client/ui.js');
let Dice: typeof import('../../../src/client/dice.js').Dice;

beforeAll(async () => {
  setupDom();
  ui = await import('../../../src/client/ui.js');
  ({ Dice } = await import('../../../src/client/dice.js'));
});
beforeEach(() => {
  document.getElementById('toasts')!.innerHTML = '';
  document.getElementById('modal-root')!.innerHTML = '';
});

describe('toasts', () => {
  it('the same toast again does not stack a copy; a different one shows beside it', () => {
    ui.toast('Pick which die to use first');
    ui.toast('Pick which die to use first');
    ui.toast('No moves possible');
    expect(toasts()).toEqual(['Pick which die to use first', 'No moves possible']);
    expect(document.querySelector('#toasts .toast')!.classList.contains('again')).toBe(true);
  });

  it('asked for again, it stays for its full time from then', async () => {
    ui.toast('Slow down a little.', 'info', 120);
    await flush(80);
    ui.toast('Slow down a little.', 'info', 120);
    await flush(80);
    // The first one's time is up, but it was asked for again 80 ms ago: still there.
    expect(document.querySelector('#toasts .toast:not(.out)')).not.toBeNull();
    await flush(80);
    expect(document.querySelector('#toasts .toast:not(.out)')).toBeNull();
  });
});

describe('dialogs', () => {
  it('Escape dismisses the dialog on top, and only that one', async () => {
    const dismissed: string[] = [];
    ui.modal({ title: 'Under', body: '', actions: [{ label: 'Close' }], onDismiss: () => dismissed.push('under') });
    const top = ui.confirmDialog('Leave?', 'Sure?');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await top).toBe(false);
    expect(dismissed).toEqual([]);
    expect(document.querySelectorAll('#modal-root .modal-backdrop:not(.out)')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dismissed).toEqual(['under']);
    expect(document.querySelectorAll('#modal-root .modal-backdrop:not(.out)')).toHaveLength(0);
  });
});

describe('the board helpers and the die', () => {
  it('a token transform gives its grid position back, and anything else gives none', () => {
    expect(placeOf(tf(6.81, 13.19, 0.66))).toEqual({ x: 6.81, y: 13.19 });
    expect(placeOf(tf(-1, 0))).toEqual({ x: -1, y: 0 });
    expect(placeOf('')).toBeNull();
    expect(placeOf('scale(2)')).toBeNull();
  });

  it('with reduced motion the die neither tumbles on the tap nor spins: it shows the value', async () => {
    const d = new Dice();
    const cube = d.el.querySelector<HTMLElement>('.cube')!;
    const resting = cube.style.transform;
    d.windUp();
    d.settle();
    expect(cube.style.transform).toBe(resting);
    await d.roll(6);
    expect(cube.style.transform).toBe('rotateX(0deg) rotateY(180deg)');
    expect(d.el.classList.contains('rolling')).toBe(false);
    d.idle();
    expect(cube.style.transform).toBe(resting);
  });
});
