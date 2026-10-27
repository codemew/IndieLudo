import { afterEach, describe, expect, it } from 'vitest';
import { signalBars, type NetStats } from '../src/shared/net.js';
import { NetStatsTracker } from '../src/server/netStats.js';
import { client, createLobby, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

describe('signalBars', () => {
  it('maps ping to 4 / 3 / 2 / 1 bars', () => {
    const ok = [true, true, true];
    expect(signalBars(12, ok)).toBe(4);
    expect(signalBars(80, ok)).toBe(4);
    expect(signalBars(120, ok)).toBe(3);
    expect(signalBars(250, ok)).toBe(2);
    expect(signalBars(900, ok)).toBe(1);
  });

  it('each recently lost ping costs a bar, but answering keeps at least 1', () => {
    expect(signalBars(20, [true, false, true])).toBe(3);
    expect(signalBars(20, [false, true, false, true, true])).toBe(2);
    expect(signalBars(400, [false, true])).toBe(1);
  });

  it('no reply yet, or two lost in a row, is 0', () => {
    expect(signalBars(null, [])).toBe(0);
    expect(signalBars(20, [true, false, false])).toBe(0);
  });
});

describe('NetStatsTracker', () => {
  it('smooths pings, forgets closed sockets, and picks a player\'s best connection', () => {
    const t = new NetStatsTracker();
    t.add('a', 1);
    expect(t.forUser(1)).toEqual({ userId: 1, pingMs: null, bars: 0 });
    t.record('a', 100);
    t.record('a', 20); // one fast sample only pulls the average part way
    expect(t.forUser(1)).toEqual({ userId: 1, pingMs: 68, bars: 4 });
    t.add('b', 1); // a second tab that never answers
    t.record('b', null);
    expect(t.forUser(1).pingMs).toBe(68);
    t.remove('a');
    expect(t.forUser(1)).toEqual({ userId: 1, pingMs: null, bars: 0 });
    expect(t.forUser(2)).toEqual({ userId: 2, pingMs: null, bars: 0 });
  });
});

describe('ping over sockets', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the server times each lobby member and tells the lobby; a phone that stops answering drops to 0 bars', async () => {
    t = await startTestServer({}, { netIntervalMs: 100 });
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    const carol = await client(t, 'carol'); // not in the lobby: never pinged, never told
    clients.push(alice, bob, carol);
    alice.socket.on('net:ping', (ack: () => void) => ack());
    bob.socket.on('net:ping', (ack: () => void) => ack());
    let carolPinged = false;
    carol.socket.on('net:ping', (ack: () => void) => ((carolPinged = true), ack()));
    const carolStats: NetStats[] = [];
    carol.socket.on('net:stats', (s: NetStats) => carolStats.push(s));

    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    const next = (pred: (s: NetStats) => boolean) =>
      new Promise<NetStats>((res) => {
        const fn = (s: NetStats) => pred(s) && (alice.socket.off('net:stats', fn), res(s));
        alice.socket.on('net:stats', fn);
      });

    const healthy = await next((s) => s.players.length === 2 && s.players.every((p) => p.bars === 4));
    expect(healthy.lobbyId).toBe(lobbyId);
    for (const p of healthy.players) expect(p.pingMs).toBeGreaterThanOrEqual(0);

    // Bob's phone stops answering (but stays connected).
    bob.socket.off('net:ping');
    const lost = await next((s) => s.players.find((p) => p.userId === bob.userId)!.bars === 0);
    expect(lost.players.find((p) => p.userId === alice.userId)!.bars).toBe(4);
    expect(carolPinged).toBe(false);
    expect(carolStats).toEqual([]);
  });
});
