/**
 * Voice through the game server, for pairs of phones that can't connect directly (for example a
 * phone on Jio mobile data, reachable only over IPv6 or carrier NAT, and one on IPv4-only Wi-Fi).
 * The microphone is encoded to Opus with WebCodecs and sent in small batches over the game's own
 * connection; incoming frames are decoded and played with a short jitter buffer.
 */
const RATE = 48_000;
/** Opus frames per message: 3 × 20 ms. */
const BATCH = 3;
const FLUSH_MS = 80;
/** Audio is played this far behind real time, to ride out uneven delivery. */
const JITTER_S = 0.12;
/** More than this much audio waiting (a burst after a network stall): skip frames until caught up. */
const MAX_AHEAD_S = 0.6;
/** A player counts as heard through the relay if their audio arrived this recently. */
const HEARD_MS = 2500;

/** Opus packets this small carry no sound, only "still silent". */
const DTX_BYTES = 2;

/** Speech-tuned Opus with DTX, so a quiet microphone sends (almost) nothing. */
function opusConfig(kbps: number): AudioEncoderConfig {
  return { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: Math.max(6, kbps) * 1000, opus: { usedtx: true, useinbandfec: true } };
}

export function relaySupport(): { send: boolean; receive: boolean } {
  return {
    send: typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined' && typeof AudioContext !== 'undefined',
    receive: typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined' && typeof AudioContext !== 'undefined',
  };
}

/** Encodes the microphone as Opus and hands each batch of frames to `send`. */
export class RelaySender {
  private ctx: AudioContext | null = null;
  /** The microphone stream being sent. */
  stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private encoder: AudioEncoder | null = null;
  private batch: ArrayBuffer[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private timestamp = 0;
  /** The voice gate: while shut (nobody talking) nothing is encoded or sent. */
  private gateOpen = true;
  frames = 0;
  bytes = 0;

  constructor(private readonly send: (frames: ArrayBuffer[]) => void) {}

  get running(): boolean {
    return this.encoder !== null;
  }

  start(stream: MediaStream, kbps: number): void {
    if (this.encoder || !relaySupport().send) return;
    try {
      const ctx = new AudioContext({ sampleRate: RATE });
      const encoder = new AudioEncoder({ output: (chunk) => this.onChunk(chunk), error: () => this.stop() });
      encoder.configure(opusConfig(kbps));
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is old but works everywhere without loading a worklet module.
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = (e) => {
        if (!this.encoder || this.encoder.state !== 'configured' || !this.gateOpen) return;
        const pcm = new Float32Array(e.inputBuffer.getChannelData(0));
        const data = new AudioData({ format: 'f32-planar', sampleRate: ctx.sampleRate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: this.timestamp, data: pcm });
        this.timestamp += (pcm.length / ctx.sampleRate) * 1e6;
        this.encoder.encode(data);
        data.close();
      };
      source.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
      Object.assign(this, { ctx, encoder, source, proc, stream });
    } catch {
      this.stop();
    }
  }

  setGate(open: boolean): void {
    this.gateOpen = open;
  }

  setBitrate(kbps: number): void {
    if (this.encoder?.state === 'configured') this.encoder.configure(opusConfig(kbps));
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  private onChunk(chunk: EncodedAudioChunk): void {
    // Silence (DTX): nothing worth sending; the listener's buffer simply runs dry until speech.
    if (chunk.byteLength <= DTX_BYTES) return;
    const buf = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(buf);
    this.batch.push(buf);
    this.frames++;
    this.bytes += chunk.byteLength;
    if (this.batch.length >= BATCH) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.batch.length) this.send(this.batch.splice(0));
  }

  stop(): void {
    if (this.proc) this.proc.onaudioprocess = null;
    this.source?.disconnect();
    this.proc?.disconnect();
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    void this.ctx?.close().catch(() => {});
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.batch = [];
    this.ctx = this.source = this.proc = this.encoder = this.stream = null;
  }
}

interface Incoming {
  decoder: AudioDecoder;
  gain: GainNode;
  /** When the next decoded audio should start, on the playback clock. */
  playAt: number;
  timestamp: number;
  lastAt: number;
  frames: number;
  dropped: number;
  /** Loudness of the last decoded frame, and when it played, for the talking animation. */
  level: number;
  levelAt: number;
}

/** Decodes and plays relayed audio from each player, with a short jitter buffer per player. */
export class RelayPlayer {
  private ctx: AudioContext | null = null;
  private from = new Map<number, Incoming>();

  push(userId: number, frames: ArrayBuffer[]): void {
    if (!relaySupport().receive) return;
    const ctx = (this.ctx ??= new AudioContext({ sampleRate: RATE }));
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    let p = this.from.get(userId);
    if (!p) {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const decoder = new AudioDecoder({ output: (d) => this.play(userId, d), error: () => this.drop(userId) });
      decoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      p = { decoder, gain, playAt: 0, timestamp: 0, lastAt: 0, frames: 0, dropped: 0, level: 0, levelAt: 0 };
      this.from.set(userId, p);
    }
    for (const data of frames) {
      if (p.decoder.state !== 'configured') break;
      p.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timestamp, data }));
      p.timestamp += 20_000;
    }
    p.lastAt = performance.now();
    p.frames += frames.length;
  }

  private play(userId: number, data: AudioData): void {
    const p = this.from.get(userId);
    const ctx = this.ctx;
    if (!p || !ctx) return data.close();
    const n = data.numberOfFrames;
    const pcm = new Float32Array(n);
    data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pcm[i] * pcm[i];
    p.level = Math.sqrt(sum / (n || 1));
    p.levelAt = performance.now();
    const buffer = ctx.createBuffer(1, n, data.sampleRate);
    buffer.copyToChannel(pcm, 0);
    data.close();
    const now = ctx.currentTime;
    // Behind (ran dry): restart a little ahead of now. Too far ahead (a backlog): drop this frame,
    // so the delay shrinks back instead of staying long.
    if (p.playAt > now + MAX_AHEAD_S) {
      p.dropped++;
      return;
    }
    if (p.playAt < now + 0.02) p.playAt = now + JITTER_S;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(p.gain);
    src.start(p.playAt);
    p.playAt += buffer.duration;
  }

  /** Their relayed audio arrived recently. */
  heard(userId: number): boolean {
    const p = this.from.get(userId);
    return Boolean(p && performance.now() - p.lastAt < HEARD_MS);
  }

  /** Their loudness 0..1 from relayed audio, 0 once it stops arriving. */
  levelOf(userId: number): number {
    const p = this.from.get(userId);
    if (!p || performance.now() - p.levelAt > 250 || !(p.level > 0)) return 0;
    return Math.min(1, Math.max(0, (20 * Math.log10(p.level) + 60) / 48));
  }

  framesFrom(userId: number): number {
    return this.from.get(userId)?.frames ?? 0;
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  drop(userId: number): void {
    const p = this.from.get(userId);
    if (!p) return;
    this.from.delete(userId);
    if (p.decoder.state !== 'closed') p.decoder.close();
    p.gain.disconnect();
  }

  stopAll(): void {
    for (const id of [...this.from.keys()]) this.drop(id);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
