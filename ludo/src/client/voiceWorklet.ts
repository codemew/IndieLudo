/**
 * The microphone's audio worklet (runs on the audio thread, so a background tab can't slow it):
 * RNNoise noise removal, then the voice gate (voiceGate.ts), which tells the page when the
 * player starts and stops talking and how loud they are.
 *
 * RNNoise is Jitsi's build of Xiph's RNNoise (Apache-2.0 / BSD). The page fetches its 112 KB
 * wasm and hands the bytes over in `processorOptions.wasm`; without them only the gate runs.
 */
import { VoiceGate, rmsOf } from './voiceGate.js';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

/** RNNoise's frame: 10 ms at 48 kHz. */
const FRAME = 480;
/** RNNoise works on 16-bit sample values. */
const SCALE = 32768;
/** How often the talking level is reported while the gate is open. */
const LEVEL_EVERY = 5; // frames (50 ms)

interface Rnnoise {
  process(frame: Float32Array): number;
}

/** Instantiates the Emscripten build directly: it needs only a heap-resize and a memcpy import. */
function loadRnnoise(bytes: ArrayBuffer): Rnnoise {
  let memory!: WebAssembly.Memory;
  let heap = () => new Uint8Array(memory.buffer);
  const imports = {
    a: {
      // emscripten_resize_heap
      a: (requested: number) => {
        try {
          memory.grow(Math.ceil((requested - memory.buffer.byteLength) / 65536));
          return 1;
        } catch {
          return 0;
        }
      },
      // emscripten_memcpy_big
      b: (dest: number, src: number, num: number) => {
        heap().copyWithin(dest, src, src + num);
      },
    },
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
  const e = instance.exports as Record<string, any>;
  memory = e.c;
  heap = () => new Uint8Array(memory.buffer);
  e.d(); // static constructors
  const state = e.f(0); // rnnoise_create(default model)
  const ptr = e.g(FRAME * 4); // malloc
  return {
    process(frame) {
      const view = new Float32Array(memory.buffer, ptr, FRAME);
      for (let i = 0; i < FRAME; i++) view[i] = frame[i] * SCALE;
      const vad = e.j(state, ptr, ptr); // rnnoise_process_frame(st, out, in), in place
      const out = new Float32Array(memory.buffer, ptr, FRAME);
      for (let i = 0; i < FRAME; i++) frame[i] = out[i] / SCALE;
      return vad;
    },
  };
}

class LudoVoice extends AudioWorkletProcessor {
  private rnnoise: Rnnoise | null = null;
  private gate = new VoiceGate();
  private input = new Float32Array(FRAME);
  private filled = 0;
  /** Processed audio waiting to go out (a ring: written a frame at a time, read a block at a time). */
  private ring = new Float32Array(FRAME * 8);
  private readAt = 0;
  private writeAt = 0;
  private queued = 0;
  private frames = 0;

  constructor(options: { processorOptions?: { wasm?: ArrayBuffer } }) {
    super();
    const wasm = options.processorOptions?.wasm;
    if (wasm && sampleRate === 48000) {
      try {
        this.rnnoise = loadRnnoise(wasm);
      } catch {
        this.rnnoise = null;
      }
    }
    this.port.postMessage({ type: 'ready', rnnoise: Boolean(this.rnnoise) });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const src = inputs[0]?.[0];
    const dst = outputs[0][0];
    if (src) {
      let i = 0;
      while (i < src.length) {
        const n = Math.min(FRAME - this.filled, src.length - i);
        this.input.set(src.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === FRAME) {
          this.frame(this.input);
          this.filled = 0;
        }
      }
    }
    // Out, one frame behind: about 13 ms of delay in all.
    if (this.queued >= dst.length) {
      for (let i = 0; i < dst.length; i++) {
        dst[i] = this.ring[this.readAt];
        this.readAt = (this.readAt + 1) % this.ring.length;
      }
      this.queued -= dst.length;
    } else {
      dst.fill(0);
    }
    return true;
  }

  private frame(frame: Float32Array): void {
    const vad = this.rnnoise ? this.rnnoise.process(frame) : undefined;
    const wasOpen = this.gate.open;
    const open = this.gate.push(rmsOf(frame), vad);
    if (open !== wasOpen) this.port.postMessage({ type: 'gate', open, level: this.gate.level });
    else if (open && ++this.frames % LEVEL_EVERY === 0) this.port.postMessage({ type: 'level', level: this.gate.level });
    for (let i = 0; i < FRAME; i++) {
      this.ring[this.writeAt] = frame[i];
      this.writeAt = (this.writeAt + 1) % this.ring.length;
    }
    this.queued = Math.min(this.queued + FRAME, this.ring.length);
  }
}

registerProcessor('ludo-voice', LudoVoice);
