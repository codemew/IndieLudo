import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { isLocalAddress } from '../shared/ice.js';

/**
 * Which network (ISP) an address belongs to, for the Users tab, looked up locally in the free
 * iptoasn.com list (public domain: every routed IPv4 and IPv6 range with its AS number and name).
 * The server downloads it (about 8 MB gzipped) and refreshes it every `refreshDays`; nobody else
 * is asked about players' addresses, and the addresses themselves are never shown.
 */

export interface IspOptions {
  /** Where the downloaded list is kept, e.g. data/ip2asn-combined.tsv.gz. */
  file: string;
  url: string;
  refreshDays: number;
  log?: (msg: string) => void;
  /** Called after a list was loaded (the first time, or a refresh). */
  onReady?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface IspTables {
  v4Start: Uint32Array;
  v4End: Uint32Array;
  v4Name: Int32Array;
  v6StartHi: BigUint64Array;
  v6StartLo: BigUint64Array;
  v6EndHi: BigUint64Array;
  v6EndLo: BigUint64Array;
  v6Name: Int32Array;
  names: string[];
}

export const LOCAL_NETWORK = 'Local network';

/** a.b.c.d (also IPv4-mapped ::ffff:a.b.c.d) → a 32-bit number; null if it isn't IPv4. */
export function ipv4ToInt(ip: string): number | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** An IPv6 address → its high and low 64 bits; null if it isn't IPv6 (or is IPv4-mapped). */
export function ipv6ToParts(ip: string): [bigint, bigint] | null {
  let a = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  if (!a.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return null;
  // An embedded IPv4 tail (::1.2.3.4) becomes two groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (tail) {
    const n = tail.slice(1).map(Number);
    a = a.slice(0, tail.index) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 4; i++) hi = (hi << 16n) | BigInt(parseInt(groups[i], 16));
  for (let i = 4; i < 8; i++) lo = (lo << 16n) | BigInt(parseInt(groups[i], 16));
  return [hi, lo];
}

/**
 * The network's name as players know it. The list has the AS handle first ("RELIANCEJIO-IN Reliance
 * Jio Infocomm Limited"): the handle goes when a readable name follows, and so does a trailing
 * country code ("…, IN").
 */
export function prettyIspName(desc: string, country = ''): string {
  let s = desc.trim();
  const m = /^([A-Z0-9][A-Z0-9._-]*)(?:\s+-\s+|\s+)(.*[a-z].*)$/.exec(s);
  if (m) s = m[2].trim();
  if (country && country !== 'None') s = s.replace(new RegExp(`,\\s*${country}$`), '');
  return s.slice(0, 48);
}

/** Reads the iptoasn TSV (start, end, AS number, country, description), gzipped or not. */
export async function parseIp2Asn(input: NodeJS.ReadableStream, gzipped = true): Promise<IspTables> {
  const source = gzipped ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const v4: [number, number, number][] = [];
  const v6: [bigint, bigint, bigint, bigint, number][] = [];
  const idOf = (name: string) => {
    let id = nameIndex.get(name);
    if (id === undefined) {
      id = names.length;
      names.push(name);
      nameIndex.set(name, id);
    }
    return id;
  };
  for await (const line of lines) {
    const [start, end, asn, country, desc] = line.split('\t');
    if (!desc || asn === '0' || desc === 'Not routed') continue;
    const name = prettyIspName(desc, country);
    if (!name) continue;
    const s4 = ipv4ToInt(start);
    if (s4 !== null) {
      const e4 = ipv4ToInt(end);
      if (e4 !== null && e4 >= s4) v4.push([s4, e4, idOf(name)]);
      continue;
    }
    const s6 = ipv6ToParts(start);
    const e6 = ipv6ToParts(end);
    if (s6 && e6) v6.push([s6[0], s6[1], e6[0], e6[1], idOf(name)]);
  }
  v4.sort((a, b) => a[0] - b[0]);
  v6.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return {
    v4Start: Uint32Array.from(v4, (r) => r[0]),
    v4End: Uint32Array.from(v4, (r) => r[1]),
    v4Name: Int32Array.from(v4, (r) => r[2]),
    v6StartHi: BigUint64Array.from(v6, (r) => r[0]),
    v6StartLo: BigUint64Array.from(v6, (r) => r[1]),
    v6EndHi: BigUint64Array.from(v6, (r) => r[2]),
    v6EndLo: BigUint64Array.from(v6, (r) => r[3]),
    v6Name: Int32Array.from(v6, (r) => r[4]),
    names,
  };
}

/** The network name for `ip` in `t`; '' when the address isn't in any routed range. */
export function lookupIn(t: IspTables, ip: string): string {
  const n4 = ipv4ToInt(ip);
  if (n4 !== null) {
    let lo = 0;
    let hi = t.v4Start.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.v4Start[mid] <= n4) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && n4 <= t.v4End[found] ? t.names[t.v4Name[found]] : '';
  }
  const p = ipv6ToParts(ip);
  if (!p) return '';
  const le = (aHi: bigint, aLo: bigint, bHi: bigint, bLo: bigint) => aHi < bHi || (aHi === bHi && aLo <= bLo);
  let lo = 0;
  let hi = t.v6StartHi.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (le(t.v6StartHi[mid], t.v6StartLo[mid], p[0], p[1])) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && le(p[0], p[1], t.v6EndHi[found], t.v6EndLo[found]) ? t.names[t.v6Name[found]] : '';
}

const DAY_MS = 24 * 3600 * 1000;
const CHECK_EVERY_MS = 12 * 3600 * 1000;
/** Give up on a download that takes longer than this. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class IspLookup {
  private tables: IspTables | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private opts: IspOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
  }

  /** Loads the list already on disk, then downloads a fresh one when it's missing or old; checks twice a day. */
  async start(): Promise<void> {
    if (existsSync(this.opts.file)) await this.load();
    await this.refreshIfStale();
    this.timer = setInterval(() => void this.refreshIfStale(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get ready(): boolean {
    return this.tables !== null;
  }

  /** The ISP's name; "Local network" for private addresses; '' while the list isn't loaded or for unknown ones. */
  lookup(ip: string): string {
    if (!ip) return '';
    if (isLocalAddress(ip)) return LOCAL_NETWORK;
    return this.tables ? lookupIn(this.tables, ip) : '';
  }

  async refreshIfStale(): Promise<void> {
    const fresh = existsSync(this.opts.file) && this.now() - statSync(this.opts.file).mtimeMs < this.opts.refreshDays * DAY_MS;
    if (!fresh) await this.download();
    else if (!this.tables) await this.load();
  }

  /** Downloads to a temporary file, checks it parses, and only then replaces the old list. */
  async download(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const tmp = `${this.opts.file}.part`;
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      const tables = await parseIp2Asn(createReadStream(tmp));
      if (tables.v4Start.length + tables.v6StartHi.length === 0) throw new Error('the list is empty');
      renameSync(tmp, this.opts.file);
      this.use(tables);
      this.log(`[isp] network list updated: ${tables.v4Start.length + tables.v6StartHi.length} ranges`);
      return true;
    } catch (err) {
      this.log(
        `[isp] could not download the network list (${(err as Error).message}); ${this.tables ? 'keeping the old one' : 'ISPs will show once it downloads'}`,
      );
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async load(): Promise<void> {
    try {
      this.use(await parseIp2Asn(createReadStream(this.opts.file)));
    } catch (err) {
      this.log(`[isp] could not read ${this.opts.file}: ${(err as Error).message}`);
    }
  }

  private use(tables: IspTables): void {
    this.tables = tables;
    this.opts.onReady?.();
  }
}
