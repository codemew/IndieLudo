import { afterEach, describe, expect, it, vi } from 'vitest';
import { atTempo, setTempo } from '../../src/client/board/animate.js';
import { RelaySender } from '../../src/client/voiceRelay.js';
import { BOT_BATTLE_TEMPO, tempoOf } from '../../src/shared/types.js';

describe('bot battle tempo on the phone', () => {
  afterEach(() => setTempo(1));

  it('scales every board animation and pause the same way the server does', () => {
    expect(atTempo(720)).toBe(720);
    setTempo(tempoOf({ botBattle: true }));
    expect(atTempo(720)).toBeCloseTo(720 * BOT_BATTLE_TEMPO);
    setTempo(tempoOf({}));
    expect(atTempo(720)).toBe(720);
  });
});

describe('relayed voice while nobody talks', () => {
  /** A stand-in for an encoded Opus chunk of `n` bytes. */
  const chunk = (n: number) => ({ byteLength: n, copyTo: (b: ArrayBuffer) => new Uint8Array(b).fill(7) }) as unknown as EncodedAudioChunk;

  it('silent (DTX) packets are not sent; speech goes out in batches of three', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const s = new RelaySender(send);
    const push = (c: EncodedAudioChunk) => (s as unknown as { onChunk: (c: EncodedAudioChunk) => void }).onChunk(c);
    for (let i = 0; i < 20; i++) push(chunk(1));
    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled();
    push(chunk(60));
    push(chunk(61));
    push(chunk(62));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((b: ArrayBuffer) => b.byteLength)).toEqual([60, 61, 62]);
    expect(s.frames).toBe(3);
    vi.useRealTimers();
  });
});
