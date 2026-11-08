import { describe, expect, it, vi } from 'vitest';
import { CROSSFADE_S, LobbyMusic, MUSIC_VOLUME, musicMode } from '../../src/client/lobbyMusic.js';
import type { LobbyMember, PublicLobby } from '../../src/shared/types.js';

vi.mock('../../src/client/music/lobby.mp3?url', () => ({ default: '/lobby.mp3' }));

const member = (i: number, isBot = false): LobbyMember => ({
  color: (['red', 'green', 'yellow', 'blue'] as const)[i],
  userId: isBot ? null : i + 1,
  username: `p${i}`,
  isBot,
  ready: false,
  connected: true,
});
const lobby = (members: LobbyMember[], status: PublicLobby['status'] = 'waiting'): Pick<PublicLobby, 'status' | 'members' | 'size'> => ({
  status,
  members,
  size: 4,
});

describe('when the lobby music plays', () => {
  it('only with every seat taken by a person, until the game starts; a bot filling a seat does not count', () => {
    expect(musicMode(null)).toBe('stop');
    expect(musicMode(lobby([member(0), member(1), member(2)]))).toBe('finish');
    expect(musicMode(lobby([member(0), member(1), member(2), member(3, true)]))).toBe('finish');
    expect(musicMode(lobby([member(0), member(1), member(2), member(3)]))).toBe('loop');
    expect(musicMode(lobby([member(0), member(1), member(2), member(3)], 'playing'))).toBe('finish');
  });
});

/** A small stand-in for Web Audio: records each source's start/stop and each gain's automation. */
function fakeAudio() {
  const sources: { start?: number; stop?: number; onended: (() => void) | null; end: () => void }[] = [];
  const gains: { calls: [string, number, number][]; gain?: unknown }[] = [];
  const param = (log: [string, number, number][]) => ({
    value: 1,
    setValueAtTime: (v: number, t: number) => log.push(['set', v, t]),
    linearRampToValueAtTime: (v: number, t: number) => log.push(['ramp', v, t]),
    setTargetAtTime: (v: number, t: number) => log.push(['target', v, t]),
    cancelScheduledValues: (t: number) => log.push(['cancel', 0, t]),
  });
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain() {
      const g = { calls: [] as [string, number, number][], gain: undefined as unknown, connect: (x: unknown) => x };
      g.gain = param(g.calls);
      gains.push(g);
      return g;
    },
    createBufferSource() {
      const s = {
        buffer: null,
        onended: null as (() => void) | null,
        start(t: number) {
          s.started = t;
          rec.start = t;
        },
        stop(t: number) {
          rec.stop = t;
        },
        connect: (x: unknown) => x,
        started: 0,
      };
      const rec: (typeof sources)[number] = { onended: null, end: () => s.onended?.() };
      sources.push(rec);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext & { currentTime: number }, raw: ctx, sources, gains };
}

function setup(withCtx = true) {
  const audio = fakeAudio();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let ctxReady = withCtx;
  let muted = false;
  const music = new LobbyMusic({
    ctx: () => (ctxReady ? audio.ctx : null),
    load: async () => ({ duration: 54 }) as AudioBuffer,
    muted: () => muted,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => t && ((t as { live: boolean }).live = false),
  });
  const fire = () => {
    const t = timers.filter((x) => x.live).at(-1)!;
    t.live = false;
    t.fn();
  };
  return { music, audio, timers, fire, unlock: () => (ctxReady = true), mute: (m: boolean) => (muted = m) };
}

describe('the lobby music player', () => {
  it('loops at 30% volume, each repeat starting 4 s before the end and fading in while the last fades out', async () => {
    const { music, audio, timers, fire } = setup();
    await music.set('loop');
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].start).toBeCloseTo(0.05);
    expect((audio.gains[1].gain as { value: number }).value).toBe(MUSIC_VOLUME); // the output (made once the first voice connects)
    // The repeat is set up a second before the crossfade.
    expect(timers.at(-1)!.ms).toBeCloseTo((0.05 + 54 - CROSSFADE_S - 1) * 1000);
    fire();
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[1].start).toBeCloseTo(0.05 + 54 - CROSSFADE_S);
    const first = audio.gains[0].calls;
    expect(first.slice(-2)).toEqual([
      ['set', 1, 50.05],
      ['ramp', 0, 54.05],
    ]);
    const second = audio.gains[2].calls;
    expect(second[0]).toEqual(['set', 0, 50.05]);
    expect(second[1][0]).toBe('ramp');
    expect(second[1][2]).toBeCloseTo(54.05);
    // And the next one after that is already on its way.
    expect(timers.filter((t) => t.live)).toHaveLength(1);
  });

  it('once the game starts it stops repeating: what is playing plays to its end', async () => {
    const { music, audio, timers } = setup();
    await music.set('loop');
    await music.set('finish');
    expect(timers.every((t) => !t.live)).toBe(true);
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].stop).toBeUndefined();
  });

  it('a repeat that had just started fades back out, and the one before plays on to its end', async () => {
    const { music, audio, fire } = setup();
    await music.set('loop');
    fire();
    audio.raw.currentTime = 51;
    await music.set('finish');
    expect(audio.sources[1].stop).toBeCloseTo(52.5);
    expect(audio.sources[0].stop).toBeUndefined();
    expect(audio.gains[0].calls.slice(-2)).toEqual([
      ['cancel', 0, 51],
      ['target', 1, 51],
    ]);
  });

  it('after the match it loops again from where it is; a bot battle lobby or a part-filled one never starts it', async () => {
    const { music, audio, timers } = setup();
    await music.set('finish');
    expect(audio.sources).toHaveLength(0);
    await music.set('loop');
    await music.set('finish');
    await music.set('loop');
    expect(audio.sources).toHaveLength(1);
    expect(timers.filter((t) => t.live)).toHaveLength(1);
  });

  it('leaving the lobby fades it out; muted it keeps time silently; before the first tap it waits', async () => {
    const { music, audio, unlock, mute } = setup(false);
    await music.set('loop');
    expect(audio.sources).toHaveLength(0);
    unlock();
    mute(true);
    await music.set('loop');
    expect(audio.sources).toHaveLength(1);
    expect((audio.gains[1].gain as { value: number }).value).toBe(0);
    music.setMuted(false);
    expect(audio.gains[1].calls.at(-1)).toEqual(['target', MUSIC_VOLUME, 0]);
    audio.raw.currentTime = 10;
    await music.set('stop');
    expect(audio.sources[0].stop).toBe(11);
    expect(music.playing).toBe(false);
  });
});
