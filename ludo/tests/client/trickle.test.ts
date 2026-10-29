import { beforeAll, describe, expect, it, vi } from 'vitest';

/** What the client sent to the server. */
const sent: [string, any][] = [];
/** The test's handle on the network: the change listener voice.ts registers, and the probe's answer. */
const net = vi.hoisted(() => ({ changed: null as null | (() => void), answers: true, reconnected: 0 }));
vi.mock('../../src/client/net.js', () => ({
  emit: vi.fn(async (event: string, payload: any) => {
    sent.push([event, payload]);
    if (event === 'voice:join') {
      return {
        ok: true,
        data: {
          state: { lobbyId: 'L', enabled: true, epoch: 0, bitrateKbps: 6, participants: [{ userId: 1, muted: false }, { userId: 2, muted: false }] },
          iceServers: [],
        },
      };
    }
    return { ok: true };
  }),
  send: vi.fn(),
  onNetworkChange: vi.fn((fn: () => void) => ((net.changed = fn), () => {})),
  probe: vi.fn(async () => net.answers),
  reconnectNow: vi.fn(() => net.reconnected++),
  transportName: vi.fn(() => 'websocket'),
}));

/** Just enough of RTCPeerConnection to drive the signalling. */
class FakePC {
  static all: FakePC[] = [];
  signalingState = 'stable';
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: any = null;
  remoteDescription: any = null;
  added: any[] = [];
  onicecandidate: ((e: any) => void) | null = null;
  ontrack = null;
  onconnectionstatechange = null;
  constructor() {
    FakePC.all.push(this);
  }
  transceivers: any[] = [];
  addTrack() {}
  addTransceiver(_kind: string, init: { direction: string }) {
    const sender = { track: null, replaceTrack: async () => {}, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
    const t = { sender, direction: init.direction, mid: '0', receiver: {} };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getReceivers() {
    return [];
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=candidate:1 1 udp 1 192.168.1.5 5000 typ host\r\n' };
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
  async addIceCandidate(c: any) {
    this.added.push(c);
  }
  async getStats() {
    return new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
  /** The browser finding a candidate after the offer/answer went out. */
  late(candidate: string) {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signals = (kind: string) => sent.filter(([e, p]) => e === 'voice:signal' && p.kind === kind).map(([, p]) => p);
let voice: typeof import('../../src/client/voice.js').voice;

beforeAll(async () => {
  const fakeEl = () => ({ setAttribute() {}, remove() {}, play: () => Promise.resolve(), appendChild() {}, srcObject: null, paused: true, hidden: false, autoplay: false });
  Object.assign(globalThis, {
    RTCPeerConnection: FakePC,
    document: { createElement: fakeEl, body: fakeEl(), addEventListener() {}, visibilityState: 'visible' },
  });
  ({ voice } = await import('../../src/client/voice.js'));
});

describe('late candidates (trickle ICE)', () => {
  it('candidates found after our offer are batched and sent on; theirs are applied, even if they come early', async () => {
    expect(await voice.join('L', 1)).toBeNull();
    // We have the lower id, so we call player 2.
    await sleep(20);
    const [offer] = signals('offer');
    expect(offer).toMatchObject({ to: 2, kind: 'offer' });
    const pc = FakePC.all.at(-1)!;

    // Two candidates trickle in after the offer went out: one message, both inside.
    pc.late('candidate:2 1 udp 1 203.0.113.9 5001 typ srflx raddr 0.0.0.0 rport 0');
    pc.late('candidate:3 1 udp 1 198.51.100.2 3478 typ relay raddr 203.0.113.9 rport 5001');
    await sleep(350);
    const cands = signals('cand');
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ to: 2, call: offer.call });
    expect(JSON.parse(cands[0].sdp).map((c: any) => c.candidate)).toEqual([expect.stringContaining('typ srflx'), expect.stringContaining('typ relay')]);

    // Their late candidate arrives before their answer: it waits, then is applied with the answer.
    const theirs = JSON.stringify([{ candidate: 'candidate:7 1 udp 1 203.0.113.50 6000 typ srflx raddr 0.0.0.0 rport 0', sdpMid: '0', sdpMLineIndex: 0 }]);
    await voice.onSignal({ lobbyId: 'L', from: 2, kind: 'cand', call: offer.call, sdp: theirs });
    expect(pc.added).toEqual([]);
    await voice.onSignal({ lobbyId: 'L', from: 2, kind: 'answer', call: offer.call, sdp: 'v=0\r\n' });
    expect(pc.added.map((c) => c.candidate)).toEqual([expect.stringContaining('203.0.113.50')]);

    // Candidates for an old call, or that aren't valid JSON, are ignored.
    await voice.onSignal({ lobbyId: 'L', from: 2, kind: 'cand', call: offer.call + 99, sdp: theirs });
    await voice.onSignal({ lobbyId: 'L', from: 2, kind: 'cand', call: offer.call, sdp: 'not json' });
    expect(pc.added).toHaveLength(1);

    const report = await voice.report();
    expect(report.links[0]).toMatchObject({ userId: 2, late: { sent: 2, got: 1 } });
    await voice.leave();
  });

  it('after a network change: a stale game connection is reconnected; a live one rejoins voice at once', async () => {
    expect(await voice.join('L', 1)).toBeNull();
    const joins = () => sent.filter(([e]) => e === 'voice:join').length;

    // Wi-Fi went away and the socket's network with it: the probe gets no answer.
    net.answers = false;
    const before = joins();
    net.changed!();
    net.changed!(); // a burst of change events acts once
    await sleep(1000);
    expect(net.reconnected).toBe(1);
    expect(joins()).toBe(before); // voice rejoins when the socket is back (onReconnect)

    // Mobile data took over and the game connection still answers: redo voice right away.
    net.answers = true;
    net.changed!();
    await sleep(1000);
    expect(net.reconnected).toBe(1);
    expect(joins()).toBe(before + 1);
    const events = (await voice.report()).events.map((e) => e.what);
    expect(events).toEqual(['network changed', 'game connection not answering: reconnecting it', 'network changed']);
    await voice.leave();
  });
});
