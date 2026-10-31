import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOLUME_STEPS, adjusted, nearestStep, onVolumeChange, resetListenVolume, setVolume, volumeOf, volumeText } from '../../src/client/listenVolume.js';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  resetListenVolume();
});

describe('volume you chose for each player', () => {
  it('is full for everybody by default and for "nobody" (null)', () => {
    expect(volumeOf(7)).toBe(1);
    expect(volumeOf(null)).toBe(1);
  });

  it('keeps only what differs from full, per player, and keeps it across a reload', () => {
    setVolume(7, 0.3);
    setVolume(8, 0);
    expect(volumeOf(7)).toBe(0.3);
    expect(volumeOf(8)).toBe(0);
    expect(JSON.parse(store.get('ludo.listenVolume')!)).toEqual({ '7': 0.3, '8': 0 });
    resetListenVolume(); // (a new page load reads storage again)
    expect(volumeOf(7)).toBe(0.3);
    expect(volumeOf(8)).toBe(0);
    setVolume(7, 1);
    setVolume(8, 1);
    expect(store.has('ludo.listenVolume')).toBe(false);
  });

  it('tells listeners which player changed, and nothing when nothing did', () => {
    const seen: number[] = [];
    const off = onVolumeChange((id) => seen.push(id));
    setVolume(7, 0.6);
    setVolume(7, 0.6);
    setVolume(9, 1);
    expect(seen).toEqual([7]);
    off();
    setVolume(7, 0);
    expect(seen).toEqual([7]);
  });

  it('clamps nonsense, and ignores damaged storage', () => {
    setVolume(7, 5);
    setVolume(8, -1);
    setVolume(9, Number.NaN);
    expect(volumeOf(7)).toBe(1);
    expect(volumeOf(8)).toBe(0);
    expect(volumeOf(9)).toBe(1);
    store.set('ludo.listenVolume', '{"3":0.5,"x":0.2,"4":7,"5":"loud","-1":0.1}');
    resetListenVolume();
    expect([...adjusted()]).toEqual([[3, 0.5]]);
    store.set('ludo.listenVolume', 'not json');
    resetListenVolume();
    expect(volumeOf(3)).toBe(1);
  });

  it('forgets the oldest change beyond 64 players', () => {
    for (let id = 1; id <= 70; id++) setVolume(id, 0.3);
    expect(volumeOf(1)).toBe(1);
    expect(volumeOf(6)).toBe(1);
    expect(volumeOf(7)).toBe(0.3);
    expect(volumeOf(70)).toBe(0.3);
  });

  it('works without storage (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });
    resetListenVolume();
    setVolume(7, 0.6);
    expect(volumeOf(7)).toBe(0.6);
  });

  it('names the steps and snaps an odd stored value to the nearest one', () => {
    expect(VOLUME_STEPS).toEqual([1, 0.6, 0.3, 0]);
    expect(VOLUME_STEPS.map(volumeText)).toEqual(['100%', '60%', '30%', 'muted']);
    expect(nearestStep(0.5)).toBe(0.6);
    expect(nearestStep(0.1)).toBe(0);
    expect(nearestStep(0.2)).toBe(0.3);
    expect(nearestStep(0.9)).toBe(1);
  });
});
