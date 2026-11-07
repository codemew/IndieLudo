import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { IspLookup, LOCAL_NETWORK, ipv4ToInt, ipv6ToParts, lookupIn, parseIp2Asn, prettyIspName } from '../src/server/isp.js';

/** A few rows in the iptoasn format: start, end, AS number, country, description. */
const ROWS = [
  '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
  '1.0.1.0\t1.0.3.255\t0\tNone\tNot routed',
  '49.32.0.0\t49.47.255.255\t55836\tIN\tRELIANCEJIO-IN Reliance Jio Infocomm Limited',
  '106.192.0.0\t106.223.255.255\t45609\tIN\tBHARTI-MOBILITY-AS-AP Bharti Airtel Ltd. AS for GPRS Service',
  '2405:200::\t2405:207:ffff:ffff:ffff:ffff:ffff:ffff\t55836\tIN\tRELIANCEJIO-IN Reliance Jio Infocomm Limited',
  '2a00:1450::\t2a00:1450:ffff:ffff:ffff:ffff:ffff:ffff\t15169\tUS\tGOOGLE - Google LLC, US',
].join('\n');

const gz = () => gzipSync(Buffer.from(ROWS + '\n'));

describe('address parsing', () => {
  it('IPv4, also IPv4-mapped; junk is null', () => {
    expect(ipv4ToInt('49.36.1.2')).toBe(((49 << 24) >>> 0) + (36 << 16) + (1 << 8) + 2);
    expect(ipv4ToInt('::ffff:1.0.0.1')).toBe(ipv4ToInt('1.0.0.1'));
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
    expect(ipv4ToInt('2405:200::1')).toBeNull();
  });

  it('IPv6 in its short forms', () => {
    expect(ipv6ToParts('2405:200::1')).toEqual([0x2405020000000000n, 1n]);
    expect(ipv6ToParts('::1')).toEqual([0n, 1n]);
    expect(ipv6ToParts('[2a00:1450:4001:82a::200e]')).toEqual([0x2a0014504001082an, 0x200en]);
    expect(ipv6ToParts('fe80::1%eth0')).toEqual([0xfe80000000000000n, 1n]);
    expect(ipv6ToParts('::ffff:1.2.3.4')).toBeNull(); // that one is IPv4
    expect(ipv6ToParts('1:2:3')).toBeNull();
    expect(ipv6ToParts('1::2::3')).toBeNull();
  });

  it('network names as people know them', () => {
    expect(prettyIspName('RELIANCEJIO-IN Reliance Jio Infocomm Limited', 'IN')).toBe('Reliance Jio Infocomm Limited');
    expect(prettyIspName('GOOGLE - Google LLC, US', 'US')).toBe('Google LLC');
    expect(prettyIspName('CLOUDFLARENET', 'US')).toBe('CLOUDFLARENET');
  });
});

describe('looking up the ISP', () => {
  it('finds IPv4 and IPv6 ranges, skips unrouted ones, and is empty outside them', async () => {
    const t = await parseIp2Asn(Readable.from(gz()));
    expect(t.v4Start.length).toBe(3);
    expect(t.v6StartHi.length).toBe(2);
    expect(t.names).toContain('Reliance Jio Infocomm Limited');
    expect(lookupIn(t, '49.36.10.20')).toBe('Reliance Jio Infocomm Limited');
    expect(lookupIn(t, '106.200.1.1')).toBe('Bharti Airtel Ltd. AS for GPRS Service');
    expect(lookupIn(t, '1.0.0.255')).toBe('CLOUDFLARENET');
    expect(lookupIn(t, '1.0.2.1')).toBe(''); // not routed
    expect(lookupIn(t, '8.8.8.8')).toBe('');
    expect(lookupIn(t, '2405:201:abcd::5')).toBe('Reliance Jio Infocomm Limited');
    expect(lookupIn(t, '2a00:1450:4001::1')).toBe('Google LLC');
    expect(lookupIn(t, '2a01::1')).toBe('');
    expect(lookupIn(t, 'not an address')).toBe('');
  });

  it('reads the list on disk, says "Local network" for private addresses, and refreshes a stale list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'isp-'));
    const file = join(dir, 'ip2asn.tsv.gz');
    writeFileSync(file, gz());
    const now = Date.now();
    const fetchImpl = vi.fn(async () => new Response(gz()));
    const onReady = vi.fn();
    const isp = new IspLookup({
      file,
      url: 'https://example.test/list.gz',
      refreshDays: 7,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onReady,
      log: () => {},
      now: () => now,
    });
    await isp.start();
    isp.stop();
    expect(fetchImpl).not.toHaveBeenCalled(); // fresh enough
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(isp.lookup('49.40.0.1')).toBe('Reliance Jio Infocomm Limited');
    expect(isp.lookup('192.168.1.20')).toBe(LOCAL_NETWORK);
    expect(isp.lookup('::ffff:10.0.0.2')).toBe(LOCAL_NETWORK);
    expect(isp.lookup('fd12::1')).toBe(LOCAL_NETWORK);
    expect(isp.lookup('')).toBe('');

    // Eight days later it is stale: a new one is downloaded.
    const old = new Date(now - 8 * 24 * 3600 * 1000);
    utimesSync(file, old, old);
    await isp.refreshIfStale();
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/list.gz', expect.anything());
    expect(statSync(file).mtimeMs).toBeGreaterThan(old.getTime());
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('a failed or broken download keeps the old list, and leaves no half-written file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'isp-'));
    const file = join(dir, 'list.gz');
    writeFileSync(file, gz());
    const logs: string[] = [];
    let reply = new Response('nope', { status: 503 });
    const isp = new IspLookup({
      file,
      url: 'https://example.test/x',
      refreshDays: 7,
      fetchImpl: (async () => reply) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });
    await isp.start();
    isp.stop();
    expect(await isp.download()).toBe(false);
    expect(logs.at(-1)).toContain('keeping the old one');
    reply = new Response(gzipSync(Buffer.from('garbage without tabs\n')));
    expect(await isp.download()).toBe(false); // parses to nothing
    expect(isp.lookup('49.40.0.1')).toBe('Reliance Jio Infocomm Limited');
    expect(readFileSync(file).equals(gz())).toBe(true);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  it('with no list yet it downloads one; until then ISPs are just unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'isp-'));
    const file = join(dir, 'sub', 'list.gz');
    const isp = new IspLookup({
      file,
      url: 'https://example.test/x',
      refreshDays: 7,
      fetchImpl: (async () => new Response(gz())) as unknown as typeof fetch,
      log: () => {},
    });
    expect(isp.lookup('49.40.0.1')).toBe('');
    expect(isp.ready).toBe(false);
    await isp.start();
    isp.stop();
    expect(isp.ready).toBe(true);
    expect(isp.lookup('49.40.0.1')).toBe('Reliance Jio Infocomm Limited');
  });
});
