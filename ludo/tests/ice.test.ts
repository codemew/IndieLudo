import { describe, expect, it } from 'vitest';
import { hasLocalCandidates, internetFirst, isIPv4, isLocalAddress, isLocalCandidate, localRouteFor, rankCandidate, reachOf, scrubRelated } from '../src/shared/ice.js';
import { publicHostAddress } from '../src/server/socket.js';

describe('local or internet addresses', () => {
  it.each([
    ['192.168.2.177', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.17.0.1', true], // docker
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['172.15.0.1', false],
    ['169.254.10.1', true],
    ['100.64.0.1', true], // carrier-grade NAT
    ['100.127.255.1', true],
    ['100.128.0.1', false],
    ['127.0.0.1', true],
    ['0.0.0.0', true],
    ['::ffff:192.168.1.5', true],
    ['::ffff:203.0.113.5', false],
    ['8b2e6a2c-1f3d-4b1e-9b0e-1234567890ab.local', true], // Chrome's hidden host address
    ['fe80::1', true],
    ['FE80::abcd', true],
    ['fd12:3456::1', true],
    ['fc00::1', true],
    ['::1', true],
    ['::', true],
    ['[fe80::1]', true],
    ['2409:4060:2d8f::1', false], // Jio: a global IPv6 address is reachable from the internet
    ['115.187.58.48', false],
    ['203.0.113.7', false],
    ['example.com', false],
  ])('%s is local: %s', (addr, local) => {
    expect(isLocalAddress(addr)).toBe(local);
  });

  it('IPv4, plain or mapped', () => {
    expect(isIPv4('192.168.1.5')).toBe(true);
    expect(isIPv4('::ffff:192.168.1.5')).toBe(true);
    expect(isIPv4('::FFFF:10.0.0.1')).toBe(true);
    expect(isIPv4('2409:4060::1')).toBe(false);
    expect(isIPv4('::1')).toBe(false);
  });
});

describe('candidates', () => {
  const host = 'a=candidate:1 1 udp 2122260223 192.168.1.5 5000 typ host generation 0';
  const v6 = 'candidate:2 1 udp 2122197247 2409:4060::1 5001 typ host';
  const srflx = 'a=candidate:3 1 udp 1686052607 203.0.113.9 5002 typ srflx raddr 192.168.1.5 rport 5000';
  const relay = 'a=candidate:4 1 udp 41885439 198.51.100.2 3478 typ relay raddr 203.0.113.9 rport 5002';
  const mdns = 'candidate:5 1 udp 2122260223 4f1c.local 5003 typ host';

  it('reach: internet, local or relay', () => {
    expect(reachOf(host)).toBe('local');
    expect(reachOf(v6)).toBe('internet');
    expect(reachOf(srflx)).toBe('internet');
    expect(reachOf(relay)).toBe('relay');
    expect(reachOf(mdns)).toBe('local');
    expect(reachOf('a=end-of-candidates')).toBeNull();
    expect(isLocalCandidate(mdns)).toBe(true);
    expect(isLocalCandidate(relay)).toBe(false);
  });

  it('rank: internet first, then local, then relay; the order within each is kept', () => {
    const p = (c: string) => Number(/ udp (\d+) /.exec(rankCandidate(c))![1]);
    expect(p(v6)).toBeGreaterThan(p(srflx));
    expect(p(srflx)).toBeGreaterThan(p(host));
    expect(p(host)).toBeGreaterThan(p(relay));
    expect(p(mdns)).toBe(p(host.replace('a=', '')));
    expect(p(v6)).toBeLessThan(2 ** 31);
    expect(rankCandidate(host)).toMatch(/^a=candidate:1 1 udp \d+ 192\.168\.1\.5 5000 typ host generation 0$/);
    expect(rankCandidate(v6)).toMatch(/^candidate:2 /);
    expect(rankCandidate('not a candidate')).toBe('not a candidate');
    // An unusual type keeps a low priority rather than failing.
    expect(rankCandidate('candidate:6 1 udp 5 203.0.113.1 9 typ weird')).toBe('candidate:6 1 udp 255 203.0.113.1 9 typ weird');
  });

  it('a local base address a candidate mentions is hidden, a public one kept', () => {
    expect(scrubRelated(srflx)).toContain('raddr 0.0.0.0 rport 0');
    expect(scrubRelated(relay)).toContain('raddr 203.0.113.9 rport 5002');
    expect(scrubRelated(host)).toBe(host);
  });

  it('a whole SDP: local routes dropped (or kept and ranked last), other lines untouched', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', host, srflx, relay, 'a=end-of-candidates', ''].join('\r\n');
    const out = internetFirst(sdp, false);
    expect(out).not.toContain('192.168.1.5');
    expect(out.split('\r\n')[0]).toBe('v=0');
    expect(out.endsWith('a=end-of-candidates\r\n')).toBe(true);
    expect(hasLocalCandidates(out)).toBe(false);
    const kept = internetFirst(sdp, true);
    expect(hasLocalCandidates(kept)).toBe(true);
    expect(kept).toContain('raddr 192.168.1.5');
    // Plain \n line endings are handled too.
    expect(internetFirst([host, srflx].join('\n'), false)).not.toContain('typ host');
  });
});

describe('who may use local routes', () => {
  it.each([
    ['192.168.2.40', 12, 40, { ok: true, why: 'IPv4 · 12 ms' }],
    ['::ffff:192.168.2.40', 39.4, 40, { ok: true, why: 'IPv4 · 39 ms' }],
    ['115.187.58.48', 40, 40, { ok: false, why: 'ping 40 ms' }],
    ['115.187.58.48', 85.2, 40, { ok: false, why: 'ping 85 ms' }],
    ['2409:4060::1', 5, 40, { ok: false, why: 'IPv6' }],
    ['192.168.2.40', null, 40, { ok: false, why: 'ping unknown' }],
    ['192.168.2.40', 1, 0, { ok: false, why: 'ping 1 ms' }],
  ] as const)('%s with a %s ms ping (limit %s ms)', (addr, ping, max, want) => {
    expect(localRouteFor(addr, ping, max)).toEqual(want);
  });
});

describe('the public address phones reach the server at', () => {
  const dns = (map: Record<string, string>) => async (name: string) => {
    if (!map[name]) throw new Error('ENOTFOUND');
    return map[name];
  };
  it.each([
    ['203.0.113.7:3443', '203.0.113.7'],
    ['203.0.113.7', '203.0.113.7'],
    ['192.168.2.177:3443', null],
    ['ludo.example.net:3443', '198.51.100.20'],
    ['home.example.net', null], // resolves to a local address
    ['nowhere.example.net', null],
    ['[2409:4060::1]:3443', null],
    ['', null],
    [undefined, null],
  ])('Host %s → %s', async (host, want) => {
    expect(await publicHostAddress(host, dns({ 'ludo.example.net': '198.51.100.20', 'home.example.net': '192.168.2.177' }))).toBe(want);
  });
});
