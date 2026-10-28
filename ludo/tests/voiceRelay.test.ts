import { afterEach, describe, expect, it } from 'vitest';
import type { VoiceFramesIn } from '../src/shared/protocol.js';
import { client, createLobby, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

describe('voice through the game server', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  async function three() {
    t = await startTestServer();
    const [a, b, c] = await Promise.all(['alice', 'bob', 'carol'].map((n) => client(t, n)));
    clients.push(a, b, c);
    const lobbyId = await createLobby(a);
    await b.emit('lobby:join', { lobbyId, password: 'pw' });
    await c.emit('lobby:join', { lobbyId, password: 'pw' });
    for (const x of [a, b, c]) await x.emit('voice:join', { lobbyId });
    return { a, b, c, lobbyId };
  }
  const inbox = (c: TestClient) => {
    const got: VoiceFramesIn[] = [];
    c.socket.on('voice:frames', (f: VoiceFramesIn) => got.push(f));
    return got;
  };
  const frame = (n: number, byte = 7) => new Uint8Array(n).fill(byte).buffer;

  it('passes Opus frames to the players named, tagged with the sender, and to nobody else', async () => {
    const { a, b, c, lobbyId } = await three();
    const toB = inbox(b), toC = inbox(c), toA = inbox(a);
    a.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: [frame(60, 1), frame(62, 2), frame(58, 3)] });
    await wait(80);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({ lobbyId, from: a.userId });
    expect(toB[0].frames.map((f) => new Uint8Array(f as ArrayBuffer)[0])).toEqual([1, 2, 3]);
    expect(toC).toEqual([]);
    expect(toA).toEqual([]);
    a.socket.emit('voice:frames', { lobbyId, to: [b.userId, c.userId], frames: [frame(60)] });
    await wait(80);
    expect([toB.length, toC.length]).toEqual([2, 1]);
  });

  it('drops frames for or from anyone outside the voice channel, and malformed or oversized ones', async () => {
    const { a, b, c, lobbyId } = await three();
    const toB = inbox(b);
    await c.emit('voice:leave', { lobbyId });
    c.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: [frame(60)] }); // left voice
    a.socket.emit('voice:frames', { lobbyId, to: [c.userId], frames: [frame(60)] }); // target left voice
    a.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: [frame(1501)] }); // too big
    a.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: Array(9).fill(frame(10)) }); // too many
    a.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: ['not audio'] });
    a.socket.emit('voice:frames', { lobbyId, to: 'everyone', frames: [frame(10)] });
    a.socket.emit('voice:frames', null);
    await wait(100);
    expect(toB).toEqual([]);
    expect(a.socket.connected).toBe(true);
  });

  it('a steady stream of frames has its own limit and never trips the game flood protection', async () => {
    const { a, b, lobbyId } = await three();
    const toB = inbox(b);
    // 2 seconds' worth at the real rate (about 17 messages a second), sent as fast as possible.
    for (let i = 0; i < 34; i++) a.socket.emit('voice:frames', { lobbyId, to: [b.userId], frames: [frame(60), frame(60), frame(60)] });
    await wait(200);
    expect(a.socket.connected).toBe(true);
    expect(toB.length).toBe(34);
    // Game actions still work afterwards (the game's own limit wasn't used up).
    expect(await a.emit('voice:mute', { lobbyId, muted: true })).toEqual({ ok: true });
  });
});
