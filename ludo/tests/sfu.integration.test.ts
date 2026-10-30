import { afterEach, describe, expect, it } from 'vitest';
import { isLocalAddress } from '../src/shared/ice.js';
import { MAX_SPECTATORS, MAX_VOICE_PEERS } from '../src/shared/types.js';
import { client, createLobby, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';
import { sfuPhone } from './sfuPhone.js';

let t: TestServer;
const clients: TestClient[] = [];
const phones: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(phones.splice(0).map((p) => p.close()));
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

const start = (ports: [number, number], enabled = true, voice: { announcedIp?: string; localMaxPingMs?: number } = {}) =>
  startTestServer({ voice: { iceServers: [], localMaxPingMs: voice.localMaxPingMs ?? 40, sfu: { enabled, portMin: ports[0], portMax: ports[1], announcedIp: voice.announcedIp ?? '' } } });

/** The candidates of an SDP: address and priority, in order. */
const candidates = (sdp: string) =>
  [...sdp.matchAll(/^a=candidate:\S+ \d+ \S+ (\d+) (\S+) \d+ typ (\S+)/gm)].map((m) => ({ priority: Number(m[1]), address: m[2], type: m[3] }));

/** A lobby with `n` people: the first 4 seated, the rest watching. */
async function lobbyOf(n: number) {
  const cs: TestClient[] = [];
  for (let i = 0; i < n; i++) cs.push(await client(t, `player${i}`));
  clients.push(...cs);
  const lobbyId = await createLobby(cs[0]);
  if (n > 4 + MAX_SPECTATORS) await cs[0].emit('lobby:size', { size: 6 });
  const seats = n > 4 + MAX_SPECTATORS ? 6 : 4;
  for (let i = 1; i < n; i++) {
    const r = await cs[i].emit('lobby:join', { lobbyId, password: 'pw', watch: i >= seats });
    if (!r.ok) throw new Error(r.error);
  }
  return { cs, lobbyId };
}

describe('the built-in voice server', () => {
  it("passes A's voice to B, on the slot that says it's A, and never back to A", async () => {
    t = await start([41000, 41039]);
    const { cs, lobbyId } = await lobbyOf(2);
    const [a, b] = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId).then((p) => (phones.push(p), p))));
    await wait(200);
    await a.talk(30);
    await wait(300);
    expect(b.heard.get(cs[0].userId)?.length).toBeGreaterThanOrEqual(28);
    expect(a.heard.size).toBe(0);
    // The channel shows who is on the voice server.
    const state = t.server.ctx.voice.state(lobbyId);
    expect(state.participants.every((p) => p.sfu)).toBe(true);
  });

  it('sends nothing on while a phone sends nothing (the voice gate keeps silence off the network)', async () => {
    t = await start([41040, 41079]);
    const { cs, lobbyId } = await lobbyOf(2);
    const [, b] = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId).then((p) => (phones.push(p), p))));
    await wait(600);
    expect(b.heard.size).toBe(0);
  });

  it('a phone that rejoins gets a fresh connection, and the others keep hearing it with no jump in sequence numbers', async () => {
    t = await start([41080, 41119]);
    const { cs, lobbyId } = await lobbyOf(2);
    const [a1, b] = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId).then((p) => (phones.push(p), p))));
    await a1.talk(10);
    await wait(200);
    const a2 = await sfuPhone(cs[0], lobbyId); // reconnect: replaces a1 on the server
    phones.push(a2);
    await wait(200);
    await a2.talk(10);
    await wait(300);
    const seqs = b.heard.get(cs[0].userId)!;
    expect(seqs.length).toBeGreaterThanOrEqual(18);
    const steps = seqs.slice(1).map((s, i) => (s - seqs[i] + 65536) % 65536);
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
  });

  it(`all ${MAX_VOICE_PEERS} people of a full lobby (6 seats + 4 watching) hear each other at once`, async () => {
    t = await start([41120, 41239]);
    const { cs, lobbyId } = await lobbyOf(MAX_VOICE_PEERS);
    const ps = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId).then((p) => (phones.push(p), p))));
    await wait(300);
    await Promise.all(ps.map((p) => p.talk(15)));
    await wait(600);
    for (const [i, p] of ps.entries()) {
      const heardFrom = [...p.heard.keys()].sort((x, y) => x - y);
      expect(heardFrom, `p${i} hears everyone else`).toEqual(cs.filter((_, j) => j !== i).map((c) => c.userId).sort((x, y) => x - y));
      for (const seqs of p.heard.values()) expect(seqs.length).toBeGreaterThanOrEqual(12);
    }
  }, 60_000);

  it('someone who leaves frees their slot on everyone else; outsiders and the switched-off server are refused', async () => {
    t = await start([41240, 41279]);
    const { cs, lobbyId } = await lobbyOf(3);
    const ps = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId).then((p) => (phones.push(p), p))));
    await cs[2].emit('voice:leave', { lobbyId });
    await wait(200);
    expect(ps[0].slots().filter((s) => s.userId !== null).map((s) => s.userId)).toEqual([cs[1].userId]);
    const [stranger] = await Promise.all([client(t, 'stranger')]);
    clients.push(stranger);
    expect(await stranger.emit('voice:sfuJoin', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
    expect(await cs[0].emit('voice:sfuAnswer', { lobbyId, sdp: 'x'.repeat(15_000) })).toEqual({ ok: false, error: 'BAD_PAYLOAD' }); // over the 14 KB a description may be
    await t.close();
    t = await start([41280, 41289], false);
    const [solo] = await Promise.all([client(t, 'solo')]);
    clients.push(solo);
    const l = await createLobby(solo);
    const joined = await solo.emit<{ sfu: boolean }>('voice:join', { lobbyId: l });
    expect(joined.ok && joined.data!.sfu).toBe(false);
    expect(await solo.emit('voice:sfuJoin', { lobbyId: l })).toEqual({ ok: false, error: 'SFU_OFF' });
  });

  describe('internet first', () => {
    it('a phone that doesn’t qualify for local routes gets none, and its own local ones are dropped', async () => {
      t = await start([41240, 41279], true, { localMaxPingMs: 0 });
      const { cs, lobbyId } = await lobbyOf(1);
      const join = await cs[0].emit<{ local: { ok: boolean; why: string } }>('voice:join', { lobbyId });
      expect(join.ok && join.data!.local).toEqual({ ok: false, why: expect.stringMatching(/^ping \d+ ms$/) });
      const r = await cs[0].emit<{ sdp: string }>('voice:sfuJoin', { lobbyId });
      expect(r.ok).toBe(true);
      // Only internet routes are left (werift falls back to a public STUN server to find the router's address).
      expect(candidates(r.ok ? r.data!.sdp : '').filter((c) => isLocalAddress(c.address))).toEqual([]);
      expect(t.server.ctx.sfu.allowsLocal(lobbyId, cs[0].userId)).toBe(false);
    });

    it('after the internet route failed the phone asks again with local routes, and connects', async () => {
      t = await start([41280, 41319], true, { localMaxPingMs: 0 });
      const { cs, lobbyId } = await lobbyOf(2);
      const [a, b] = await Promise.all(cs.map((c) => sfuPhone(c, lobbyId, { local: true }).then((p) => (phones.push(p), p))));
      expect(t.server.ctx.sfu.allowsLocal(lobbyId, cs[0].userId)).toBe(true);
      expect(candidates(a.offer).some((c) => isLocalAddress(c.address))).toBe(true);
      await a.talk(10);
      await wait(300);
      expect(b.heard.get(cs[0].userId)?.length).toBeGreaterThanOrEqual(8);
    });

    it('a phone on IPv4 with a low ping gets both, internet routes ranked first', async () => {
      t = await start([41320, 41359], true, { announcedIp: '203.0.113.7' });
      const { cs, lobbyId } = await lobbyOf(1);
      await cs[0].emit('voice:join', { lobbyId });
      const r = await cs[0].emit<{ sdp: string }>('voice:sfuJoin', { lobbyId });
      const list = candidates(r.ok ? r.data!.sdp : '');
      const pub = list.filter((c) => !isLocalAddress(c.address));
      const local = list.filter((c) => isLocalAddress(c.address));
      expect(pub.map((c) => c.address)).toContain('203.0.113.7');
      expect(local.length).toBeGreaterThan(0);
      expect(Math.min(...pub.map((c) => c.priority))).toBeGreaterThan(Math.max(...local.map((c) => c.priority)));
      expect(t.server.ctx.sfu.allowsLocal(lobbyId, cs[0].userId)).toBe(true);
    });

    it('without one configured, the public address is learnt from how internet phones connect', async () => {
      t = await start([41360, 41399], true, { localMaxPingMs: 0 });
      const { cs, lobbyId } = await lobbyOf(1);
      t.server.ctx.sfu.learnPublicAddress('192.168.1.1'); // a local address: ignored
      expect(t.server.ctx.sfu.publicAddress).toBeNull();
      t.server.ctx.sfu.learnPublicAddress('198.51.100.9');
      expect(t.server.ctx.sfu.publicAddress).toBe('198.51.100.9');
      await cs[0].emit('voice:join', { lobbyId });
      const r = await cs[0].emit<{ sdp: string }>('voice:sfuJoin', { lobbyId });
      const list = candidates(r.ok ? r.data!.sdp : '');
      expect(list.map((c) => c.address)).toContain('198.51.100.9');
      expect(list.filter((c) => isLocalAddress(c.address))).toEqual([]);
    });
  });
});
