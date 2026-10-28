/**
 * Decides, 10 ms at a time, whether the microphone carries someone talking. While it doesn't,
 * the phone sends no voice packets at all, so silence and steady background noise (a fan, the
 * TV hum, traffic) cost no data and don't crowd the network.
 *
 * It follows the background's loudness (the noise floor) and opens when a frame is clearly
 * above it. With RNNoise running, its speech probability decides too, so a loud but steady
 * noise doesn't count as talking. It stays open for a moment after the last word, so pauses
 * between words don't chop speech up.
 */
export interface VoiceGateOptions {
  /** Length of one frame in ms (RNNoise works on 10 ms). */
  frameMs?: number;
  /** How far above the background (dB) a frame must be to count as talking. */
  openDb?: number;
  /** How long it stays open after the last talking frame. */
  holdMs?: number;
  /** RNNoise's speech probability needed (when it's running). */
  speechProbability?: number;
}

/** Quieter than this is silence whatever the background: about -70 dBFS. */
const SILENT_RMS = 3e-4;

export class VoiceGate {
  open = false;
  /** Talking level 0..1 (for the talking animation): 0 while the gate is shut. */
  level = 0;
  private floor: number | null = null;
  private quietMs = 0;
  private readonly frameMs: number;
  private readonly openDb: number;
  private readonly holdMs: number;
  private readonly speech: number;

  constructor(o: VoiceGateOptions = {}) {
    this.frameMs = o.frameMs ?? 10;
    this.openDb = o.openDb ?? 9;
    this.holdMs = o.holdMs ?? 400;
    this.speech = o.speechProbability ?? 0.55;
  }

  /** One frame: its RMS (0..1 full scale) and, with RNNoise, its speech probability. Returns whether to send. */
  push(rms: number, vad?: number): boolean {
    const floor = (this.floor ??= Math.max(rms, SILENT_RMS));
    const aboveDb = 20 * Math.log10(Math.max(rms, 1e-9) / floor);
    const loud = rms > SILENT_RMS && aboveDb >= this.openDb;
    const talking = vad === undefined ? loud : vad >= this.speech && rms > SILENT_RMS && aboveDb >= 3;
    // The background: falls quickly to quieter frames and always creeps up (about 3 dB a
    // second). Speech keeps pulling it back down in the gaps between syllables; a steady noise
    // has no gaps, so within a few seconds it stops counting as voice.
    if (rms < floor) this.floor = floor * 0.8 + rms * 0.2;
    else this.floor = floor * 1.0035;
    this.floor = Math.max(this.floor!, SILENT_RMS / 4);
    if (talking) {
      this.open = true;
      this.quietMs = 0;
    } else if (this.open) {
      this.quietMs += this.frameMs;
      if (this.quietMs >= this.holdMs) this.open = false;
    }
    // Loudness for the animation: -60 dBFS → 0, -12 dBFS → 1.
    const dbfs = 20 * Math.log10(Math.max(rms, 1e-9));
    this.level = this.open ? Math.min(1, Math.max(0, (dbfs + 60) / 48)) : 0;
    return this.open;
  }
}

/** RMS of a block of samples (-1..1). */
export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}
