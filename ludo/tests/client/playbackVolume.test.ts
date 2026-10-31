import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elementVolumeWorks, releasePlayback, resetPlaybackVolume, resumePlayback, setPlaybackVolume } from '../../src/client/playbackVolume.js';

class Node {
  connected = true;
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn(() => (this.connected = false));
}
const ctxs: FakeCtx[] = [];
class FakeCtx {
  state = 'suspended';
  destination = new Node();
  nodes: Node[] = [];
  sources = 0;
  constructor() {
    ctxs.push(this);
  }
  resume = vi.fn(async () => (this.state = 'running'));
  createGain = () => this.nodes[this.nodes.push(new Node()) - 1];
  createMediaStreamSource = () => {
    this.sources++;
    return this.nodes[this.nodes.push(new Node()) - 1];
  };
}
const stream = () => ({ getAudioTracks: () => [{}] }) as unknown as MediaStream;
const element = (src: MediaStream | null = stream()) => ({ srcObject: src, muted: false, volume: 1 }) as unknown as HTMLAudioElement;

/** A browser that lets script set an element's volume (Chrome, Firefox, desktop Safari) or not (iOS: it always reads 1). */
function browser(volumeSettable: boolean) {
  vi.stubGlobal(
    'Audio',
    class {
      private v = 1;
      get volume() {
        return this.v;
      }
      set volume(x: number) {
        if (volumeSettable) this.v = x;
      }
    },
  );
  vi.stubGlobal('AudioContext', FakeCtx);
  resetPlaybackVolume();
}

beforeEach(() => {
  ctxs.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('playing a voice quieter', () => {
  it('where the browser allows it, the element\'s own volume and mute do the job', () => {
    browser(true);
    expect(elementVolumeWorks()).toBe(true);
    const a = element();
    setPlaybackVolume(a, 0.3);
    expect([a.volume, a.muted]).toEqual([0.3, false]);
    setPlaybackVolume(a, 0);
    expect([a.volume, a.muted]).toEqual([0, true]);
    setPlaybackVolume(a, 1);
    expect([a.volume, a.muted]).toEqual([1, false]);
    setPlaybackVolume(a, 7);
    expect(a.volume).toBe(1);
    expect(ctxs).toHaveLength(0);
  });

  it('on an iPhone (volume cannot be set): mute and full volume are plain, in between goes through a gain node', () => {
    browser(false);
    expect(elementVolumeWorks()).toBe(false);
    const a = element();
    setPlaybackVolume(a, 0);
    expect(a.muted).toBe(true);
    setPlaybackVolume(a, 1);
    expect(a.muted).toBe(false);
    expect(ctxs).toHaveLength(0);

    setPlaybackVolume(a, 0.3);
    expect(a.muted).toBe(true); // (the element only keeps the stream running)
    const ctx = ctxs[0];
    const gain = ctx.nodes[0];
    expect(gain.gain.value).toBe(0.3);
    expect(ctx.destination).toBeDefined();
    expect(ctx.resume).toHaveBeenCalled();
    // Changing the level reuses the same route.
    setPlaybackVolume(a, 0.6);
    expect(gain.gain.value).toBe(0.6);
    expect(ctx.sources).toBe(1);
    // Back to full: off the gain route, playing on its own.
    setPlaybackVolume(a, 1);
    expect(a.muted).toBe(false);
    expect(gain.disconnect).toHaveBeenCalled();
    // Muted from there works, and a later level builds a fresh route.
    setPlaybackVolume(a, 0.3);
    expect(ctx.sources).toBe(2);
  });

  it('a new stream on the same element is routed again, and an element with no stream yet plays as it is', () => {
    browser(false);
    const a = element(null);
    setPlaybackVolume(a, 0.3);
    expect(a.muted).toBe(false);
    expect(ctxs).toHaveLength(0);
    (a as any).srcObject = stream();
    setPlaybackVolume(a, 0.3);
    const ctx = ctxs[0];
    expect(ctx.sources).toBe(1);
    (a as any).srcObject = stream();
    setPlaybackVolume(a, 0.3);
    expect(ctx.sources).toBe(2);
    expect(ctx.nodes[1].disconnect).toHaveBeenCalled(); // the old source
    releasePlayback(a);
    expect(ctx.nodes[3].disconnect).toHaveBeenCalled();
    releasePlayback(a); // twice is harmless
  });

  it('without Web Audio at all, it stays audible rather than silent', () => {
    browser(false);
    vi.stubGlobal('AudioContext', undefined);
    const a = element();
    setPlaybackVolume(a, 0.3);
    expect(a.muted).toBe(false);
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    setPlaybackVolume(a, 0.3);
    expect(a.muted).toBe(false);
  });

  it('a tap lets a suspended audio context start', () => {
    browser(false);
    setPlaybackVolume(element(), 0.3);
    ctxs[0].state = 'suspended';
    ctxs[0].resume.mockClear();
    resumePlayback();
    expect(ctxs[0].resume).toHaveBeenCalled();
  });
});
