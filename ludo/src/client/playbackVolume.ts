/**
 * Playing someone's voice quieter. Where the browser lets a page set an audio element's volume that
 * is all it takes. iPhones never do (the volume always reads 1), so there a quieter-but-not-silent
 * voice goes through Web Audio instead: the element stays muted (it keeps the stream running) and
 * a gain node in between plays it at the chosen level. Muting works by `muted` everywhere.
 */

interface Routed {
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
}

const routed = new WeakMap<HTMLAudioElement, Routed>();
let ctx: AudioContext | null = null;
let volumeWorks: boolean | null = null;

/** True where `audio.volume = 0.5` takes effect (not on iOS). */
export function elementVolumeWorks(): boolean {
  if (volumeWorks === null) {
    try {
      const probe = new Audio();
      probe.volume = 0.5;
      volumeWorks = probe.volume === 0.5;
    } catch {
      volumeWorks = false;
    }
  }
  return volumeWorks;
}

/** Test hook: probe the browser again. */
export function resetPlaybackVolume(): void {
  volumeWorks = null;
  ctx = null;
}

/** Plays `audio` at `level` (0 = silent, 1 = as it arrives). Safe to call again whenever the stream or level changes. */
export function setPlaybackVolume(audio: HTMLAudioElement, level: number): void {
  const v = Math.min(1, Math.max(0, level));
  const src = audio.srcObject as MediaStream | null;
  const stream = src && typeof src.getAudioTracks === 'function' ? src : null;
  const direct = elementVolumeWorks() || v === 0 || v === 1 || !stream || typeof AudioContext === 'undefined';
  if (direct) {
    releasePlayback(audio);
    audio.muted = v === 0;
    if (elementVolumeWorks()) audio.volume = v;
    return;
  }
  // iOS, somewhere between silent and full.
  let r = routed.get(audio);
  if (r && r.stream !== stream) {
    releasePlayback(audio);
    r = undefined;
  }
  if (!r) {
    try {
      ctx ??= new AudioContext();
      const gain = ctx.createGain();
      const node = ctx.createMediaStreamSource(stream);
      node.connect(gain);
      gain.connect(ctx.destination);
      r = { stream, node, gain };
      routed.set(audio, r);
    } catch {
      // No Web Audio here: better a little loud than silent.
      audio.muted = false;
      return;
    }
  }
  r.gain.gain.value = v;
  audio.muted = true;
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
}

/** Takes the element off the Web Audio route (it plays on its own again) and drops it. */
export function releasePlayback(audio: HTMLAudioElement): void {
  const r = routed.get(audio);
  if (!r) return;
  routed.delete(audio);
  try {
    r.node.disconnect();
    r.gain.disconnect();
  } catch {
    /* already gone */
  }
}

/** A tap lets a suspended audio context (iOS) start. */
export function resumePlayback(): void {
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
}
