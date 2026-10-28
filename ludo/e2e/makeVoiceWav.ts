/**
 * Builds the fake microphone for the browser voice tests: a real voice (the ALSA test
 * recordings, "Front left", "Rear right"…), then silence, then a steady fan-like hum, then the
 * voice again. 48 kHz mono 16-bit, so Chrome can loop it as its microphone.
 *   speech 0–~5.5 s · silence ~5.5–9.5 s · fan noise ~9.5–14.5 s · speech again
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const RATE = 48000;
const SAMPLES = ['Front_Left', 'Rear_Right', 'Front_Center', 'Side_Left'].map((n) => `/usr/share/sounds/alsa/${n}.wav`);

/** The 16-bit samples of a PCM WAV. */
function pcm(file: string): Int16Array {
  const b = readFileSync(file);
  let at = 12;
  while (at < b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') return new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + size));
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${file}`);
}

export const VOICE_WAV_TIMES = { speechEnd: 0, silenceEnd: 0, noiseEnd: 0 };

export function makeVoiceWav(out: string): string | null {
  if (!SAMPLES.every(existsSync)) return null;
  const parts: Int16Array[] = [];
  const silence = (s: number) => new Int16Array(Math.round(s * RATE));
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const fan = (s: number) => {
    // Brown-ish noise plus a 120 Hz hum: steady, loud, nothing like speech.
    const a = new Int16Array(Math.round(s * RATE));
    let last = 0;
    for (let i = 0; i < a.length; i++) {
      last = last * 0.97 + rand() * 0.03;
      a[i] = Math.round((last * 0.5 + Math.sin((2 * Math.PI * 120 * i) / RATE) * 0.05) * 32767 * 0.6);
    }
    return a;
  };
  for (const f of SAMPLES) parts.push(pcm(f), silence(0.15));
  VOICE_WAV_TIMES.speechEnd = parts.reduce((n, p) => n + p.length, 0) / RATE;
  parts.push(silence(4));
  VOICE_WAV_TIMES.silenceEnd = parts.reduce((n, p) => n + p.length, 0) / RATE;
  parts.push(fan(5));
  VOICE_WAV_TIMES.noiseEnd = parts.reduce((n, p) => n + p.length, 0) / RATE;
  for (const f of SAMPLES.slice(0, 2)) parts.push(pcm(f), silence(0.15));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = Buffer.alloc(total * 2);
  let o = 0;
  for (const p of parts) for (const v of p) (data.writeInt16LE(v, o), (o += 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(out, Buffer.concat([h, data]));
  return out;
}
