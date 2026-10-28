import rnnoiseWasmUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url';
import workletUrl from './voiceWorklet.ts?worker&url';

/**
 * What the microphone is opened with. Echo cancellation and automatic gain always; the
 * browser's own noise suppression only when RNNoise isn't running (both at once sound watery);
 * the phone's "voice isolation" wherever it has one.
 */
export function micConstraints(rnnoise: boolean, supported: Record<string, boolean | undefined> = {}): MediaTrackConstraints {
  const c: MediaTrackConstraints & { voiceIsolation?: boolean } = { echoCancellation: true, noiseSuppression: !rnnoise, autoGainControl: true, channelCount: 1 };
  if (supported.voiceIsolation) c.voiceIsolation = true;
  return c;
}

/** RNNoise can run here: audio worklets and WebAssembly. */
export const canDenoise = (): boolean => typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';

let wasmBytes: Promise<ArrayBuffer | null> | null = null;
/** RNNoise's wasm (fetched once, when voice first starts; cached by the browser for a year). */
function rnnoiseWasm(): Promise<ArrayBuffer | null> {
  return (wasmBytes ??= fetch(rnnoiseWasmUrl)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null));
}

/**
 * The microphone made ready to send:
 * `mic → RNNoise + voice gate (worklet) → cut rumble < 100 Hz → cut hiss > 7.5 kHz →
 *  +3 dB presence at 2.5 kHz → gentle compressor → 30 ms delay → track`.
 * The delay lets the gate open before the first syllable reaches the output, so speech
 * isn't clipped. `open` says whether anyone is talking; while not, nothing should be sent.
 */
export class MicChain {
  readonly track: MediaStreamTrack;
  /** Someone is talking (gate open). */
  open = false;
  /** Their loudness 0..1, for the talking animation (0 while the gate is shut). */
  level = 0;
  /** RNNoise loaded and running (otherwise the browser's noise suppression is on). */
  denoising = false;
  onGate: ((open: boolean) => void) | null = null;
  onReady: (() => void) | null = null;
  /** RNNoise couldn't load: the browser's own noise suppression should take over. */
  onNoRnnoise: (() => void) | null = null;

  private constructor(
    private ctx: AudioContext,
    private nodes: AudioNode[],
    dest: MediaStreamAudioDestinationNode,
  ) {
    this.track = dest.stream.getAudioTracks()[0];
    ctx.onstatechange = () => this.onReady?.();
  }

  /** Audio is flowing through (an iOS page needs a tap first). Until then send the raw mic. */
  get ready(): boolean {
    return this.ctx.state === 'running';
  }

  static async create(raw: MediaStream): Promise<MicChain | null> {
    if (!canDenoise()) return null;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      const [wasm] = await Promise.all([rnnoiseWasm(), ctx.audioWorklet.addModule(workletUrl)]);
      const source = ctx.createMediaStreamSource(raw);
      const voice = new AudioWorkletNode(ctx, 'ludo-voice', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { wasm: wasm ?? undefined } });
      const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 100, Q: 0.7 });
      const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7500, Q: 0.7 });
      const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2500, Q: 1, gain: 3 });
      const compressor = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 12, ratio: 3, attack: 0.003, release: 0.25 });
      const delay = new DelayNode(ctx, { delayTime: 0.03, maxDelayTime: 0.1 });
      const dest = ctx.createMediaStreamDestination();
      source.connect(voice).connect(highpass).connect(lowpass).connect(presence).connect(compressor).connect(delay).connect(dest);
      const chain = new MicChain(ctx, [source, voice, highpass, lowpass, presence, compressor, delay, dest], dest);
      voice.port.onmessage = (e: MessageEvent<{ type: string; open?: boolean; level?: number; rnnoise?: boolean }>) => {
        const m = e.data;
        if (m.type === 'ready') {
          chain.denoising = Boolean(m.rnnoise);
          if (!chain.denoising) chain.onNoRnnoise?.();
        }
        if (m.type === 'level') chain.level = m.level ?? 0;
        if (m.type === 'gate') {
          chain.open = Boolean(m.open);
          chain.level = m.level ?? 0;
          chain.onGate?.(chain.open);
        }
      };
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
      return chain;
    } catch {
      void ctx?.close().catch(() => {});
      return null;
    }
  }

  /** From a tap: audio may now start (iOS). */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  stop(): void {
    for (const n of this.nodes) n.disconnect();
    this.track.stop();
    this.onGate = this.onReady = this.onNoRnnoise = null;
    void this.ctx.close().catch(() => {});
  }
}
