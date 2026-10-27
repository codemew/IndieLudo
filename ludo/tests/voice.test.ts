import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceJoined, VoiceSignalIn } from '../src/shared/protocol.js';
import { HOME } from '../src/shared/board.js';
import type { VoiceState } from '../src/shared/types.js';
import { VoiceManager } from '../src/server/voice.js';
import { scriptedDice } from './helpers.js';
import { client, startTestServer, startTwoPlayerGame, wait, type TestClient, type TestServer } from './serverHelpers.js';

describe('VoiceManager', () => {
  const players = new Set([1, 2]);
  const make = () => {
    const onChange = vi.fn<(s: VoiceState) => void>();
    const vm = new VoiceManager({ isPlayer: (g, u) => g === 'g1' && players.has(u), onChange });
    return { vm, onChange };
  };

  it('only players of the game can join; bots and strangers cannot', () => {
    const { vm } = make();
    expect(vm.join('g1', 1, 's1').participants).toEqual([{ userId: 1, muted: false }]);
    expect(() => vm.join('g1', 3, 's3')).toThrow('NOT_IN_GAME');
    expect(() => vm.join('other', 1, 's1')).toThrow('NOT_IN_GAME');
    expect(() => vm.stateFor('g1', 3)).toThrow('NOT_IN_GAME');
  });

  it('tracks mute state and broadcasts every change', () => {
    const { vm, onChange } = make();
    vm.join('g1', 1, 's1');
    vm.join('g1', 2, 's2');
    vm.setMuted('g1', 2, true);
    expect(vm.state('g1').participants).toEqual([
      { userId: 1, muted: false },
      { userId: 2, muted: true },
    ]);
    expect(onChange).toHaveBeenCalledTimes(3);
    vm.setMuted('g1', 2, true); // no change, no broadcast
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(() => vm.setMuted('g1', 9, true)).toThrow('NOT_IN_VOICE');
  });

  it('quality: 16/32/48/64 kbps only, any player may change it, joined or not', () => {
    const { vm } = make();
    expect(vm.state('g1').bitrateKbps).toBe(32);
    vm.setBitrate('g1', 2, 64);
    expect(vm.state('g1').bitrateKbps).toBe(64);
    for (const bad of [8, 24, 40, 80, 0]) expect(() => vm.setBitrate('g1', 1, bad)).toThrow('INVALID_BITRATE');
    expect(() => vm.setBitrate('g1', 3, 16)).toThrow('NOT_IN_GAME');
    vm.join('g1', 1, 's1');
    vm.leave('g1', 1);
    expect(vm.state('g1').bitrateKbps).toBe(64);
  });

  it('relays only between members of the same channel', () => {
    const { vm } = make();
    vm.join('g1', 1, 's1');
    expect(() => vm.relayTarget('g1', 1, 2)).toThrow('NOT_IN_VOICE');
    vm.join('g1', 2, 's2');
    expect(vm.relayTarget('g1', 1, 2)).toBe('s2');
    expect(vm.relayTarget('g1', 2, 1)).toBe('s1');
    expect(() => vm.relayTarget('g1', 1, 1)).toThrow('NOT_IN_VOICE');
    expect(() => vm.relayTarget('g1', 3, 1)).toThrow('NOT_IN_VOICE');
  });

  it('a dropped socket leaves the channel; a newer socket of the same user is kept', () => {
    const { vm } = make();
    vm.join('g1', 1, 'old');
    vm.join('g1', 1, 'new');
    vm.dropSocket('old');
    expect(vm.state('g1').participants).toEqual([{ userId: 1, muted: false }]);
    vm.dropSocket('new');
    expect(vm.state('g1').participants).toEqual([]);
  });

  it('closing a game empties its channel and tells everyone', () => {
    const { vm, onChange } = make();
    vm.join('g1', 1, 's1');
    vm.close('g1');
    expect(onChange).toHaveBeenLastCalledWith({ gameId: 'g1', bitrateKbps: 32, participants: [] });
  });

  it('rejoining keeps your mute state', () => {
    const { vm } = make();
    vm.join('g1', 1, 's1');
    vm.setMuted('g1', 1, true);
    vm.join('g1', 1, 's2');
    expect(vm.state('g1').participants).toEqual([{ userId: 1, muted: true }]);
  });
});

