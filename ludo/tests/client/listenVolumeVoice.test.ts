import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The volume chosen for a player reaches whichever link carries their voice: a direct link, the
 * built-in voice server (one audio element per receive slot, which can change hands) or the relay.
 */
const mock = vi.hoisted(() => ({ sfu: false }));
vi.mock('../../src/client/net.js', () => ({
  emit: vi.fn(async (event: string) => {
    if (event === 'voice:join') {
      return {
        ok: true,
        data: { state: { lobbyId: 'L', enabled: true, epoch: 0, bitrateKbps: 6, participants: [1, 2, 3].map((userId) => ({ userId, muted: false })) }, iceServers: [], sfu: mock.sfu },
      };
    }
    if (event === 'voice:sfuJoin') return { ok: true, data: { sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n', slots: [{ mid: '1', userId: 2 }] } };
    return { ok: true };
  }),
  send: vi.fn(),
  onNetworkChange: vi.fn(() => () => {}),
  probe: vi.fn(async () => true),
  reconnectNow: vi.fn(),
  transportName: vi.fn(() => 'websocket'),
}));

class FakePC {
  static all: FakePC[] = [];
  signalingState = 'stable';
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: any = null;
  remoteDescription: any = null;
  onicecandidate = null;
  ontrack: ((e: any) => void) | null = null;
  onconnectionstatechange = null;
  transceivers: any[] = [];
  constructor() {
    FakePC.all.push(this);
  }
  addTransceiver(_kind: string, init: { direction: string }) {
    const t = { sender: { track: null, replaceTrack: async () => {}, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }, direction: init.direction, mid: '0', receiver: {} };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getReceivers() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
    if (d.type === 'offer') this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: any) {
    this.remoteDescription = d;
    this.signalingState = 'stable';
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const audios: any[] = [];
const stream = () => ({ getAudioTracks: () => [{}] });
let voice: typeof import('../../src/client/voice.js').voice;
let vol: typeof import('../../src/client/listenVolume.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const el = (tag: string) => {
    const e = { tag, setAttribute() {}, remove() {}, play: () => Promise.resolve(), appendChild() {}, srcObject: null as any, paused: true, hidden: false, autoplay: false, muted: false, volume: 1 };
    if (tag === 'audio') audios.push(e);
    return e;
  };
  Object.assign(globalThis, {
    RTCPeerConnection: FakePC,
    MediaStream: class {
      constructor(private tracks: unknown[] = []) {}
      getAudioTracks() {
        return this.tracks;
      }
    },
    // (a browser where script can set an element's volume, i.e. not iOS)
    Audio: class {
      volume = 1;
    },
    document: { createElement: el, body: el('body'), addEventListener() {}, visibilityState: 'visible' },
  });
  vol = await import('../../src/client/listenVolume.js');
  ({ voice } = await import('../../src/client/voice.js'));
});

afterEach(async () => {
  await voice.leave();
  audios.length = 0;
  FakePC.all.length = 0;
  vol.resetListenVolume();
});

describe('volume on a direct link', () => {
  it('follows the choice live, and survives the link delivering its stream', async () => {
    mock.sfu = false;
    expect(await voice.join('L', 1)).toBeNull();
    await sleep(20);
    // We have the lowest id, so we dialled 2 and 3; 2 came first.
    const [two, three] = audios;
    vol.setVolume(2, 0.3);
    expect([two.volume, two.muted, three.volume, three.muted]).toEqual([0.3, false, 1, false]);
    vol.setVolume(2, 0);
    expect([two.volume, two.muted]).toEqual([0, true]);
    vol.setVolume(2, 0.6);
    expect([two.volume, two.muted]).toEqual([0.6, false]);
    // Their stream arrives (or arrives again): still at the chosen volume.
    FakePC.all[0].ontrack!({ streams: [stream()], track: {} });
    expect([two.volume, two.muted]).toEqual([0.6, false]);
    vol.setVolume(2, 1);
    expect([two.volume, two.muted]).toEqual([1, false]);
  });

  it('a volume chosen earlier (an earlier game) applies as soon as the link exists', async () => {
    vol.setVolume(2, 0.3);
    vol.setVolume(3, 0);
    expect(await voice.join('L', 1)).toBeNull();
    await sleep(20);
    expect(audios.map((a) => [a.volume, a.muted])).toEqual([
      [0.3, false],
      [0, true],
    ]);
  });
});

describe('volume through the voice server', () => {
  it('each receive slot plays at the volume of whoever holds it now', async () => {
    mock.sfu = true;
    expect(await voice.join('L', 1)).toBeNull();
    await sleep(20);
    const pc = FakePC.all.at(-1)!;
    pc.ontrack!({ track: {}, transceiver: { mid: '1' } });
    pc.ontrack!({ track: {}, transceiver: { mid: '2' } });
    const [slot1, slot2] = audios.filter((a) => a.tag === 'audio');
    voice.onSlots({ lobbyId: 'L', slots: [{ mid: '1', userId: 2 }, { mid: '2', userId: null }] });
    vol.setVolume(2, 0.3);
    vol.setVolume(3, 0);
    expect([slot1.volume, slot1.muted, slot2.volume, slot2.muted]).toEqual([0.3, false, 1, false]);
    // Player 3 starts talking and takes slot 2; player 2 gives slot 1 up.
    voice.onSlots({ lobbyId: 'L', slots: [{ mid: '1', userId: null }, { mid: '2', userId: 3 }] });
    expect([slot1.volume, slot1.muted, slot2.volume, slot2.muted]).toEqual([1, false, 0, true]);
    // Slot 1 goes to 2 again: back to 30%.
    voice.onSlots({ lobbyId: 'L', slots: [{ mid: '1', userId: 2 }, { mid: '2', userId: 3 }] });
    expect([slot1.volume, slot1.muted]).toEqual([0.3, false]);
  });
});
