import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { VoiceJoined, VoiceSignalIn } from '../src/shared/protocol.js';
import { DEFAULTS, mergeConfig, validateConfig } from '../src/server/config.js';
import { iceServersFor, turnLogin } from '../src/server/turn.js';
import { client, createLobby, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

const TURN = { urls: ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp'], secret: 'super-secret-123' };

describe('TURN logins', () => {
  it('uses the shared-secret scheme: "<expiry>:<id>" and HMAC-SHA1 of it', () => {
    const now = Date.UTC(2026, 9, 28);
    const login = turnLogin(TURN, 7, now);
    expect(login.urls).toEqual(TURN.urls);
    expect(login.username).toBe(`${now / 1000 + 12 * 3600}:ludo7`);
    expect(login.credential).toBe(crypto.createHmac('sha1', TURN.secret).update(login.username!).digest('base64'));
    expect(JSON.stringify(login)).not.toContain(TURN.secret);
    expect(turnLogin({ ...TURN, ttlSec: 600 }, 7, now).username).toBe(`${now / 1000 + 600}:ludo7`);
  });

  it('is added to the configured servers only when a relay is set up', () => {
    const stun = [{ urls: 'stun:stun.example:3478' }];
    expect(iceServersFor({ iceServers: stun }, 1)).toEqual(stun);
    expect(iceServersFor({ iceServers: stun, turn: TURN }, 1)).toEqual([...stun, expect.objectContaining({ urls: TURN.urls, username: expect.stringMatching(/:ludo1$/) })]);
  });

  it('config is checked', () => {
    const ok = mergeConfig(DEFAULTS, { lobbyCreatePassword: 'a-strong-one', adminPassword: 'another-strong', voice: { turn: TURN } });
    expect(validateConfig(ok)).toEqual([]);
    const bad = mergeConfig(DEFAULTS, { lobbyCreatePassword: 'a-strong-one', adminPassword: 'another-strong', voice: { turn: { urls: 'stun:x', secret: 'short' } } });
    expect(validateConfig(bad)).toEqual(expect.arrayContaining(['voice.turn.urls must be turn: or turns: URLs', 'voice.turn.secret must be at least 8 characters']));
  });
});

describe('voice over sockets with a relay and late candidates', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('each player gets their own relay login; late candidates are relayed like offers', async () => {
    t = await startTestServer({ voice: { iceServers: [], turn: TURN } });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId, password: 'pw' });
    const a = await host.emit<VoiceJoined>('voice:join', { lobbyId });
    const b = await guest.emit<VoiceJoined>('voice:join', { lobbyId });
    const ua = a.ok && a.data!.iceServers[0];
    const ub = b.ok && b.data!.iceServers[0];
    expect(ua).toMatchObject({ urls: TURN.urls, username: expect.stringMatching(new RegExp(`:ludo${host.userId}$`)) });
    expect(ub).toMatchObject({ username: expect.stringMatching(new RegExp(`:ludo${guest.userId}$`)) });

    const got = new Promise<VoiceSignalIn>((res) => guest.socket.once('voice:signal', res));
    const cands = JSON.stringify([{ candidate: 'candidate:1 1 udp 1 203.0.113.7 5000 typ srflx raddr 0.0.0.0 rport 0', sdpMid: '0', sdpMLineIndex: 0 }]);
    expect(await host.emit('voice:signal', { lobbyId, to: guest.userId, kind: 'cand', call: 5, sdp: cands })).toEqual({ ok: true });
    expect(await got).toEqual({ lobbyId, from: host.userId, kind: 'cand', call: 5, sdp: cands });
    expect(await host.emit('voice:signal', { lobbyId, to: guest.userId, kind: 'cand', call: 5, sdp: '' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });
});
