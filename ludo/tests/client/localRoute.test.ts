import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Voice goes over the internet first: a phone that doesn't qualify for local-network routes
 * (IPv6, or a ping of 40 ms or more) offers none, and adds them only when the internet route
 * hasn't connected after 5 s.
 */
const sent: [string, any][] = [];
const mock = vi.hoisted(() => ({ sfu: true, local: { ok: false, why: 'ping 85 ms' } as { ok: boolean; why: string } | undefined, participants: [1, 2] }));
vi.mock('../../src/client/net.js', () => ({
  emit: vi.fn(async (event: string, payload: any) => {
    sent.push([event, payload]);
    if (event === 'voice:join') {
      return {
        ok: true,
        data: {
          state: { lobbyId: 'L', enabled: true, epoch: 0, bitrateKbps: 6, participants: mock.participants.map((userId) => ({ userId, muted: false })) },
          iceServers: [],
          sfu: mock.sfu,
          ...(mock.local && { local: mock.local }),
        },
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

const OFFER = 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=candidate:1 1 udp 2122260223 192.168.1.5 5000 typ host\r\na=candidate:2 1 udp 1686052607 203.0.113.9 5001 typ srflx raddr 192.168.1.5 rport 5000\r\n';
const ANSWER = 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=candidate:3 1 udp 2122260223 10.0.0.7 6000 typ host\r\na=candidate:4 1 udp 1686052607 198.51.100.4 6001 typ srflx raddr 10.0.0.7 rport 6000\r\n';

class FakePC {
  static all: FakePC[] = [];
  signalingState = 'stable';
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: any = null;
  remoteDescription: any = null;
  onicecandidate: ((e: any) => void) | null = null;
  ontrack = null;
  onconnectionstatechange: (() => void) | null = null;
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
    return { type: 'offer', sdp: OFFER };
  }
  async createAnswer() {
    return { type: 'answer', sdp: ANSWER };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
    if (d.type === 'offer') this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: any) {
    this.remoteDescription = d;
    this.signalingState = 'stable';
    if (d.type === 'offer' && !this.transceivers.length) this.addTransceiver('audio', { direction: 'recvonly' });
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.connectionState = 'closed';
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  late(candidate: string) {
    this.onicecandidate?.({ candidate: { candidate, toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
}

const signals = (kind: string) => sent.filter(([e, p]) => e === 'voice:signal' && p.kind === kind).map(([, p]) => p);
const sfuJoins = () => sent.filter(([e]) => e === 'voice:sfuJoin').map(([, p]) => p);
let voice: typeof import('../../src/client/voice.js').voice;
let localRouteText: typeof import('../../src/client/voiceUi.js').localRouteText;

beforeAll(async () => {
  const fakeEl = () => ({ setAttribute() {}, remove() {}, play: () => Promise.resolve(), appendChild() {}, srcObject: null, paused: true, hidden: false, autoplay: false });
  Object.assign(globalThis, {
    RTCPeerConnection: FakePC,
    document: { createElement: fakeEl, body: fakeEl(), addEventListener() {}, visibilityState: 'visible' },
  });
  ({ voice } = await import('../../src/client/voice.js'));
  ({ localRouteText } = await import('../../src/client/voiceUi.js'));
});

afterEach(async () => {
  await voice.leave();
  vi.useRealTimers();
  sent.length = 0;
  FakePC.all.length = 0;
});

describe('voice server: internet first, local after 5 s', () => {
  it('a phone that doesn’t qualify asks for internet routes only, then again with local ones if that fails', async () => {
    vi.useFakeTimers();
    mock.sfu = true;
    mock.local = { ok: false, why: 'ping 85 ms' };
    expect(await voice.join('L', 1)).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(sfuJoins()).toEqual([{ lobbyId: 'L' }]);
    let r = await voice.report();
    expect(r.localRoute).toEqual({ ok: false, why: 'ping 85 ms' });
    expect(localRouteText(r)).toBe('not used: internet only (ping 85 ms)');
    await vi.advanceTimersByTimeAsync(5100);
    expect(sfuJoins()).toEqual([{ lobbyId: 'L' }, { lobbyId: 'L', local: true }]);
    r = await voice.report();
    expect(r.server.local).toBe(true);
    expect(localRouteText(r)).toBe("added: the internet route didn't connect (ping 85 ms)");
    expect(r.events.map((e) => e.what)).toContain('internet route to the voice server failed: trying the local network too');
  });

  it('a link that connects in time stays internet-only', async () => {
    vi.useFakeTimers();
    mock.local = { ok: false, why: 'IPv6' };
    await voice.join('L', 1);
    await vi.advanceTimersByTimeAsync(10);
    FakePC.all.at(-1)!.connect();
    await vi.advanceTimersByTimeAsync(6000);
    expect(sfuJoins()).toHaveLength(1);
  });

  it('a phone that qualifies offers local routes from the start (no fallback needed)', async () => {
    vi.useFakeTimers();
    mock.local = { ok: true, why: 'IPv4 · 12 ms' };
    await voice.join('L', 1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(sfuJoins()).toEqual([{ lobbyId: 'L' }]);
    const r = await voice.report();
    expect(r.server.local).toBe(true);
    expect(localRouteText(r)).toBe('allowed, after the internet route (IPv4 · 12 ms)');
  });

  it('an older server that says nothing about local routes: allowed', async () => {
    mock.local = undefined;
    await voice.join('L', 1);
    expect((await voice.report()).localRoute.ok).toBe(true);
    expect(localRouteText({ localRoute: { ok: true, why: '' }, server: { local: true } as never })).toBe('allowed, after the internet route');
  });
});

describe('direct links: internet first, local after 5 s', () => {
  it('our offer and late candidates leave local addresses out, internet ranked first; after 5 s we redial with them', async () => {
    vi.useFakeTimers();
    mock.sfu = false;
    mock.local = { ok: false, why: 'ping 60 ms' };
    await voice.join('L', 1);
    await vi.advanceTimersByTimeAsync(50);
    const [offer] = signals('offer');
    expect(offer.sdp).not.toContain('192.168.1.5');
    expect(offer.sdp).toContain('203.0.113.9');
    const pc = FakePC.all.at(-1)!;
    pc.late('candidate:9 1 udp 2122260223 192.168.1.6 5002 typ host');
    pc.late('candidate:8 1 udp 1686052607 203.0.113.9 5003 typ srflx raddr 0.0.0.0 rport 0');
    await vi.advanceTimersByTimeAsync(300);
    const late = JSON.parse(signals('cand')[0].sdp).map((c: any) => c.candidate);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatch(/^candidate:8 1 udp \d+ 203\.0\.113\.9 5003 typ srflx/);
    // Not connected after 5 s (the watchdog looks every 2 s): a new offer with the local network too.
    await vi.advanceTimersByTimeAsync(6000);
    const offers = signals('offer');
    expect(offers.length).toBeGreaterThanOrEqual(2);
    const again = offers.at(-1);
    expect(again.sdp).toContain('192.168.1.5');
    // Internet first: the public route outranks the local one.
    const prio = (addr: string) => Number(new RegExp(`a=candidate:\\S+ \\d+ \\S+ (\\d+) ${addr.replace(/\./g, '\\.')} `).exec(again.sdp)![1]);
    expect(prio('203.0.113.9')).toBeGreaterThan(prio('192.168.1.5'));
  });

  it('answering an offer that has local routes, we offer ours too', async () => {
    vi.useFakeTimers();
    mock.sfu = false;
    mock.local = { ok: false, why: 'IPv6' };
    await voice.join('L', 2);
    await voice.onSignal({ lobbyId: 'L', from: 1, kind: 'offer', call: 7, sdp: OFFER });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals('answer')[0].sdp).toContain('10.0.0.7');
    await voice.onSignal({ lobbyId: 'L', from: 1, kind: 'offer', call: 8, sdp: OFFER.replace(/a=candidate:1 .*\r\n/, '') });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals('answer')[1].sdp).not.toContain('10.0.0.7');
    expect(signals('answer')[1].sdp).toContain('198.51.100.4');
  });
});
