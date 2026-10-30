/**
 * Edges of the server: voice routes behind a proxy and the public address it learns, late
 * candidates on the voice server, its error replies, and the voice settings from the environment.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { DEFAULTS, loadConfig, mergeConfig, validateConfig } from '../src/server/config.js';
import { VoiceServer } from '../src/server/sfu.js';
import { publicHostAddress } from '../src/server/socket.js';
import { client, createLobby, signup, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

describe('voice routes behind a proxy', () => {
  it('the forwarded address decides IPv4 or IPv6, and an internet phone teaches the server its public address', async () => {
    t = await startTestServer({ trustProxy: true, voice: { iceServers: [], localMaxPingMs: 40, sfu: { enabled: true, portMin: 41500, portMax: 41539, announcedIp: '' } } });
    const { token } = await signup(t, 'jio');
    const socket = ioClient(t.base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { 'x-forwarded-for': '2409:4060::1, 10.0.0.1', host: '198.51.100.20:3443' } } as any);
    socket.on('net:ping', (ack: () => void) => ack());
    await new Promise((r) => socket.once('hello', r));
    const ack = (ev: string, p: unknown) => socket.timeout(4000).emitWithAck(ev, p);
    const lobbyId = (await ack('lobby:create', { createPassword: 'create-pw', name: 'J', password: 'pw' })).data.id;
    const joined = await ack('voice:join', { lobbyId });
    expect(joined.data.local).toEqual({ ok: false, why: 'IPv6' });
    await wait(50);
    expect(t.server.ctx.sfu.publicAddress).toBe('198.51.100.20');
    socket.close();
  });

  it('the default resolver: a name that resolves to a local address is not a public one', async () => {
    expect(await publicHostAddress('localhost:3000')).toBeNull();
    expect(await publicHostAddress('no-such-host.invalid')).toBeNull();
  });
});

describe('the voice server over the socket', () => {
  it('refuses outsiders and bad candidate lists; filters late local candidates for internet-only phones', async () => {
    t = await startTestServer({ voice: { iceServers: [{ urls: ['turn:127.0.0.1:9'] }], localMaxPingMs: 0, sfu: { enabled: true, portMin: 41540, portMax: 41579, announcedIp: '' } } });
    const a = await client(t, 'alice');
    clients.push(a);
    const lobbyId = await createLobby(a);
    expect(await a.emit('voice:sfuJoin', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
    expect(await a.emit('voice:sfuJoin', { lobbyId, local: 'yes' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    await a.emit('voice:join', { lobbyId });
    expect(await a.emit('voice:sfuAnswer', { lobbyId, sdp: 'v=0' })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
    const offer = await a.emit<{ sdp: string }>('voice:sfuJoin', { lobbyId });
    expect(offer.ok).toBe(true);
    expect(await a.emit('voice:sfuCand', { lobbyId, sdp: 'not json' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await a.emit('voice:sfuCand', { lobbyId, sdp: JSON.stringify(Array(21).fill({ candidate: 'x' })) })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    // Before an answer, late candidates are simply ignored.
    expect(await a.emit('voice:sfuCand', { lobbyId, sdp: JSON.stringify([{ candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host' }]) })).toEqual({ ok: true });
    const sfu = t.server.ctx.sfu;
    expect(sfu.allowsLocal(lobbyId, a.userId)).toBe(false);
    expect(sfu.allowsLocal(lobbyId, 999)).toBe(false);
  });

  it('turned off: phones are told so and use direct links', async () => {
    t = await startTestServer({ voice: { iceServers: [], localMaxPingMs: 40, sfu: { enabled: false, portMin: 41580, portMax: 41590, announcedIp: '' } } });
    const a = await client(t, 'alice');
    clients.push(a);
    const lobbyId = await createLobby(a);
    await a.emit('voice:join', { lobbyId });
    expect(await a.emit('voice:sfuJoin', { lobbyId })).toEqual({ ok: false, error: 'SFU_OFF' });
  });
});

describe('the voice server on its own', () => {
  it('late candidates: local ones dropped for an internet-only phone, the rest ranked; leaving and closing', async () => {
    const gone: number[] = [];
    const vs = new VoiceServer({ config: { enabled: true, portMin: 41600, portMax: 41639, announcedIp: '' }, iceServers: [], onGone: (_l, u) => gone.push(u) });
    const { sdp } = await vs.join('L', 1);
    const added: string[] = [];
    const member = (vs as any).rooms.get('L').get(1);
    Object.defineProperty(member.pc, 'remoteDescription', { value: { sdp: 'x' }, configurable: true });
    member.pc.addIceCandidate = async (c: { candidate: string }) => void added.push(c.candidate);
    await vs.candidate('L', 1, { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 5000 typ host' });
    await vs.candidate('L', 1, { candidate: 'candidate:2 1 udp 1686052607 203.0.113.9 5001 typ srflx raddr 192.168.1.5 rport 5000' });
    expect(added).toEqual([expect.stringMatching(/^candidate:2 1 udp \d+ 203\.0\.113\.9 5001 typ srflx raddr 0\.0\.0\.0 rport 0$/)]);
    expect(sdp).toContain('m=audio');
    await expect(vs.answer('L', 2, 'v=0')).rejects.toMatchObject({ code: 'NOT_IN_VOICE' });
    Object.defineProperty(member.pc, 'signalingState', { value: 'stable', configurable: true });
    await expect(vs.answer('L', 1, 'v=0')).rejects.toMatchObject({ code: 'SFU_STATE' });
    vs.drop('L', 1);
    vs.drop('L', 1); // already gone: nothing
    expect(gone).toEqual([1]);
    await vs.join('L', 2);
    vs.sync('L', []);
    expect(vs.isConnected('L', 2)).toBe(false);
    vs.sync('nope', []);
    await vs.join('M', 3);
    vs.shutdown();
    const off = new VoiceServer({ config: { enabled: false, portMin: 41640, portMax: 41641, announcedIp: '' } });
    await expect(off.join('L', 1)).rejects.toMatchObject({ code: 'SFU_OFF' });
  });
});

describe('voice settings from the environment', () => {
  const KEYS = ['LUDO_CONFIG', 'LUDO_VOICE_SFU', 'LUDO_VOICE_PORTS', 'LUDO_VOICE_IP', 'LUDO_VOICE_LOCAL_PING_MS', 'LUDO_LOBBY_CREATE_PASSWORD', 'LUDO_ADMIN_PASSWORD'];
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('ports, address, on/off and the local-route ping limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludo-env-'));
    const cwd = process.cwd();
    process.chdir(dir);
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { LUDO_CONFIG: 'none.json', LUDO_LOBBY_CREATE_PASSWORD: 'a', LUDO_ADMIN_PASSWORD: 'b', LUDO_VOICE_SFU: '0', LUDO_VOICE_PORTS: '45000 - 45010', LUDO_VOICE_IP: ' 203.0.113.7 ', LUDO_VOICE_LOCAL_PING_MS: '25' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = loadConfig();
      expect(c.voice.sfu).toEqual({ enabled: false, portMin: 45000, portMax: 45010, announcedIp: '203.0.113.7' });
      expect(c.voice.localMaxPingMs).toBe(25);
      process.env.LUDO_VOICE_PORTS = '46000';
      expect(loadConfig().voice.sfu).toMatchObject({ portMin: 46000, portMax: 46000 });
    } finally {
      warn.mockRestore();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bad ping limit or address is refused', () => {
    const bad = mergeConfig(DEFAULTS, { lobbyCreatePassword: 'a', adminPassword: 'b', voice: { iceServers: [], localMaxPingMs: -1, sfu: { enabled: true, portMin: 40000, portMax: 40099, announcedIp: 'not an ip' } } });
    expect(validateConfig(bad)).toEqual(['voice.localMaxPingMs must be a non-negative number of milliseconds', 'voice.sfu.announcedIp must be an IP address']);
  });
});
