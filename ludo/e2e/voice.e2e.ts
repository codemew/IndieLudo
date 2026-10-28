/**
 * Voice chat in real Chrome: the built-in voice server, RNNoise, no packets in silence, the
 * talking rings, a full lobby of 8, and the direct-link fallback. The microphone is a WAV of a
 * real voice, then silence, then a steady fan-like noise (makeVoiceWav.ts), looped by Chrome.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';
import { makeVoiceWav } from './makeVoiceWav.js';

const WAV = makeVoiceWav(join(mkdtempSync(join(tmpdir(), 'ludo-voice-')), 'voice.wav'));

/** Keeps every RTCPeerConnection a page makes in window.__pcs, so the test can read their stats. */
const watchPcs = async (p: Page): Promise<void> => {
  await
  p.evaluateOnNewDocument(`(() => {
    const Real = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Real(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Real.prototype;
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  })()`);
};

/** Packets sent and received on the page's voice-server connection (the one with 8 audio sections). */
const sfuStats = (p: Page) =>
  p.evaluate(`(async () => {
    const pc = window.__pcs.find((x) => x.connectionState !== 'closed' && (x.remoteDescription?.sdp.match(/^m=audio/gm) ?? []).length === 8);
    if (!pc) return null;
    let sent = 0, got = 0;
    (await pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp') sent += s.packetsSent;
      if (s.type === 'inbound-rtp') got += s.packetsReceived;
    });
    return { state: pc.connectionState, sent, got, direct: window.__pcs.filter((x) => x !== pc && x.connectionState === 'connected').length };
  })()`) as Promise<{ state: string; sent: number; got: number; direct: number } | null>;

describe.skipIf(!CHROME || !BUILT || !WAV)('voice chat', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];

  beforeAll(async () => {
    t = await setup({ chromeArgs: [`--use-file-for-fake-audio-capture=${WAV}`], onPage: watchPcs });
    phones = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('both phones connect to the voice server (UDP) and hear each other through it, with no direct link', async () => {
    for (const p of phones) await until('the voice server link', async () => (await sfuStats(p))?.state === 'connected', 15_000);
    await until('voice arriving', async () => ((await sfuStats(phones[1]))?.got ?? 0) > 50, 20_000);
    for (const p of phones) expect((await sfuStats(p))!.direct).toBe(0);
    await until('the panel says so', async () => (await phones[0].$eval('#lobby-voice', (e) => e.textContent!)).includes('via the voice server'), 5000);
  });

  it('RNNoise runs: its wasm loads, with no security-policy errors', async () => {
    await tap(phones[0], '.voice-details [data-act=toggle]');
    await until('the details', async () => (await phones[0].$eval('.vd-body', (e) => e.textContent!)).includes('AI noise removal on'), 8000);
    expect(await phones[0].evaluate('window.__csp')).toEqual([]);
  });

  it('nothing is sent during silence or steady fan noise, only while the voice talks', async () => {
    // Sample alice's sent packets four times a second over one loop of the microphone file (~21 s).
    const series: number[] = [];
    for (let i = 0; i < 90; i++, await sleep(250)) series.push((await sfuStats(phones[0]))!.sent);
    const steps = series.slice(1).map((v, i) => v - series[i]);
    let quiet = 0;
    let longestQuiet = 0;
    for (const s of steps) {
      quiet = s === 0 ? quiet + 1 : 0;
      longestQuiet = Math.max(longestQuiet, quiet);
    }
    const sent = series.at(-1)! - series[0];
    // 4 s of silence + 5 s of fan noise per loop: about 9 s with no packets at all. (The moment
    // a loud noise starts can let a fraction of a second through before RNNoise settles.)
    const quietSec = steps.filter((x) => x === 0).length / 4;
    const detail = `per 250 ms: ${steps.join(' ')}`;
    expect(quietSec, `seconds without a packet; ${detail}`).toBeGreaterThanOrEqual(7);
    expect(longestQuiet / 4, `longest quiet stretch; ${detail}`).toBeGreaterThanOrEqual(3.5);
    // …and talking still gets through: well above zero, well below "always on" (50 packets a second).
    expect(sent).toBeGreaterThan(150);
    expect(sent).toBeLessThan(0.75 * 50 * 22);
  }, 40_000);

  it("rings radiate from alice on bob's screen while she talks, and stop when she is quiet", async () => {
    const aliceId = t.server.ctx.lobbies.all()[0].hostId;
    const ring = `.seat-token[data-talk="${aliceId}"]`;
    const seen = { talking: false, still: false };
    for (let i = 0; i < 100 && !(seen.talking && seen.still); i++, await sleep(200)) {
      const on = await phones[1].$eval(ring, (e) => e.classList.contains('talking'));
      if (on) {
        seen.talking = true;
        await shot(phones[1], 'voice-talking');
      } else if (seen.talking) seen.still = true;
    }
    expect(seen).toEqual({ talking: true, still: true });
    expect(t.errors).toEqual([]);
  }, 30_000);
});

describe.skipIf(!CHROME || !BUILT || !WAV)('voice chat for a full lobby of 8', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];

  beforeAll(async () => {
    t = await setup({ chromeArgs: [`--use-file-for-fake-audio-capture=${WAV}`], onPage: watchPcs });
    phones = await t.lobby(['alice', 'bob', 'carol', 'dave']);
    for (const name of ['erin', 'frank', 'grace', 'heidi']) {
      const p = await t.phone(name);
      await p.waitForSelector('.lobby-card');
      await tap(p, '.lobby-card');
      await p.waitForSelector('.modal input');
      await p.type('.modal input', 'pw');
      await p.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent!.includes('Watch')) as HTMLElement).click());
      await p.waitForSelector('.screen-lobby');
      phones.push(p);
    }
  }, 120_000);
  afterAll(() => t?.close());

  it('4 seated and 4 watching: all 8 on the voice server, each hearing the other 7', async () => {
    const lobby = t.server.ctx.lobbies.all()[0];
    expect([lobby.members.length, lobby.spectators.length]).toEqual([4, 4]);
    await until('all 8 on the voice server', () => t.server.ctx.voice.state(lobby.id).participants.filter((p) => p.sfu).length === 8, 30_000);
    // Everyone talks (the same voice file): each phone receives from the 7 others.
    await until('voice reaching everyone', async () => {
      for (const p of phones) if (((await sfuStats(p))?.got ?? 0) < 7 * 20) return false;
      return true;
    }, 40_000);
    for (const p of phones) expect((await sfuStats(p))!.direct).toBe(0);
    await until('panels say all 7', async () => (await phones[4].$eval('#lobby-voice', (e) => e.textContent!)).includes('all 7 players'), 10_000);
    expect(t.errors).toEqual([]);
  }, 120_000);
});

describe.skipIf(!CHROME || !BUILT || !WAV)('voice chat without the voice server', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];
  beforeAll(async () => {
    t = await setup({
      chromeArgs: [`--use-file-for-fake-audio-capture=${WAV}`],
      onPage: watchPcs,
      config: { voice: { iceServers: [], sfu: { enabled: false, portMin: 43000, portMax: 43199, announcedIp: '' } } },
    });
    phones = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('falls back to a direct link between the phones', async () => {
    await until('a direct link', async () => (await phones[0].evaluate(`window.__pcs.some((x) => x.connectionState === 'connected')`)) === true, 20_000);
    await until('the panel', async () => (await phones[0].$eval('#lobby-voice', (e) => e.textContent!)).includes('Talking with 1 player'), 8000);
  });
});
