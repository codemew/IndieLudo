import crypto from 'node:crypto';

export interface GateOptions {
  maxFailsPerIp: number;
  globalFailRotateThreshold: number;
  randomInt?: (min: number, max: number) => number;
  now?: () => number;
  onRotate?: (code: string, reason: 'manual' | 'brute-force') => void;
}

export type VerifyResult = { ok: true } | { ok: false; retryAfterSec?: number };

const IP_WINDOW_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 10 * 60_000;
const LOCKOUT_MINUTES = [1, 5, 15, 60];
const MAX_TRACKED_IPS = 10_000;

interface IpRecord {
  fails: number[];
  level: number;
  lockedUntil: number;
}

/**
 * The 6-digit access code printed in the terminal at startup. It lives only in memory;
 * devices that pass it get a permanent device token (see DeviceService), so rotating the
 * code never affects devices that are already verified.
 */
export class Gate {
  private code: string;
  private ips = new Map<string, IpRecord>();
  private globalFails: number[] = [];
  private readonly randomInt: (min: number, max: number) => number;
  private readonly now: () => number;

  constructor(private opts: GateOptions) {
    this.randomInt = opts.randomInt ?? ((min, max) => crypto.randomInt(min, max));
    this.now = opts.now ?? Date.now;
    this.code = this.generate();
  }

  get current(): string {
    return this.code;
  }

  private generate(): string {
    return String(this.randomInt(0, 1_000_000)).padStart(6, '0');
  }

  rotate(reason: 'manual' | 'brute-force' = 'manual'): string {
    this.code = this.generate();
    this.globalFails = [];
    this.opts.onRotate?.(this.code, reason);
    return this.code;
  }

  verify(input: unknown, ip: string): VerifyResult {
    const now = this.now();
    let rec = this.ips.get(ip);
    if (rec && rec.lockedUntil > now) return { ok: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };

    const candidate = typeof input === 'string' ? input.replace(/\s/g, '') : '';
    // Compare against the real code even for malformed input so timing does not leak the format check.
    const padded = /^\d{6}$/.test(candidate) ? candidate : '------';
    const ok = crypto.timingSafeEqual(Buffer.from(padded), Buffer.from(this.code));
    if (ok) {
      this.ips.delete(ip);
      return { ok: true };
    }

    if (!rec) {
      if (this.ips.size >= MAX_TRACKED_IPS) this.prune(now);
      rec = { fails: [], level: 0, lockedUntil: 0 };
      this.ips.set(ip, rec);
    }
    rec.fails = rec.fails.filter((t) => now - t < IP_WINDOW_MS);
    rec.fails.push(now);
    if (rec.fails.length >= this.opts.maxFailsPerIp) {
      const minutes = LOCKOUT_MINUTES[Math.min(rec.level, LOCKOUT_MINUTES.length - 1)];
      rec.lockedUntil = now + minutes * 60_000;
      rec.level++;
      rec.fails = [];
    }

    this.globalFails = this.globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.globalFails.push(now);
    if (this.globalFails.length > this.opts.globalFailRotateThreshold) this.rotate('brute-force');
    return { ok: false };
  }

  private prune(now: number): void {
    for (const [ip, rec] of this.ips) {
      if (rec.lockedUntil <= now && rec.fails.every((t) => now - t >= IP_WINDOW_MS)) this.ips.delete(ip);
    }
  }
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function codeBanner(code: string): string {
  const line = `  LUDO ACCESS CODE:  ${formatCode(code)}  `;
  const bar = '─'.repeat(line.length);
  return `┌${bar}┐\n│${line}│\n└${bar}┘`;
}
