import { KEYS, storage } from './storage.js';

/**
 * Tiny WebAudio synth, so there are no sound files to load. iOS only lets an
 * AudioContext start inside a user gesture, so unlock() runs on the splash tap (and
 * on the first pointerdown as a backup); after that, sounds can play from socket events.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = storage.get(KEYS.muted) === '1';

export type Sfx = 'dice' | 'step' | 'capture' | 'home' | 'penalty' | 'turn' | 'win' | 'tap' | 'error' | 'bonus' | 'safe' | 'six' | 'six2' | 'slurp' | 'firstBlood';

export function unlock(): void {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running') void ctx.resume();
    // A silent buffer played inside the gesture is what actually unlocks iOS.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* audio unavailable */
  }
}

export function installUnlockListeners(): void {
  const once = () => unlock();
  window.addEventListener('pointerdown', once, { once: true, capture: true });
  // iOS suspends the context when the page is backgrounded.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') {
      window.addEventListener('pointerdown', once, { once: true, capture: true });
      void ctx.resume().catch(() => {});
    }
  });
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  storage.set(KEYS.muted, m ? '1' : '0');
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, endFreq?: number): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(start: number, dur: number, vol = 0.25, freq = 2500, type: BiquadFilterType = 'bandpass'): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + start;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(filter).connect(g).connect(master);
  src.start(t);
}

/** Wood's main resonances (Hz, sharpness, level) for a die clack; real clacks are struck noise, not tones. */
const WOOD_MODES: [number, number, number][] = [
  [560, 6, 1],
  [1080, 9, 0.55],
  [1720, 12, 0.22],
];

/**
 * One die hitting the table: a few milliseconds of noise rung through the wood's resonances,
 * plus a soft low thud for body. `pitch` varies it a little per hit (edge vs face).
 */
function clack(start: number, vol: number, pitch: number): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + start;
  const len = Math.floor(ctx.sampleRate * 0.06);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const decay = ctx.sampleRate * 0.004;
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  for (const [freq, q, level] of WOOD_MODES) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * pitch;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol * level;
    src.connect(bp).connect(g).connect(master);
  }
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 260;
  const body = ctx.createGain();
  body.gain.value = vol * 0.6;
  src.connect(lp).connect(body).connect(master);
  src.start(t);
}

export function play(name: Sfx): void {
  if (muted || !ctx) return;
  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => {});
    return;
  }
  switch (name) {
    case 'dice': {
      // A wooden die bouncing on a table: clacks that come closer together and quieter as it
      // settles, like real bounces, over a faint rolling rumble. All of it is shaped noise,
      // so it sounds like wood rather than a synth, and it stays below the harsh treble.
      noise(0, 0.55, 0.08, 380, 'lowpass');
      let t = 0;
      let gap = 0.15;
      let v = 2.8;
      for (let i = 0; i < 7; i++) {
        clack(t, v, 0.9 + Math.random() * 0.25);
        t += gap * (0.9 + Math.random() * 0.2);
        gap *= 0.7;
        v *= 0.72;
      }
      break;
    }
    case 'step':
      tone(720, 0, 0.06, 'triangle', 0.18, 900);
      break;
    case 'capture':
      tone(620, 0, 0.32, 'sawtooth', 0.18, 110);
      noise(0, 0.18, 0.25, 900);
      break;
    case 'home':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.18, 'triangle', 0.22));
      break;
    case 'penalty':
      // Sad trombone: three falling notes and a long wobbling one.
      [392, 370, 349].forEach((f, i) => tone(f, i * 0.28, 0.26, 'sawtooth', 0.12, f * 0.97));
      tone(330, 0.84, 0.75, 'sawtooth', 0.12, 247);
      break;
    case 'slurp':
      // A quick rising slurp and a little "mm".
      noise(0, 0.22, 0.14, 700);
      tone(260, 0, 0.22, 'sine', 0.14, 620);
      tone(196, 0.26, 0.2, 'triangle', 0.1, 185);
      break;
    case 'safe':
      // Landing on a star: a bright twinkle.
      [1568, 2093, 2637].forEach((f, i) => tone(f, i * 0.06, 0.22, 'sine', 0.12));
      break;
    case 'six':
      // First six: a rising whoosh into a chord.
      noise(0, 0.25, 0.12, 3000);
      tone(330, 0, 0.3, 'triangle', 0.18, 990);
      [523, 659, 784].forEach((f) => tone(f, 0.28, 0.3, 'triangle', 0.12));
      break;
    case 'six2':
      // Second six: bigger, higher, with a crackle.
      noise(0, 0.35, 0.18, 1800);
      tone(440, 0, 0.32, 'sawtooth', 0.12, 1320);
      [659, 831, 988, 1319].forEach((f, i) => tone(f, 0.28 + i * 0.05, 0.36, 'triangle', 0.13));
      break;
    case 'firstBlood':
      // A deep drum hit, then a short low brass-like stab: dramatic without being shrill.
      tone(110, 0, 0.5, 'sine', 0.32, 45);
      noise(0, 0.12, 0.12, 300, 'lowpass');
      [196, 247, 294].forEach((f) => tone(f, 0.12, 0.55, 'sawtooth', 0.06, f * 0.98));
      [392, 494].forEach((f) => tone(f, 0.12, 0.45, 'triangle', 0.08));
      break;
    case 'turn':
      tone(880, 0, 0.12, 'sine', 0.22);
      tone(1320, 0.1, 0.2, 'sine', 0.2);
      break;
    case 'bonus':
      tone(990, 0, 0.1, 'triangle', 0.2);
      tone(1480, 0.08, 0.16, 'triangle', 0.2);
      break;
    case 'win':
      [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, i === 5 ? 0.6 : 0.16, 'triangle', 0.25));
      break;
    case 'tap':
      tone(1200, 0, 0.03, 'sine', 0.08);
      break;
    case 'error':
      tone(220, 0, 0.16, 'square', 0.1, 160);
      break;
  }
}
