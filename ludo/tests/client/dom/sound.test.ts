// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sfx } from '../../../src/client/sound.js';

/** Just enough Web Audio to record what each sound effect schedules. */
class FakeParam {
  value = 0;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeNode {
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = new FakeParam();
  type = '';
  buffer: unknown = null;
  connect(n: unknown) {
    return n;
  }
  start() {
    ctx.started++;
  }
  stop() {}
}
const ctx = { started: 0, state: 'running', resumed: 0 };
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  get state() {
    return ctx.state;
  }
  resume() {
    ctx.resumed++;
    ctx.state = 'running';
    return Promise.resolve();
  }
  createGain = () => new FakeNode();
  createOscillator = () => new FakeNode();
  createBiquadFilter = () => new FakeNode();
  createBufferSource = () => new FakeNode();
  createBuffer = (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) });
}

let sound: typeof import('../../../src/client/sound.js');
beforeAll(async () => {
  Object.assign(window, { AudioContext: FakeAudioContext });
  sound = await import('../../../src/client/sound.js');
});

const ALL: Sfx[] = ['dice', 'step', 'capture', 'home', 'penalty', 'turn', 'win', 'tap', 'error', 'bonus', 'safe', 'six', 'six2', 'slurp', 'firstBlood', 'wildcard', 'land', 'friendlyFire'];

describe('sound effects', () => {
  it('nothing plays before the first tap unlocks audio', () => {
    sound.play('dice');
    expect(ctx.started).toBe(0);
  });

  it('every effect schedules sound once unlocked', () => {
    sound.unlock();
    for (const s of ALL) {
      const before = ctx.started;
      sound.play(s);
      expect(ctx.started, s).toBeGreaterThan(before);
    }
  });

  it('muted: silent, and remembered', () => {
    sound.setMuted(true);
    expect(sound.isMuted()).toBe(true);
    expect(localStorage.getItem('ludo.muted')).toBe('1');
    const before = ctx.started;
    sound.play('win');
    expect(ctx.started).toBe(before);
    sound.setMuted(false);
  });

  it('a suspended context (iOS in the background) is resumed instead of played into', () => {
    ctx.state = 'suspended';
    const before = ctx.started;
    sound.play('tap');
    expect(ctx.started).toBe(before);
    expect(ctx.resumed).toBeGreaterThan(0);
    // Coming back to the page asks for a tap to resume.
    sound.installUnlockListeners();
    ctx.state = 'suspended';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.state).toBe('running');
  });

  it('without Web Audio at all, unlocking does nothing', async () => {
    vi.resetModules();
    Object.assign(window, { AudioContext: undefined, webkitAudioContext: undefined });
    const fresh = await import('../../../src/client/sound.js');
    fresh.unlock();
    fresh.play('dice');
  });
});
