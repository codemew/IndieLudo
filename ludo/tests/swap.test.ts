import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/server/db.js';
import { LobbyManager } from '../src/server/lobbies.js';
import { SWAP_REQUEST_MS, type Color, type SwapEnd, type SwapRequest } from '../src/shared/types.js';
import { client, createLobby, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

const alice = { id: 1, username: 'alice' };
const bob = { id: 2, username: 'bob' };
const carol = { id: 3, username: 'carol' };

describe('colour swaps in the lobby', () => {
  let lm: LobbyManager;
  let ended: [SwapRequest, SwapEnd][];
  let lobbyId: string;
  const colorOf = (id: number) => lm.get(lobbyId)!.members.find((m) => m.userId === id)?.color;

  beforeEach(() => {
    vi.useFakeTimers();
    ended = [];
    lm = new LobbyManager({ db: openDb(':memory:'), lobbyCreatePassword: 'secret', maxLobbies: 9, lobbyIdleCloseSec: 600, onSwapEnded: (r, how) => ended.push([r, how]) });
    lobbyId = lm.create(alice, { createPassword: 'secret', name: 'Room', password: 'pw' }).id;
    lm.join(bob, lobbyId, 'pw');
    lm.join(carol, lobbyId, 'pw');
  });
  afterEach(() => vi.useRealTimers());

  it('asking waits for an answer; accepting swaps both colours, nothing else changes', () => {
    const [a, b] = [colorOf(1)!, colorOf(2)!];
    lm.setReady(2, true);
    const r = lm.askSwap(1, b);
    expect(r).toMatchObject({ swapped: false, req: { from: 1, to: 2, fromColor: a, toColor: b, fromName: 'alice' } });
    expect([colorOf(1), colorOf(2)]).toEqual([a, b]); // not yet
    lm.answerSwap(2, 1, true);
    expect([colorOf(1), colorOf(2)]).toEqual([b, a]);
    expect(lm.get(lobbyId)!.members.find((m) => m.userId === 2)!.ready).toBe(true);
    expect(ended.map(([, how]) => how)).toEqual(['accepted']);
    expect(() => lm.answerSwap(2, 1, true)).toThrow('SWAP_EXPIRED'); // answered already
  });

  it('declining, cancelling and the timeout leave the colours alone', () => {
    const [a, b, c] = [colorOf(1)!, colorOf(2)!, colorOf(3)!];
    lm.askSwap(1, b);
    lm.answerSwap(2, 1, false);
    lm.askSwap(1, c);
    lm.cancelSwap(1);
    expect(() => lm.answerSwap(3, 1, true)).toThrow('SWAP_EXPIRED');
    lm.askSwap(1, b);
    vi.advanceTimersByTime(SWAP_REQUEST_MS + 1);
    expect(() => lm.answerSwap(2, 1, true)).toThrow('SWAP_EXPIRED');
    expect([colorOf(1), colorOf(2), colorOf(3)]).toEqual([a, b, c]);
    expect(ended.map(([, how]) => how)).toEqual(['declined', 'cancelled', 'expired']);
  });

  it('only the asked player can answer, and a new request replaces your old one', () => {
    lm.askSwap(1, colorOf(2)!);
    expect(() => lm.answerSwap(3, 1, true)).toThrow('SWAP_EXPIRED');
    lm.askSwap(1, colorOf(3)!);
    expect(ended.map(([r, how]) => [r.to, how])).toEqual([[2, 'cancelled']]);
    expect(lm.pendingSwaps(lobbyId).map((r) => r.to)).toEqual([3]);
  });

  it('asking someone who is already asking you swaps at once', () => {
    const [a, b] = [colorOf(1)!, colorOf(2)!];
    lm.askSwap(2, a);
    expect(lm.askSwap(1, b)).toMatchObject({ swapped: true });
    expect([colorOf(1), colorOf(2)]).toEqual([b, a]);
    expect(lm.pendingSwaps(lobbyId)).toEqual([]);
  });

  it('a bot swaps at once; empty seats and your own seat are refused', () => {
    lm.leave(3);
    lm.addBot(1);
    const bot = lm.get(lobbyId)!.members.find((m) => m.isBot)!;
    const botColor = bot.color;
    const mine = colorOf(2)!;
    expect(lm.askSwap(2, botColor)).toMatchObject({ swapped: true });
    expect(colorOf(2)).toBe(botColor);
    expect(bot.color).toBe(mine);
    const free = (['red', 'green', 'yellow', 'blue'] as Color[]).find((c) => !lm.get(lobbyId)!.members.some((m) => m.color === c))!;
    expect(() => lm.askSwap(2, free)).toThrow('SEAT_EMPTY');
    expect(() => lm.askSwap(2, colorOf(2)!)).toThrow('SAME_SEAT');
  });

  it('requests end when a player leaves, moves to an open seat, or the game starts; stale colours are refused', () => {
    lm.askSwap(1, colorOf(2)!);
    lm.leave(2);
    expect(ended.at(-1)![1]).toBe('cancelled');

    lm.join(bob, lobbyId, 'pw');
    lm.askSwap(1, colorOf(3)!);
    const free = (['red', 'green', 'yellow', 'blue'] as Color[]).find((c) => !lm.get(lobbyId)!.members.some((m) => m.color === c))!;
    lm.setColor(3, free); // carol moves: the request was about her old colour
    expect(() => lm.answerSwap(3, 1, true)).toThrow('SWAP_EXPIRED');

    lm.askSwap(1, colorOf(3)!);
    lm.markPlaying(lobbyId, 'g1');
    expect(() => lm.answerSwap(3, 1, true)).toThrow('SWAP_EXPIRED');
    expect(() => lm.askSwap(1, colorOf(2)!)).toThrow('GAME_IN_PROGRESS');
  });
});

describe('colour swaps over sockets', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the asked player gets the request, both hear how it ended, everyone sees the new colours', async () => {
    t = await startTestServer();
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId, password: 'pw' });
    await wait(30);
    const before = host.lobbyStates.at(-1)!.members.map((m) => [m.username, m.color]);
    const [aliceColor, bobColor] = before.map(([, c]) => c as Color);

    const asked = new Promise<SwapRequest>((res) => guest.socket.once('lobby:swapRequest', res));
    expect(await host.emit('lobby:swapAsk', { color: bobColor })).toEqual({ ok: true, data: { swapped: false } });
    expect(await asked).toMatchObject({ from: host.userId, to: guest.userId, fromColor: aliceColor, toColor: bobColor, fromName: 'alice' });

    const hostHears = new Promise((res) => host.socket.once('lobby:swapEnded', res));
    const guestHears = new Promise((res) => guest.socket.once('lobby:swapEnded', res));
    expect(await guest.emit('lobby:swapAnswer', { from: host.userId, accept: true })).toEqual({ ok: true });
    expect(await hostHears).toEqual({ from: host.userId, to: guest.userId, how: 'accepted' });
    expect(await guestHears).toEqual({ from: host.userId, to: guest.userId, how: 'accepted' });
    await wait(30);
    expect(guest.lobbyStates.at(-1)!.members.map((m) => [m.username, m.color])).toEqual([
      ['alice', bobColor],
      ['bob', aliceColor],
    ]);
    // Asking again and cancelling: the other player is told, and can no longer accept.
    const asked2 = new Promise<SwapRequest>((res) => guest.socket.once('lobby:swapRequest', res));
    expect(await host.emit('lobby:swapAsk', { color: aliceColor })).toEqual({ ok: true, data: { swapped: false } });
    await asked2;
    const cancelled = new Promise((res) => guest.socket.once('lobby:swapEnded', res));
    expect(await host.emit('lobby:swapCancel', {})).toEqual({ ok: true });
    expect(await cancelled).toEqual({ from: host.userId, to: guest.userId, how: 'cancelled' });
    expect(await guest.emit('lobby:swapAnswer', { from: host.userId, accept: true })).toEqual({ ok: false, error: 'SWAP_EXPIRED' });
    // Nobody can answer for someone else, or forge a payload.
    expect(await host.emit('lobby:swapAnswer', { from: guest.userId, accept: true })).toEqual({ ok: false, error: 'SWAP_EXPIRED' });
    expect(await host.emit('lobby:swapAsk', { color: 'purple' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });
});

describe('bots over sockets', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('"+ Bot" on a seat puts the bot on that seat, named for it; unknown colours are refused', async () => {
    t = await startTestServer();
    const host = await client(t, 'alice');
    clients.push(host);
    await createLobby(host);
    await wait(30);
    const free = (['red', 'green', 'yellow', 'blue'] as Color[]).filter((c) => !host.lobbyStates.at(-1)!.members.some((m) => m.color === c));
    for (const color of free) expect(await host.emit('lobby:addBot', { color })).toEqual({ ok: true });
    await wait(30);
    const bots = host.lobbyStates.at(-1)!.members.filter((m) => m.isBot);
    expect(bots.map((m) => m.color).sort()).toEqual([...free].sort());
    for (const m of bots) expect(m.username).toBe(`Bot ${m.color[0].toUpperCase()}${m.color.slice(1)}`);
    expect(await host.emit('lobby:addBot', { color: 'purple' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await host.emit('lobby:addBot', { color: free[0] })).toEqual({ ok: false, error: 'LOBBY_FULL' });
  });
});
