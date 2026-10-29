import { describe, expect, it } from 'vitest';
import { endpointText, routeText, streamText, summarize } from '../../src/client/voiceStats.js';

/** A trimmed getStats() of a phone on Wi-Fi talking to the voice server. */
const stats = (over: { bytesIn?: number; bytesOut?: number; lost?: number; local?: object; remote?: object } = {}) => [
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
  { id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.012 },
  { id: 'P2', type: 'candidate-pair', state: 'failed', localCandidateId: 'L2', remoteCandidateId: 'R' },
  { id: 'L', type: 'local-candidate', address: '192.168.2.10', port: 52011, protocol: 'udp', candidateType: 'host', networkType: 'wifi', ...over.local },
  { id: 'L2', type: 'local-candidate', address: '2409:4060::1', port: 6000, protocol: 'udp', candidateType: 'srflx' },
  { id: 'R', type: 'remote-candidate', address: '192.168.2.177', port: 40000, protocol: 'udp', candidateType: 'host', ...over.remote },
  { id: 'C', type: 'codec', mimeType: 'audio/opus', clockRate: 48000 },
  { id: 'O', type: 'outbound-rtp', kind: 'audio', bytesSent: over.bytesOut ?? 30_000, packetsSent: 500, codecId: 'C' },
  { id: 'I1', type: 'inbound-rtp', kind: 'audio', mid: '1', bytesReceived: over.bytesIn ?? 20_000, packetsReceived: 990, packetsLost: over.lost ?? 10, jitter: 0.003, codecId: 'C' },
  { id: 'I2', type: 'inbound-rtp', kind: 'audio', mid: '2', bytesReceived: 5000, packetsReceived: 100, packetsLost: 0, jitter: 0.009, codecId: 'C' },
];

describe('voice link diagnostics', () => {
  it('reads the route that carries the audio: transport, both ends, round trip', () => {
    const { route } = summarize(stats(), { now: 0 });
    expect(route).toMatchObject({ protocol: 'UDP', rttMs: 12 });
    expect(route.local).toMatchObject({ address: '192.168.2.10', port: 52011, type: 'host', family: 'IPv4', network: 'wifi' });
    expect(route.remote).toMatchObject({ address: '192.168.2.177', port: 40000 });
    expect(routeText(route, 'server')).toBe('UDP · you 192.168.2.10:52011 (local network, wifi) → server 192.168.2.177:40000 (local network) · IPv4 · round trip 12 ms');
  });

  it('says TCP when the route runs over TCP, and how a TURN relay is reached', () => {
    const { route } = summarize(stats({ local: { protocol: 'tcp', candidateType: 'relay', relayProtocol: 'tls', address: '2409:4060::5' } }), { now: 0 });
    expect(route.protocol).toBe('TCP');
    expect(endpointText(route.local)).toBe('[2409:4060::5]:52011 (TURN relay, reached over TLS, wifi)');
  });

  it('bitrates from two looks; loss and jitter; one slot of the voice server on its own', () => {
    const first = summarize(stats(), { now: 1000 });
    const later = summarize(stats({ bytesIn: 25_000, bytesOut: 33_000, lost: 15 }), { now: 3000, prev: first.sample });
    expect(later.stream).toMatchObject({ kbpsIn: 20, kbpsOut: 12, codec: 'opus 48 kHz', jitterMs: 9 }); // +5 KB in 2 s across both slots
    const slot = summarize(stats(), { now: 0, mid: '1' }).stream;
    expect(slot).toMatchObject({ packetsIn: 990, lossPct: 1, jitterMs: 3, kbpsOut: null });
    expect(streamText(later.stream)).toBe('↑ 12 kbps · ↓ 20 kbps · loss 1.4% · jitter 9 ms · opus 48 kHz'); // 15 lost of 1105
  });

  it('no route yet, hidden (mDNS) addresses, and no stats at all', () => {
    const none = summarize([], { now: 0 });
    expect(none.route).toEqual({ protocol: null, local: null, remote: null, rttMs: null });
    expect(routeText(none.route, 'them')).toBe('no working route yet');
    const hidden = summarize(stats({ local: { address: '5f3c1d9e.local', networkType: undefined } }), { now: 0 });
    expect(endpointText(hidden.route.local)).toBe('hidden address:52011 (local network)');
  });
});
