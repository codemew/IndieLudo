import { describe, expect, it, vi } from 'vitest';
import { VoiceGate, rmsOf } from '../../src/client/voiceGate.js';
import { micConstraints } from '../../src/client/micChain.js';
import { RelaySender } from '../../src/client/voiceRelay.js';

/** Feeds `ms` of frames at a steady RMS (and an optional RNNoise speech probability); returns how many were "send". */
function feed(g: VoiceGate, ms: number, rms: number, vad?: number): number {
  let open = 0;
  for (let t = 0; t < ms; t += 10) if (g.push(rms, vad)) open++;
  return open;
}

describe('voice gate (no packets while nobody talks)', () => {
  it('stays shut in a quiet room and opens at once when someone talks', () => {
    const g = new VoiceGate();
    expect(feed(g, 2000, 0.002)).toBe(0);
    expect(g.push(0.06)).toBe(true);
    expect(g.level).toBeGreaterThan(0.4);
  });

  it('holds open through the pauses between words, then shuts 400 ms after the last one', () => {
    const g = new VoiceGate();
    feed(g, 1000, 0.002);
    for (let w = 0; w < 5; w++) {
      feed(g, 200, 0.05); // a word
      expect(feed(g, 150, 0.002)).toBe(15); // a short pause: still open, so speech isn't chopped up
    }
    expect(feed(g, 390, 0.002)).toBe(39 - 15); // the last pause already counted 150 ms
    expect(g.open).toBe(false);
    expect(g.level).toBe(0);
  });

  it('a steady noise (a fan switched on) stops counting as voice within a few seconds', () => {
    const g = new VoiceGate();
    feed(g, 1000, 0.002);
    feed(g, 6000, 0.03); // the fan: 23 dB above the room, absorbed at about 3 dB a second
    expect(feed(g, 2000, 0.03)).toBe(0);
    // Talking over the fan still opens it.
    expect(g.push(0.25)).toBe(true);
  });

  it('with RNNoise, its speech probability decides: loud noise never opens it', () => {
    const g = new VoiceGate();
    feed(g, 500, 0.002, 0.02);
    expect(feed(g, 3000, 0.05, 0.05)).toBe(0); // loud, but RNNoise says it's not speech
    expect(g.push(0.05, 0.95)).toBe(true);
  });

  it('a silent microphone never opens it, whatever RNNoise says', () => {
    const g = new VoiceGate();
    expect(feed(g, 1000, 0, 0.9)).toBe(0);
  });

  it('rmsOf measures a block', () => {
    expect(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});

describe('microphone settings', () => {
  it("RNNoise replaces the browser's noise suppression; echo cancellation and gain stay on", () => {
    expect(micConstraints(true)).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 });
    expect(micConstraints(false)).toMatchObject({ noiseSuppression: true });
  });

  it("asks for the phone's voice isolation only where it has one", () => {
    expect(micConstraints(true, { voiceIsolation: true })).toMatchObject({ voiceIsolation: true });
    expect(micConstraints(true, {})).not.toHaveProperty('voiceIsolation');
  });
});

describe('talking levels', () => {
  it('maps loudness to 0..1 for the rings', async () => {
    vi.stubGlobal('document', undefined);
    const { talkLevel } = await import('../../src/client/voice.js');
    expect(talkLevel(0)).toBe(0);
    expect(talkLevel(0.001)).toBe(0); // -60 dBFS
    expect(talkLevel(0.25)).toBeGreaterThan(0.9);
    expect(talkLevel(1)).toBe(1);
    expect(talkLevel(0.03)).toBeGreaterThan(talkLevel(0.01));
    vi.unstubAllGlobals();
  });
});

describe('relayed voice and the gate', () => {
  it('the relay sender follows the gate (its capture callback skips encoding while shut)', () => {
    const s = new RelaySender(() => {});
    const gate = () => (s as unknown as { gateOpen: boolean }).gateOpen;
    expect(gate()).toBe(true); // no gate (e.g. no worklet support): send as before
    s.setGate(false);
    expect(gate()).toBe(false);
    s.setGate(true);
    expect(gate()).toBe(true);
  });
});
