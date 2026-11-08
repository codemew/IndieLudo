import musicUrl from './music/lobby.mp3?url';
import type { PublicLobby } from '../shared/types.js';
import { audioContext, isMuted, onMuteChange } from './sound.js';
import { state, subscribe } from './store.js';

/** The lobby music plays at this share of full volume. */
export const MUSIC_VOLUME = 0.3;
/** Each repeat fades in over the end of the one before, this many seconds. */
export const CROSSFADE_S = 4;
/** Leaving the lobby fades the music out over this long. */
const STOP_FADE_S = 1;

/**
 * What the lobby music should do now:
 * - 'loop': play, and repeat with a crossfade.
 * - 'finish': no more repeats; what is playing plays to its end, and nothing new starts.
 * - 'stop': fade out.
 */
export type MusicMode = 'loop' | 'finish' | 'stop';

type MusicLobby = Pick<PublicLobby, 'id' | 'status' | 'members' | 'size'>;

/**
 * When the music plays, lobby by lobby:
 * - It starts once every seat is taken, by people or bots (a seat a bot fills counts), and loops
 *   until the game starts.
 * - When the game starts it stops repeating ('finish'): the track plays on to its end.
 * - From then on in that lobby it loops whenever no game is on: on the results screen, back in the
 *   lobby, even though the bots left their seats at the end of the match, until the next game.
 * - Leaving the lobby ('stop') fades it out, and a new lobby starts over.
 */
export class MusicRule {
  private lobbyId: string | null = null;
  /** The lobby has been full: the music is this lobby's now, between games. */
  private started = false;

  next(lobby: MusicLobby | null): MusicMode {
    if (!lobby) {
      this.lobbyId = null;
      this.started = false;
      return 'stop';
    }
    if (lobby.id !== this.lobbyId) {
      this.lobbyId = lobby.id;
      this.started = false;
    }
    if (lobby.status === 'playing') return 'finish';
    if (lobby.members.length >= lobby.size) this.started = true;
    return this.started ? 'loop' : 'finish';
  }
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** When it starts, in the context's time. */
  at: number;
}

export interface MusicDeps {
  ctx: () => AudioContext | null;
  load: (ctx: AudioContext) => Promise<AudioBuffer>;
  muted: () => boolean;
  /** Timers (the tests use fake ones). */
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

/**
 * The music itself, on Web Audio: one buffer, played by a new source for each repeat. A repeat
 * starts CROSSFADE_S before the end of the one playing, fading in while that one fades out.
 */
export class LobbyMusic {
  private mode: MusicMode = 'stop';
  private voices: Voice[] = [];
  private out: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private loading: Promise<AudioBuffer> | null = null;
  private timer: unknown = null;

  constructor(private deps: MusicDeps) {}

  /** Playing, or about to (a repeat scheduled counts). */
  get playing(): boolean {
    return this.voices.length > 0;
  }

  /** Play-throughs going (two during a crossfade). */
  get voiceCount(): number {
    return this.voices.length;
  }

  /** A repeat is lined up. */
  get repeating(): boolean {
    return this.timer !== null;
  }

  async set(mode: MusicMode): Promise<void> {
    const was = this.mode;
    this.mode = mode;
    if (mode === 'stop') return this.stop();
    if (mode === 'finish') return this.unloop();
    if (was === 'loop' && this.voices.length) return;
    const ctx = this.deps.ctx();
    if (!ctx) return; // no sound until the first tap; set again once there is
    const buffer = await this.bufferFor(ctx).catch(() => null);
    if (!buffer || this.mode !== 'loop') return;
    if (this.voices.length) this.scheduleRepeat(ctx);
    else this.play(ctx, ctx.currentTime + 0.05, 0.5);
  }

  /** Follows the sound setting: muted is silent, not stopped. */
  setMuted(muted: boolean): void {
    const ctx = this.deps.ctx();
    if (ctx && this.out) this.out.gain.setTargetAtTime(muted ? 0 : MUSIC_VOLUME, ctx.currentTime, 0.05);
  }

  private bufferFor(ctx: AudioContext): Promise<AudioBuffer> {
    if (this.buffer) return Promise.resolve(this.buffer);
    this.loading ??= this.deps.load(ctx).then(
      (b) => (this.buffer = b),
      (e) => {
        this.loading = null;
        throw e;
      },
    );
    return this.loading;
  }

  private output(ctx: AudioContext): GainNode {
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = this.deps.muted() ? 0 : MUSIC_VOLUME;
      this.out.connect(ctx.destination);
    }
    return this.out;
  }

  /** Starts one play-through at `at`, fading in over `fadeIn` seconds. */
  private play(ctx: AudioContext, at: number, fadeIn: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + fadeIn);
    src.connect(gain).connect(this.output(ctx));
    const voice: Voice = { src, gain, at };
    src.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
    };
    src.start(at);
    this.voices.push(voice);
    if (this.mode === 'loop') this.scheduleRepeat(ctx);
  }

  /** The next repeat, crossfading over the end of the newest play-through. */
  private scheduleRepeat(ctx: AudioContext): void {
    const last = this.voices.at(-1);
    if (!last || !this.buffer) return;
    const crossAt = last.at + this.buffer.duration - CROSSFADE_S;
    this.deps.clearTimeout(this.timer);
    // Set up a moment ahead, so the repeat starts on the audio clock exactly on time.
    this.timer = this.deps.setTimeout(
      () => {
        this.timer = null;
        if (this.mode !== 'loop' || this.voices.at(-1) !== last) return;
        last.gain.gain.setValueAtTime(1, crossAt);
        last.gain.gain.linearRampToValueAtTime(0, crossAt + CROSSFADE_S);
        this.play(ctx, crossAt, CROSSFADE_S);
      },
      Math.max(0, (crossAt - ctx.currentTime - 1) * 1000),
    );
  }

  /**
   * No more repeats. What is playing plays to its end. A repeat that has just started fading in
   * fades back out, and the one it was replacing plays on to its own end.
   */
  private unloop(): void {
    this.deps.clearTimeout(this.timer);
    this.timer = null;
    const ctx = this.deps.ctx();
    if (!ctx || this.voices.length < 2) return;
    const [old, ...repeats] = this.voices;
    const t = ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setTargetAtTime(1, t, 0.3);
    for (const v of repeats) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, 0.4);
      v.src.stop(t + 1.5);
    }
  }

  private stop(): void {
    this.deps.clearTimeout(this.timer);
    this.timer = null;
    const ctx = this.deps.ctx();
    if (!ctx) {
      this.voices = [];
      return;
    }
    const t = ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, STOP_FADE_S / 4);
      v.src.stop(t + STOP_FADE_S);
    }
    this.voices = [];
  }
}

/** Starts the lobby music's watch on the lobby (once, at startup). */
export function startLobbyMusic(): LobbyMusic {
  const music = new LobbyMusic({
    ctx: audioContext,
    load: async (ctx) => ctx.decodeAudioData(await (await fetch(musicUrl)).arrayBuffer()),
    muted: isMuted,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const rule = new MusicRule();
  const update = () => void music.set(rule.next(state.lobby));
  subscribe((changed) => {
    if (changed.includes('lobby')) update();
  });
  onMuteChange((m) => music.setMuted(m));
  // The page can't play sound before the first tap; the music starts then if it should be playing.
  window.addEventListener('pointerdown', () => !music.playing && queueMicrotask(update), { capture: true });
  // What it is doing, for the browser tests (nothing to see: no sound can be read back).
  Object.defineProperty(window, '__music', { get: () => ({ playing: music.playing, voices: music.voiceCount, repeating: music.repeating }) });
  return music;
}
