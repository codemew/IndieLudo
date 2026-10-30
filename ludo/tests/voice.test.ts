import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceJoined, VoiceSignalIn } from '../src/shared/protocol.js';
import { HOME } from '../src/shared/board.js';
import type { VoiceState } from '../src/shared/types.js';
import { VoiceManager } from '../src/server/voice.js';
import { scriptedDice } from './helpers.js';
import { client, createLobby, startTestServer, wait, type TestClient, type TestServer } from './serverHelpers.js';

describe('VoiceManager', () => {
  const players = new Set([1, 2]);
  const make = () => {
    const onChange = vi.fn<(s: VoiceState) => void>();
    const vm = new VoiceManager({ isMember: (g, u) => g === 'g1' && players.has(u), isHost: (g, u) => g === 'g1' && u === 1, onChange });
    return { vm, onChange };
  };

  it('only members of the lobby can join; bots and strangers cannot', () => {
    const { vm } = make();
    expect(vm.join('g1', 1, 's1').participants).toEqual([{ userId: 1, muted: false }]);
    expect(() => vm.join('g1', 3, 's3')).toThrow('NOT_IN_LOBBY');
    expect(() => vm.join('other', 1, 's1')).toThrow('NOT_IN_LOBBY');
    expect(() => vm.stateFor('g1', 3)).toThrow('NOT_IN_LOBBY');
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

  it('quality: 6/12/24/48 kbps only, and only the host may change it', () => {
    const { vm } = make();
    expect(vm.state('g1').bitrateKbps).toBe(6); // the default: least mobile data
    expect(() => vm.setBitrate('g1', 2, 48)).toThrow('NOT_HOST');
    vm.setBitrate('g1', 1, 24);
    expect(vm.state('g1').bitrateKbps).toBe(24);
    for (const bad of [4, 8, 16, 32, 64, 0]) expect(() => vm.setBitrate('g1', 1, bad)).toThrow('INVALID_BITRATE');
    expect(() => vm.setBitrate('g1', 3, 16)).toThrow('NOT_IN_LOBBY');
    vm.join('g1', 1, 's1');
    vm.leave('g1', 1);
    expect(vm.state('g1').bitrateKbps).toBe(24); // the host's choice outlives members coming and going
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

  it('closing a lobby empties its channel and tells everyone', () => {
    const { vm, onChange } = make();
    vm.join('g1', 1, 's1');
    vm.close('g1');
    expect(onChange).toHaveBeenLastCalledWith({ lobbyId: 'g1', enabled: true, epoch: 0, bitrateKbps: 6, participants: [] });
  });

  it('the host can turn voice off (everyone is dropped, nobody can join) and back on', () => {
    const { vm } = make();
    vm.join('g1', 1, 's1');
    vm.join('g1', 2, 's2');
    expect(() => vm.setEnabled('g1', 2, false)).toThrow('NOT_HOST');
    vm.setEnabled('g1', 1, false);
    expect(vm.state('g1')).toMatchObject({ enabled: false, participants: [] });
    // Joining while off just reports the state.
    expect(vm.join('g1', 2, 's2')).toMatchObject({ enabled: false, participants: [] });
    expect(() => vm.relayTarget('g1', 1, 2)).toThrow('NOT_IN_VOICE');
    expect(() => vm.reboot('g1', 1)).toThrow('VOICE_DISABLED');
    vm.setEnabled('g1', 1, true);
    expect(vm.join('g1', 2, 's2')).toMatchObject({ enabled: true, participants: [{ userId: 2, muted: false }] });
  });

  it('the host can restart the channel: it empties and the epoch moves on', () => {
    const { vm, onChange } = make();
    vm.join('g1', 1, 's1');
    vm.join('g1', 2, 's2');
    vm.setBitrate('g1', 1, 48);
    expect(() => vm.reboot('g1', 2)).toThrow('NOT_HOST');
    vm.reboot('g1', 1);
    expect(onChange).toHaveBeenLastCalledWith({ lobbyId: 'g1', enabled: true, epoch: 1, bitrateKbps: 48, participants: [] });
    expect(vm.join('g1', 2, 's2')).toMatchObject({ epoch: 1, participants: [{ userId: 2, muted: false }] });
  });

  it('rejoining keeps your mute state', () => {
    const { vm } = make();
    vm.join('g1', 1, 's1');
    vm.setMuted('g1', 1, true);
    vm.join('g1', 1, 's2');
    expect(vm.state('g1').participants).toEqual([{ userId: 1, muted: true }]);
  });
});

describe('lobby voice chat over sockets', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  /** Alice hosts a lobby, Bob joins it. No game yet. */
  async function lobby(over = {}) {
    t = await startTestServer(over, { dice: scriptedDice(Array(50).fill(1)) });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    clients.push(host, guest);
    const lobbyId = await createLobby(host);
    await guest.emit('lobby:join', { lobbyId, password: 'pw' });
    return { host, guest, lobbyId };
  }

  async function startGame(host: TestClient, guest: TestClient): Promise<string> {
    await guest.emit('lobby:ready', { ready: true });
    const first = host.nextState();
    await host.emit('lobby:start', {});
    return (await first).state.id;
  }

  const nextVoice = (c: TestClient, pred: (s: VoiceState) => boolean) =>
    new Promise<VoiceState>((res) => {
      const fn = (s: VoiceState) => pred(s) && (c.socket.off('voice:state', fn), res(s));
      c.socket.on('voice:state', fn);
    });

  it('members join in the lobby, see each other, mute, change quality, relay offers and leave', async () => {
    const { host, guest, lobbyId } = await lobby({ voice: { iceServers: [{ urls: 'stun:example.test:3478' }] } });

    const bobSeesAlice = nextVoice(guest, (s) => s.participants.length === 1);
    const joined = await host.emit<VoiceJoined>('voice:join', { lobbyId });
    expect(joined).toEqual({
      ok: true,
      data: {
        state: { lobbyId, enabled: true, epoch: 0, bitrateKbps: 6, participants: [{ userId: host.userId, muted: false }] },
        iceServers: [{ urls: 'stun:example.test:3478' }],
        sfu: true,
        local: { ok: true, why: expect.stringMatching(/^IPv4 · \d+ ms$/) },
      },
    });
    expect((await bobSeesAlice).participants).toEqual([{ userId: host.userId, muted: false }]);
    expect((await guest.emit<VoiceJoined>('voice:join', { lobbyId })).ok).toBe(true);

    // Bob (higher id) rings Alice; Alice offers; Bob answers. Each reaches only its target, tagged with the sender.
    const aliceGetsRing = new Promise<VoiceSignalIn>((res) => host.socket.once('voice:signal', res));
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'ring', call: 0, sdp: '' })).toEqual({ ok: true });
    expect(await aliceGetsRing).toEqual({ lobbyId, from: guest.userId, kind: 'ring', call: 0, sdp: '' });
    const bobGetsOffer = new Promise<VoiceSignalIn>((res) => guest.socket.once('voice:signal', res));
    expect(await host.emit('voice:signal', { lobbyId, to: guest.userId, kind: 'offer', call: 7, sdp: 'v=0 fake' })).toEqual({ ok: true });
    expect(await bobGetsOffer).toEqual({ lobbyId, from: host.userId, kind: 'offer', call: 7, sdp: 'v=0 fake' });
    const aliceGetsAnswer = new Promise<VoiceSignalIn>((res) => host.socket.once('voice:signal', res));
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'answer', call: 7, sdp: 'v=0 ans' })).toEqual({ ok: true });
    expect(await aliceGetsAnswer).toMatchObject({ kind: 'answer', call: 7 });

    const muted = nextVoice(host, (s) => s.participants.some((p) => p.userId === guest.userId && p.muted));
    expect(await guest.emit('voice:mute', { lobbyId, muted: true })).toEqual({ ok: true });
    await muted;

    const hq = nextVoice(guest, (s) => s.bitrateKbps === 24);
    expect(await host.emit('voice:bitrate', { lobbyId, kbps: 24 })).toEqual({ ok: true });
    await hq;
    expect(await host.emit('voice:bitrate', { lobbyId, kbps: 64 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await host.emit('voice:bitrate', { lobbyId, kbps: 20 })).toEqual({ ok: false, error: 'INVALID_BITRATE' });
    expect(await guest.emit('voice:bitrate', { lobbyId, kbps: 12 })).toEqual({ ok: false, error: 'NOT_HOST' });

    const left = nextVoice(host, (s) => s.participants.length === 1);
    expect(await guest.emit('voice:leave', { lobbyId })).toEqual({ ok: true });
    expect((await left).participants).toEqual([{ userId: host.userId, muted: false }]);
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'offer', call: 1, sdp: 'x' })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
  });

  it('only the host can restart the channel or turn it off; everyone sees it', async () => {
    const { host, guest, lobbyId } = await lobby();
    await host.emit('voice:join', { lobbyId });
    await guest.emit('voice:join', { lobbyId });
    expect(await guest.emit('voice:reboot', { lobbyId })).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(await guest.emit('voice:enabled', { lobbyId, enabled: false })).toEqual({ ok: false, error: 'NOT_HOST' });

    const rebooted = nextVoice(guest, (s) => s.epoch === 1);
    expect(await host.emit('voice:reboot', { lobbyId })).toEqual({ ok: true });
    expect((await rebooted).participants).toEqual([]);

    await guest.emit('voice:join', { lobbyId });
    const off = nextVoice(guest, (s) => !s.enabled);
    expect(await host.emit('voice:enabled', { lobbyId, enabled: false })).toEqual({ ok: true });
    expect((await off).participants).toEqual([]);
    expect(await guest.emit<VoiceJoined>('voice:join', { lobbyId })).toMatchObject({ ok: true, data: { state: { enabled: false, participants: [] } } });

    const on = nextVoice(guest, (s) => s.enabled);
    expect(await host.emit('voice:enabled', { lobbyId, enabled: true })).toEqual({ ok: true });
    await on;
    expect(await guest.emit<VoiceJoined>('voice:join', { lobbyId })).toMatchObject({ ok: true, data: { state: { enabled: true, participants: [{ userId: guest.userId }] } } });
  });

  it('strangers, bad signal kinds and oversized SDPs are rejected', async () => {
    const { host, guest, lobbyId } = await lobby();
    const stranger = await client(t, 'mallory');
    clients.push(stranger);
    expect(await stranger.emit('voice:join', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });
    expect(await stranger.emit('voice:get', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });
    expect(await stranger.emit('voice:bitrate', { lobbyId, kbps: 12 })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });
    await host.emit('voice:join', { lobbyId });
    await guest.emit('voice:join', { lobbyId });
    expect(await stranger.emit('voice:signal', { lobbyId, to: host.userId, kind: 'offer', call: 1, sdp: 'x' })).toEqual({ ok: false, error: 'NOT_IN_VOICE' });
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'hijack', call: 1, sdp: 'x' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'offer', call: 1, sdp: 'x'.repeat(12_001) })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    // Offers and answers need an SDP; rings must not carry one.
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'offer', call: 1, sdp: '' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'ring', call: 0, sdp: 'x' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:signal', { lobbyId, to: host.userId, kind: 'offer', sdp: 'x' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await guest.emit('voice:mute', { lobbyId, muted: 'yes' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });

  it('a member who disconnects drops out of the channel', async () => {
    const { host, guest, lobbyId } = await lobby();
    await host.emit('voice:join', { lobbyId });
    await guest.emit('voice:join', { lobbyId });
    const gone = nextVoice(host, (s) => s.participants.length === 1);
    guest.close();
    expect((await gone).participants.map((p) => p.userId)).toEqual([host.userId]);
  });

  it('the channel carries on through a match and after it ends', async () => {
    const { host, guest, lobbyId } = await lobby();
    await host.emit('voice:join', { lobbyId });
    await guest.emit('voice:join', { lobbyId });
    await host.emit('voice:bitrate', { lobbyId, kbps: 48 });
    const emptied: VoiceState[] = [];
    host.socket.on('voice:state', (s: VoiceState) => s.participants.length < 2 && emptied.push(s));

    const gameId = await startGame(host, guest);
    expect(t.server.ctx.voice.state(lobbyId).participants).toHaveLength(2);

    // Red finishes; with two players the game ends.
    const s = t.server.ctx.games.get(gameId)!;
    s.tokens.red = [HOME, HOME, HOME, 55];
    await host.emit('game:roll', { gameId, version: s.version, actionId: crypto.randomUUID() });
    await host.emit('game:move', { gameId, version: s.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 3 });
    expect(t.server.ctx.games.get(gameId)!.finished).toBe(true);
    await wait(50);

    expect(t.server.ctx.lobbies.get(lobbyId)!.status).toBe('waiting');
    expect(t.server.ctx.voice.state(lobbyId)).toEqual({
      lobbyId,
      enabled: true,
      epoch: 0,
      bitrateKbps: 48,
      participants: [
        { userId: host.userId, muted: false },
        { userId: guest.userId, muted: false },
      ],
    });
    expect(emptied).toEqual([]);
    // Signalling still works after the match.
    expect(await host.emit('voice:signal', { lobbyId, to: guest.userId, kind: 'offer', call: 3, sdp: 'v=0' })).toEqual({ ok: true });
  });

  it('leaving the lobby (also mid-game), or being kicked, leaves voice; a closed lobby empties it', async () => {
    const { host, guest, lobbyId } = await lobby();
    const carol = await client(t, 'carol');
    clients.push(carol);
    await carol.emit('lobby:join', { lobbyId, password: 'pw' });
    for (const c of [host, guest, carol]) await c.emit('voice:join', { lobbyId });

    const kicked = nextVoice(host, (s) => !s.participants.some((p) => p.userId === carol.userId));
    await host.emit('lobby:kick', { userId: carol.userId });
    await kicked;
    expect(await carol.emit('voice:join', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });

    await startGame(host, guest);
    const bobLeft = nextVoice(host, (s) => s.participants.length === 1);
    await guest.emit('lobby:leave', {});
    await bobLeft;
    expect(await guest.emit('voice:join', { lobbyId })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });

    await host.emit('lobby:leave', {}); // last human: the lobby closes
    expect(t.server.ctx.lobbies.get(lobbyId)).toBeUndefined();
    expect(t.server.ctx.voice.state(lobbyId).participants).toEqual([]);
  });
});

describe('rejoining after a network change', () => {
  it('keeps the voice-server flag until that link itself changes, so the others wait instead of dialling directly', async () => {
    const { VoiceManager } = await import('../src/server/voice.js');
    const vm = new VoiceManager({ isMember: () => true, isHost: () => false });
    vm.join('g1', 1, 's1');
    vm.setSfu('g1', 1, true);
    vm.join('g1', 1, 's2'); // the phone rejoined over its new network
    expect(vm.state('g1').participants).toEqual([{ userId: 1, muted: false, sfu: true }]);
    vm.setSfu('g1', 1, false);
    expect(vm.state('g1').participants).toEqual([{ userId: 1, muted: false }]);
  });
});
