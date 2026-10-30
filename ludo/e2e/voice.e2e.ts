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
import { MAX_VOICE_PEERS } from '../src/shared/types.js';
import { BUILT, CHROME, SHOTS, setup, shot, sleep, tap, until } from './helpers.js';
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

/** Packets sent and received on the page's voice-server connection (the one with an audio section per voice slot, plus the mic). */
const sfuStats = (p: Page) =>
  p.evaluate(`(async () => {
    const pc = window.__pcs.find((x) => x.connectionState !== 'closed' && (x.remoteDescription?.sdp.match(/^m=audio/gm) ?? []).length === ${MAX_VOICE_PEERS});
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

describe.skipIf(!CHROME || !BUILT || !WAV)('voice goes over the internet first', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];
  beforeAll(async () => {
    // Nobody qualifies for local routes (a 0 ms limit), and the announced public address is a
    // documentation address nothing answers on.
    t = await setup({
      chromeArgs: [`--use-file-for-fake-audio-capture=${WAV}`],
      onPage: watchPcs,
      config: { voice: { iceServers: [], localMaxPingMs: 0, sfu: { enabled: true, portMin: 43200, portMax: 43399, announcedIp: '203.0.113.7' } } },
    });
    phones = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('the first offer has internet routes only; voice still connects (adding local ones after 5 s if it must)', async () => {
    for (const p of phones) await until('the voice server link', async () => (await sfuStats(p))?.state === 'connected', 25_000);
    const offers = (await phones[0].evaluate(`window.__pcs.filter((x) => (x.remoteDescription?.sdp.match(/^m=audio/gm) ?? []).length === ${MAX_VOICE_PEERS}).map((x) => x.remoteDescription.sdp)`)) as string[];
    const hosts = (sdp: string) => [...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host/gm)].map((m) => m[1]);
    expect(hosts(offers[0]).filter((a) => /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a))).toEqual([]);
    expect(hosts(offers[0])).toContain('203.0.113.7');
    await tap(phones[0], '.voice-details [data-act=toggle]');
    await until('the local route line', async () => /Local network route · (not used: internet only|added: the internet route didn't connect) \(ping \d+ ms\)/.test(await phones[0].$eval('.vd-body', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '))), 8000);
    if (offers.length > 1) {
      // The fallback: the later offer brought the local network back in.
      expect(hosts(offers.at(-1)!).some((a) => /^(10|192\.168|172\.)/.test(a))).toBe(true);
      expect(await phones[0].$eval('.vd-body', (e) => e.textContent)).toContain('trying the local network too');
    }
  });
});

describe.skipIf(!CHROME || !BUILT || !WAV)('voice details and reconnecting by itself', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];
  let lobbyId: string;
  let aliceId: number;
  const recovery: Record<string, number> = {};
  const detailsText = () => phones[0].$eval('.vd-body', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));
  /** How many connections alice's page has made so far: a reconnect makes a new one. */
  const made = () => phones[0].evaluate('window.__pcs.length') as Promise<number>;
  /** Alice is on the voice server again over a new connection, and bob gets her voice through it. */
  const backWithin = async (what: string, ms: number, t0: number, before: number) => {
    const fresh = `window.__pcs.slice(${before}).some((x) => x.connectionState === 'connected' && (x.remoteDescription?.sdp.match(/^m=audio/gm) ?? []).length === ${MAX_VOICE_PEERS})`;
    await until(`${what}: back on the voice server`, async () => t.server.ctx.sfu.isConnected(lobbyId, aliceId) && (await phones[0].evaluate(fresh)) === true, ms);
    recovery[what] = Date.now() - t0;
    // Then her voice reaches bob again (once the test voice is talking: nothing is sent in its silent part).
    const got = (await sfuStats(phones[1]))?.got ?? 0;
    await until(`${what}: bob hears alice again`, async () => ((await sfuStats(phones[1]))?.got ?? 0) > got + 40, 30_000);
  };

  beforeAll(async () => {
    t = await setup({ chromeArgs: [`--use-file-for-fake-audio-capture=${WAV}`], onPage: watchPcs });
    phones = await t.lobby(['alice', 'bob']);
    const lobby = t.server.ctx.lobbies.all()[0];
    lobbyId = lobby.id;
    aliceId = lobby.hostId;
    for (const p of phones) await until('voice server', async () => (await sfuStats(p))?.state === 'connected', 15_000);
  });
  afterAll(() => t?.close());

  it('Details show the transport, both ends with ports, and the game connection', async () => {
    await tap(phones[0], '.voice-details [data-act=toggle]');
    await until('stats in the panel', async () => /round trip \d+ ms/.test(await detailsText()), 10_000);
    const text = await detailsText();
    expect(text).toContain('Game connection · WebSocket over TCP');
    expect(text, text).toMatch(/Local network route · allowed, after the internet route \(IPv4 · \d+ ms\)/);
    expect(text).toMatch(/Voice server · connected/);
    expect(text).toMatch(/UDP · you \S+:\d+ \([^)]+\) → server \S+:43\d{3} \([^)]+\)/); // the test server's voice ports
    expect(text).toMatch(/bob · via the voice server · UDP/);
    expect(text).toMatch(/Their audio: .*opus 48 kHz/);
    // Bitrates need two looks (the panel refreshes every 2 s).
    await until('the bitrates', async () => /Traffic: ↑ \d+ kbps · ↓ \d+ kbps/.test(await detailsText()), 6000);
    if (SHOTS) await (await phones[0].$('#lobby-voice'))!.screenshot({ path: join(SHOTS, 'voice-details.png') });
  });

  it('a network change (Wi-Fi ↔ mobile data) redoes voice at once', async () => {
    const [t0, before] = [Date.now(), await made()];
    await phones[0].evaluate(`navigator.connection.dispatchEvent(new Event('change'))`);
    await backWithin('network change', 10_000, t0, before);
    await until('the event in Details', async () => (await detailsText()).includes('network changed'), 5000);
  });

  it('when the voice-server link dies (its route went away), the phone reconnects it by itself', async () => {
    const [t0, before] = [Date.now(), await made()];
    t.server.ctx.sfu.drop(lobbyId, aliceId); // the server side of alice's link broke
    await backWithin('voice link lost', 20_000, t0, before);
    await until('the event in Details', async () => (await detailsText()).includes('voice server dropped the link'), 5000);
  });

  it('when the game connection drops, voice comes back with it', async () => {
    const [t0, before] = [Date.now(), await made()];
    t.server.io.in(`user:${aliceId}`).disconnectSockets(true);
    await backWithin('game connection dropped', 20_000, t0, before);
    await until('the event in Details', async () => (await detailsText()).includes('game connection back'), 5000);
    expect(t.errors).toEqual([]);
    // How long each took (ms), for the record.
    (await import('node:fs')).writeFileSync(join(tmpdir(), 'ludo-voice-recovery.json'), JSON.stringify({ ...recovery, log: (await detailsText()).replace(/.*Recent: /, '') }));
    for (const ms of Object.values(recovery)) expect(ms).toBeLessThan(6000);
  });
});
