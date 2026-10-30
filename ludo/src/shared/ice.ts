/**
 * Voice routes, internet first. A voice connection may go over the internet (the server's or a
 * phone's public address) or over the local network (a 192.168.x.x address, a hidden .local
 * name…). The internet route is tried first; local addresses are offered only by phones that
 * look like they're on the same network as the server (IPv4, ping under 40 ms), or after the
 * internet route failed. Pure, so the server and the phones share it.
 */

/** Addresses only reachable on the same network (or nowhere): private, link-local, carrier-NAT, loopback, mDNS. */
export function isLocalAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.endsWith('.local')) return true;
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || x === 127 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (a.includes(':')) return a === '::1' || a === '::' || /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
  return false;
}

/** An IPv4 address, written plainly or IPv4-mapped (how a dual-stack server sees IPv4 clients). */
export function isIPv4(address: string): boolean {
  return /^(?:::ffff:)?\d+\.\d+\.\d+\.\d+$/i.test(address);
}

const CANDIDATE = /^(a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(.*)$/;

export type Reach = 'internet' | 'local' | 'relay';

/** Whether a candidate line (`a=candidate:…` or `candidate:…`) is an internet, local or relay route; null if it isn't one. */
export function reachOf(candidate: string): Reach | null {
  const m = CANDIDATE.exec(candidate.trim());
  if (!m) return null;
  if (m[8] === 'relay') return 'relay';
  return isLocalAddress(m[6]) ? 'local' : 'internet';
}

export const isLocalCandidate = (candidate: string): boolean => reachOf(candidate) === 'local';

/** Type preference (RFC 8445 §5.1.2) by reach: internet direct routes first, then local, a TURN relay last. */
const TYPE_PREF: Record<Reach, Record<string, number>> = {
  internet: { host: 126, prflx: 110, srflx: 100 },
  local: { host: 60, prflx: 55, srflx: 50 },
  relay: { relay: 0 },
};

/**
 * Rewrites a candidate's priority so routes are tried internet first, then local, then relay;
 * within each, the original order is kept (its local preference and component are kept).
 */
export function rankCandidate(candidate: string): string {
  const m = CANDIDATE.exec(candidate.trim());
  if (!m) return candidate;
  const reach = reachOf(candidate)!;
  const old = Number(m[5]);
  const component = Number(m[3]);
  const type = TYPE_PREF[reach][m[8]] ?? 0;
  const priority = type * 2 ** 24 + ((old >> 8) & 0xffff) * 2 ** 8 + (256 - component);
  return `${m[1] ?? ''}candidate:${m[2]} ${m[3]} ${m[4]} ${priority} ${m[6]} ${m[7]} typ ${m[8]}${m[9]}`;
}

/** Hides a local address a candidate mentions as its base (`raddr`), as browsers do for privacy. */
export function scrubRelated(candidate: string): string {
  return candidate.replace(/ raddr (\S+) rport \d+/, (all, addr: string) => (isLocalAddress(addr) ? ' raddr 0.0.0.0 rport 0' : all));
}

/**
 * Every candidate line of an SDP re-ranked internet first; `keepLocal` false drops the local
 * ones, and the local addresses the others mention.
 */
export function internetFirst(sdp: string, keepLocal: boolean): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp
    .split(eol)
    .filter((l) => keepLocal || !l.startsWith('a=candidate:') || !isLocalCandidate(l))
    .map((l) => (l.startsWith('a=candidate:') ? rankCandidate(keepLocal ? l : scrubRelated(l)) : l))
    .join(eol);
}

/** Whether an SDP offers any local-network route (the other side is trying local too). */
export function hasLocalCandidates(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((l) => l.startsWith('a=candidate:') && isLocalCandidate(l));
}

/** Why a phone may (or may not) use local routes: on IPv4 and closer than `maxPingMs`. */
export interface LocalRoute {
  ok: boolean;
  why: string;
}

export function localRouteFor(address: string, pingMs: number | null, maxPingMs: number): LocalRoute {
  if (!isIPv4(address)) return { ok: false, why: 'IPv6' };
  if (pingMs === null) return { ok: false, why: 'ping unknown' };
  const ms = Math.round(pingMs);
  if (pingMs >= maxPingMs) return { ok: false, why: `ping ${ms} ms` };
  return { ok: true, why: `IPv4 · ${ms} ms` };
}
