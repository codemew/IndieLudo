/**
 * The audio paths that need a browser's audio APIs, with stand-ins for them: the game-server
 * voice relay (WebCodecs Opus), the microphone chain (Web Audio + worklet) and the worklet's
 * frame loop (RNNoise optional, the voice gate always).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url', () => ({ default: '/rnnoise.wasm' }));
vi.mock('../../src/client/voiceWorklet.ts?worker&url', () => ({ default: '/worklet.js' }));

class Node {
  connected: unknown[] = [];
  gain = { value: 1 };
  onaudioprocess: ((e: unknown) => void) | null = null;
  buffer: unknown = null;
  port = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: vi.fn() };
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {}
  start() {}
}
const audio = { contexts: [] as FakeCtx[], startState: 'running', resumable: true, failSource: false };
class FakeCtx {
  state = audio.startState;
  sampleRate = 48000;
  currentTime = 1;
  destination = new Node();
  audioWorklet = { addModule: vi.fn(async () => {}) };
  onstatechange: (() => void) | null = null;
  constructor() {
    audio.contexts.push(this);
  }
  resume = vi.fn(async () => {
    if (!audio.resumable) return;
    this.state = 'running';
    this.onstatechange?.();
  });
  close = vi.fn(async () => {});
  createMediaStreamSource = () => {
    if (audio.failSource) throw new Error('no mic');
    return new Node();
  };
  createScriptProcessor = () => new Node();
  createGain = () => new Node();
  createBufferSource = () => new Node();
  createBuffer = (_c: number, n: number) => ({ length: n, copyToChannel() {} });
  createMediaStreamDestination = () => Object.assign(new Node(), { stream: { getAudioTracks: () => [{ stop: vi.fn() }] } });
}
const codec = { encoders: [] as FakeEncoder[], decoders: [] as FakeDecoder[] };
class FakeEncoder {
  state = 'unconfigured';
  configured: any[] = [];
  encoded = 0;
  constructor(public cb: { output: (c: unknown) => void; error: () => void }) {
    codec.encoders.push(this);
  }
  configure(c: unknown) {
    this.state = 'configured';
    this.configured.push(c);
  }
  encode() {
    this.encoded++;
  }
  close() {
    this.state = 'closed';
  }
}
class FakeDecoder {
  state = 'unconfigured';
  decoded = 0;
  constructor(public cb: { output: (d: unknown) => void; error: () => void }) {
    codec.decoders.push(this);
  }
  configure() {
    this.state = 'configured';
  }
  decode() {
    this.decoded++;
  }
  close() {
    this.state = 'closed';
  }
}
const chunk = (bytes: number) => ({ byteLength: bytes, copyTo: (b: ArrayBuffer) => new Uint8Array(b).fill(7) });
const pcm = (n: number, v: number) => ({ numberOfFrames: n, sampleRate: 48000, copyTo: (dst: Float32Array) => dst.fill(v), close: vi.fn() });

beforeAll(() => {
  Object.assign(globalThis, {
    AudioContext: FakeCtx,
    AudioEncoder: FakeEncoder,
    AudioDecoder: FakeDecoder,
    AudioData: class {
      close() {}
    },
    EncodedAudioChunk: class {},
    BiquadFilterNode: Node,
    DynamicsCompressorNode: Node,
    DelayNode: Node,
    AudioWorkletNode: Node,
  });
});
afterEach(() => {
  audio.contexts.length = 0;
  codec.encoders.length = codec.decoders.length = 0;
});

describe('voice relayed through the game server', () => {
  it('sends Opus frames in small batches, skipping the tiny DTX ones and anything while the gate is shut', async () => {
    const { RelaySender, relaySupport } = await import('../../src/client/voiceRelay.js');
    expect(relaySupport()).toEqual({ send: true, receive: true });
    const batches: ArrayBuffer[][] = [];
    const s = new RelaySender((f) => batches.push(f));
    s.start({} as MediaStream, 12);
    s.start({} as MediaStream, 12); // already running: ignored
    expect(s.running).toBe(true);
    const enc = codec.encoders[0];
    expect(enc.configured[0]).toMatchObject({ codec: 'opus', bitrate: 12000 });
    const proc = audio.contexts[0] && (s as any).proc;
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048) } });
    expect(enc.encoded).toBe(1);
    s.setGate(false);
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048) } });
    expect(enc.encoded).toBe(1);
    enc.cb.output(chunk(1)); // DTX: nothing to send
    enc.cb.output(chunk(40));
    enc.cb.output(chunk(40));
    enc.cb.output(chunk(40));
    expect(batches.map((b) => b.length)).toEqual([3]);
    enc.cb.output(chunk(40));
    await new Promise((r) => setTimeout(r, 120)); // flushed after a moment
    expect(batches.map((b) => b.length)).toEqual([3, 1]);
    expect([s.frames, s.bytes]).toEqual([4, 160]);
    s.setBitrate(24);
    expect(enc.configured.at(-1)).toMatchObject({ bitrate: 24000 });
    (s as any).ctx.state = 'suspended';
    s.resume();
    enc.cb.error();
    expect(s.running).toBe(false);
  });

  it('plays what arrives per player, knows who was heard lately and how loud', async () => {
    const { RelayPlayer } = await import('../../src/client/voiceRelay.js');
    const p = new RelayPlayer();
    p.push(7, [new ArrayBuffer(30), new ArrayBuffer(30)]);
    expect(p.heard(7)).toBe(true);
    expect(p.heard(8)).toBe(false);
    expect(p.framesFrom(7)).toBe(2);
    const dec = codec.decoders[0];
    expect(dec.decoded).toBe(2);
    dec.cb.output(pcm(960, 0.1));
    expect(p.levelOf(7)).toBeGreaterThan(0.5);
    expect(p.levelOf(8)).toBe(0);
    // Far behind (more than 0.6 s queued): dropped instead of piling up.
    (p as any).from.get(7).playAt = 99;
    dec.cb.output(pcm(960, 0.1));
    expect((p as any).from.get(7).dropped).toBe(1);
    p.resume();
    dec.cb.error();
    expect(p.framesFrom(7)).toBe(0);
    p.push(9, [new ArrayBuffer(10)]);
    p.stopAll();
    expect(p.heard(9)).toBe(false);
  });
});

describe('the microphone chain', () => {
  it('builds the filter chain, reports RNNoise, the gate and the level, and stops cleanly', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8))) as any;
    const { MicChain, micConstraints, canDenoise } = await import('../../src/client/micChain.js');
    expect(canDenoise()).toBe(true);
    expect(micConstraints(true, { voiceIsolation: true })).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1, voiceIsolation: true });
    expect(micConstraints(false)).toMatchObject({ noiseSuppression: true });
    audio.startState = 'suspended';
    audio.resumable = false; // iOS: audio waits for a tap
    const chain = (await MicChain.create({} as MediaStream))!;
    expect(chain).not.toBeNull();
    expect(chain.ready).toBe(false);
    const ready = vi.fn();
    chain.onReady = ready;
    audio.resumable = true;
    chain.resume();
    await Promise.resolve();
    expect(chain.ready).toBe(true);
    expect(ready).toHaveBeenCalled();
    const worklet = (chain as any).nodes[1] as Node;
    const onNo = vi.fn();
    chain.onNoRnnoise = onNo;
    worklet.port.onmessage!({ data: { type: 'ready', rnnoise: false } });
    expect([chain.denoising, onNo.mock.calls.length]).toEqual([false, 1]);
    worklet.port.onmessage!({ data: { type: 'ready', rnnoise: true } });
    expect(chain.denoising).toBe(true);
    const gate = vi.fn();
    chain.onGate = gate;
    worklet.port.onmessage!({ data: { type: 'gate', open: true, level: 0.6 } });
    worklet.port.onmessage!({ data: { type: 'level', level: 0.8 } });
    expect([chain.open, chain.level, gate.mock.calls[0][0]]).toEqual([true, 0.8, true]);
    chain.stop();
    expect(audio.contexts[0].close).toHaveBeenCalled();
    audio.startState = 'running';
  });

  it('no audio worklets here, or setting up fails: null, and the plain microphone is used', async () => {
    const { MicChain } = await import('../../src/client/micChain.js');
    const saved = (globalThis as any).AudioWorkletNode;
    (globalThis as any).AudioWorkletNode = undefined;
    expect(await MicChain.create({} as MediaStream)).toBeNull();
    (globalThis as any).AudioWorkletNode = saved;
    audio.failSource = true;
    expect(await MicChain.create({} as MediaStream)).toBeNull();
    audio.failSource = false;
  });
});

describe('the audio worklet', () => {
  it('runs the gate on 10 ms frames and passes the audio on one frame behind', async () => {
    let Processor: any;
    const posted: any[] = [];
    Object.assign(globalThis, {
      sampleRate: 48000,
      AudioWorkletProcessor: class {
        port = { postMessage: (m: unknown) => posted.push(m) };
      },
      registerProcessor: (_name: string, ctor: unknown) => (Processor = ctor),
    });
    vi.resetModules();
    await import('../../src/client/voiceWorklet.js');
    // Without RNNoise's wasm (or with a broken one): just the gate.
    const p = new Processor({ processorOptions: { wasm: new ArrayBuffer(4) } });
    expect(posted[0]).toEqual({ type: 'ready', rnnoise: false });
    const out = new Float32Array(128);
    const loud = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 3) * 0.5);
    const quiet = new Float32Array(128).fill(0.0005);
    for (let i = 0; i < 40; i++) p.process([[quiet]], [[out]]);
    expect(out.every((x) => Math.abs(x - 0.0005) < 1e-9 || x === 0)).toBe(true);
    for (let i = 0; i < 60; i++) p.process([[loud]], [[out]]);
    expect(posted.some((m) => m.type === 'gate' && m.open)).toBe(true);
    expect(posted.some((m) => m.type === 'level')).toBe(true);
    expect(Math.max(...out)).toBeGreaterThan(0.1);
    p.process([[]], [[out]]); // no input this block
    expect(p.process([], [[out]])).toBe(true);
  });
});

describe('relayed voice volume', () => {
  it('plays each player at the volume chosen for them, from the first frame and live', async () => {
    const { RelayPlayer } = await import('../../src/client/voiceRelay.js');
    const vol = await import('../../src/client/listenVolume.js');
    vol.resetListenVolume();
    vol.setVolume(7, 0.3);
    const p = new RelayPlayer();
    const level = (id: number) => (p as any).from.get(id).gain.gain.value;
    p.push(7, [new ArrayBuffer(10)]);
    p.push(8, [new ArrayBuffer(10)]);
    expect([level(7), level(8)]).toEqual([0.3, 1]);
    p.setVolume(8, 0);
    p.setVolume(99, 0.5); // not heard from yet: nothing to change
    expect([level(7), level(8)]).toEqual([0.3, 0]);
    p.stopAll();
    vol.resetListenVolume();
  });
});