describe('voice chat over sockets', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  async function game(over = {}) {
    t = await startTestServer(over, { dice: scriptedDice(Array(50).fill(1)) });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const gameId = await startTwoPlayerGame(host, guest);
    return { host, guest, gameId };
  }

  const nextVoice = (c: TestClient, pred: (s: VoiceState) => boolean) =>
    new Promise<VoiceState>((res) => {
      const fn = (s: VoiceState) => pred(s) && (c.socket.off('voice:state', fn), res(s));
      c.socket.on('voice:state', fn);
    });

  it('join, see each other, mute, change quality, relay offers and leave', async () => {
    const { host, guest, gameId } = await game({ voice: { iceServers: [{ urls: 'stun:example.test:3478' }] } });

    // Bob is not in voice but still sees who is.
    const bobSeesAlice = nextVoice(guest, (s) => s.participants.length === 1);
    const joined = await host.emit<VoiceJoined>('voice:join', { gameId });
    expect(joined).toEqual({
      ok: true,
      data: { state: { gameId, bitrateKbps: 32, participants: [{ userId: host.userId, muted: false }] }, iceServers: [{ urls: 'stun:example.test:3478' }] },
    });
    expect((await bobSeesAlice).participants).toEqual([{ userId: host.userId, muted: false }]);

    expect((await guest.emit<VoiceJoined>('voice:join', { gameId })).ok).toBe(true);

    // Offer from Bob (the newcomer) reaches Alice's socket only, tagged with Bob's id.
    const aliceGetsOffer = new Promise<VoiceSignalIn>((res) => host.socket.once('voice:signal', res));
    expect(await guest.emit('voice:signal', { gameId, to: host.userId, kind: 'offer', sdp: 'v=0 fake' })).toEqual({ ok: true });
    expect(await aliceGetsOffer).toEqual({ gameId, from: guest.userId, kind: 'offer', sdp: 'v=0 fake' });

    const muted = nextVoice(host, (s) => s.participants.some((p) => p.userId === guest.userId && p.muted));
    expect(await guest.emit('voice:mute', { gameId, muted: true })).toEqual({ ok: true });
    await muted;

    const hq = nextVoice(guest, (s) => s.bitrateKbps === 64);
    expect(await host.emit('voice:bitrate', { gameId, kbps: 64 })).toEqual({ ok: true });
    await hq;
    expect(await host.emit('voice:bitrate', { gameId, kbps: 80 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await host.emit('voice:bitrate', { gameId, kbps: 20 })).toEqual({ ok: false, error: 'INVALID_BITRATE' });
    expect(await host.emit('voice:bitrate', { gameId, kbps: 48 })).toEqual({ ok: true });
    expect(await host.emit('voice:bitrate', { gameId, kbps: 40 })).toEqual({ ok: false, error: 'INVALID_BITRATE' });

    const left = nextVoice(host, (s) => s.participants.length === 1);
    expect(await guest.emit('voice:leave', { gameId })).toEqual({ ok: true });
    expect((await left).participants).toEqual([{ userId: host.userId, muted: false }]);
    expect(await guest.emit('voice:signal', { gameId, to: host.userId, kind: 'offer', sdp: 'x' })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
  });

  it('strangers, bad signal kinds and oversized SDPs are rejected', async () => {
    const { host, guest, gameId } = await game();
    const stranger = await client(t, 'mallory');
    clients.push(stranger);
    expect(await stranger.emit('voice:join', { gameId })).toEqual({ ok: false, error: 'NOT_IN_GAME' });
    expect(await stranger.emit('voice:get', { gameId })).toEqual({ ok: false, error: 'NOT_IN_GAME' });
    expect(await stranger.emit('voice:bitrate', { gameId, kbps: 16 })).toEqual({ ok: false, error: 'NOT_IN_GAME' });
    await host.emit('voice:join', { gameId });
    await guest.emit('voice:join', { gameId });
    expect(await stranger.emit('voice:signal', { gameId, to: host.userId, kind: 'offer', sdp: 'x' })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
    expect(await guest.emit('voice:signal', { gameId, to: host.userId, kind: 'hijack', sdp: 'x' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:signal', { gameId, to: host.userId, kind: 'offer', sdp: 'x'.repeat(12_001) })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:mute', { gameId, muted: 'yes' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });

  it('a player who disconnects drops out of the channel', async () => {
    const { host, guest, gameId } = await game();
    await host.emit('voice:join', { gameId });
    await guest.emit('voice:join', { gameId });
    const gone = nextVoice(host, (s) => s.participants.length === 1);
    guest.close();
    expect((await gone).participants.map((p) => p.userId)).toEqual([host.userId]);
  });

  it('leaving the game for good leaves voice; the game ending closes the channel', async () => {
    const { host, guest, gameId } = await game();
    await host.emit('voice:join', { gameId });
    await guest.emit('voice:join', { gameId });
    const bobLeft = nextVoice(host, (s) => s.participants.length === 1);
    await guest.emit('lobby:leave', {});
    await bobLeft;
    // Bob's seat is a bot now: it can't rejoin.
    expect(await guest.emit('voice:join', { gameId })).toEqual({ ok: false, error: 'NOT_IN_GAME' });

    const s = t.server.ctx.games.get(gameId)!;
    s.tokens.red = [HOME, HOME, HOME, 55];
    const closed = nextVoice(host, (v) => v.participants.length === 0);
    await wait(20);
    const st = t.server.ctx.games.get(gameId)!;
    if (st.turn.seat !== 0) throw new Error('expected red to move');
    await host.emit('game:roll', { gameId, version: st.version, actionId: crypto.randomUUID() });
    await host.emit('game:move', { gameId, version: st.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 3 });
    expect(t.server.ctx.games.get(gameId)!.finished).toBe(true);
    await closed;
  });
});
