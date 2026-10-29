/**
 * Reads a WebRTC connection's stats into what the voice Details panel shows: which transport
 * (UDP or TCP) and route the audio takes, each end's address and port, round-trip time, packet
 * loss, jitter, bitrate and codec. Pure, so it can be tested without a browser.
 */

export interface Endpoint {
  address: string;
  port: number;
  /** host / srflx / prflx / relay */
  type: string;
  /** "udp" or "tcp" */
  protocol: string;
  family: 'IPv4' | 'IPv6' | 'hidden' | '?';
  /** The phone's network for this route, where the browser says (wifi, cellular, ethernet, vpn). */
  network?: string;
  /** For a TURN relay: how this phone reaches the relay (udp, tcp, tls). */
  relayProtocol?: string;
}

export interface RouteStats {
  /** The transport carrying the audio. */
  protocol: 'UDP' | 'TCP' | null;
  local: Endpoint | null;
  remote: Endpoint | null;
  rttMs: number | null;
}

export interface StreamStats {
  kbpsIn: number | null;
  kbpsOut: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  codec: string | null;
  packetsIn: number;
  packetsOut: number;
}

/** Byte counters at one moment, to work out bitrates on the next look. */
export interface Sample {
  at: number;
  bytesIn: number;
  bytesOut: number;
}

type Stat = Record<string, any>;

function endpoint(c: Stat | undefined): Endpoint | null {
  if (!c) return null;
  const address = String(c.address ?? c.ip ?? '');
  return {
    address,
    port: Number(c.port ?? 0),
    type: String(c.candidateType ?? '?'),
    protocol: String(c.protocol ?? '?').toLowerCase(),
    family: address.endsWith('.local') ? 'hidden' : address.includes(':') ? 'IPv6' : /^\d+\.\d+\.\d+\.\d+$/.test(address) ? 'IPv4' : '?',
    ...(c.networkType && { network: String(c.networkType) }),
    ...(c.relayProtocol && { relayProtocol: String(c.relayProtocol).toLowerCase() }),
  };
}

/**
 * The route and the audio stream of one connection. `mid` narrows the received audio to one
 * receive slot (the voice server carries everyone on one connection); `prev` is the last sample,
 * for bitrates.
 */
export function summarize(stats: Iterable<Stat>, opts: { mid?: string; prev?: Sample; now: number }): { route: RouteStats; stream: StreamStats; sample: Sample } {
  const all = [...stats];
  const byId = new Map(all.map((s) => [s.id, s]));
  const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const pair =
    byId.get(transport?.selectedCandidatePairId) ??
    all.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) ??
    all.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded');
  const local = endpoint(pair && byId.get(pair.localCandidateId));
  const remote = endpoint(pair && byId.get(pair.remoteCandidateId));
  const protocol = local?.protocol === 'tcp' || remote?.protocol === 'tcp' ? 'TCP' : local || remote ? 'UDP' : null;
  const route: RouteStats = { protocol, local, remote, rttMs: typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null };

  const inbound = all.filter((s) => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'audio' && (opts.mid === undefined || s.mid === opts.mid));
  const outbound = opts.mid === undefined ? all.filter((s) => s.type === 'outbound-rtp' && (s.kind ?? s.mediaType) === 'audio') : [];
  const sum = (list: Stat[], k: string) => list.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  const bytesIn = sum(inbound, 'bytesReceived');
  const bytesOut = sum(outbound, 'bytesSent');
  const packetsIn = sum(inbound, 'packetsReceived');
  const lost = sum(inbound, 'packetsLost');
  const dt = opts.prev ? opts.now - opts.prev.at : 0;
  const kbps = (now: number, before: number | undefined) => (opts.prev && dt > 0 && before !== undefined ? Math.max(0, Math.round(((now - before) * 8) / dt)) : null);
  const jitters = inbound.map((s) => s.jitter).filter((j) => typeof j === 'number');
  const codecStat = byId.get((inbound[0] ?? outbound[0])?.codecId);
  const stream: StreamStats = {
    kbpsIn: inbound.length ? kbps(bytesIn, opts.prev?.bytesIn) : null,
    kbpsOut: outbound.length ? kbps(bytesOut, opts.prev?.bytesOut) : null,
    lossPct: packetsIn + lost > 0 ? Math.round((lost / (packetsIn + lost)) * 1000) / 10 : null,
    jitterMs: jitters.length ? Math.round(Math.max(...jitters) * 1000) : null,
    codec: codecStat ? `${String(codecStat.mimeType).replace(/^audio\//i, '')} ${Math.round(codecStat.clockRate / 1000)} kHz` : null,
    packetsIn,
    packetsOut: sum(outbound, 'packetsSent'),
  };
  return { route, stream, sample: { at: opts.now, bytesIn, bytesOut } };
}

const TYPE_TEXT: Record<string, string> = { host: 'local network', srflx: 'internet', prflx: 'internet', relay: 'TURN relay' };

/** "192.168.2.10:52011 (local network, wifi)" */
export function endpointText(e: Endpoint | null): string {
  if (!e) return '?';
  const addr = e.family === 'IPv6' ? `[${e.address}]` : e.family === 'hidden' ? 'hidden address' : e.address || '?';
  const how = [TYPE_TEXT[e.type] ?? e.type, e.relayProtocol && `reached over ${e.relayProtocol.toUpperCase()}`, e.network].filter(Boolean).join(', ');
  return `${addr}:${e.port} (${how})`;
}

/** "UDP · you 192.168.2.10:52011 (local network) → server 192.168.2.177:40000 (local network) · IPv4 · 4 ms" */
export function routeText(r: RouteStats, them: string): string {
  if (!r.protocol) return 'no working route yet';
  const fam = r.local?.family === 'IPv6' || r.remote?.family === 'IPv6' ? 'IPv6' : r.local?.family === 'IPv4' || r.remote?.family === 'IPv4' ? 'IPv4' : null;
  return [r.protocol, `you ${endpointText(r.local)} → ${them} ${endpointText(r.remote)}`, fam, r.rttMs !== null && `round trip ${r.rttMs} ms`].filter(Boolean).join(' · ');
}

/** "↑ 21 kbps · ↓ 38 kbps · loss 0.4% · jitter 3 ms · opus 48 kHz" */
export function streamText(s: StreamStats): string {
  return [
    s.kbpsOut !== null && `↑ ${s.kbpsOut} kbps`,
    s.kbpsIn !== null && `↓ ${s.kbpsIn} kbps`,
    s.lossPct !== null && `loss ${s.lossPct}%`,
    s.jitterMs !== null && `jitter ${s.jitterMs} ms`,
    s.codec,
  ]
    .filter(Boolean)
    .join(' · ');
}
