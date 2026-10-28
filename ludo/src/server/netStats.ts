import { NET_HISTORY, roundPing, signalBars, type PlayerNet } from '../shared/net.js';

interface Link {
  userId: number;
  /** Smoothed round trip in ms. */
  rtt: number | null;
  /** Recent pings, oldest first: true when answered in time. */
  recent: boolean[];
}

/** Smoothing weight of a new sample, so one slow reply doesn't make the bars jump. */
const NEW_SAMPLE_WEIGHT = 0.4;

/**
 * Each player's connection to the server, measured by the server itself (it times its own
 * pings), so a phone can't report a fake ping for itself or anyone else.
 */
export class NetStatsTracker {
  private links = new Map<string, Link>();

  add(socketId: string, userId: number): void {
    this.links.set(socketId, { userId, rtt: null, recent: [] });
  }

  remove(socketId: string): void {
    this.links.delete(socketId);
  }

  sockets(): [socketId: string, userId: number][] {
    return [...this.links].map(([id, l]) => [id, l.userId]);
  }

  /** A ping's round trip in ms, or null when it timed out. */
  record(socketId: string, rttMs: number | null): void {
    const l = this.links.get(socketId);
    if (!l) return;
    l.recent.push(rttMs !== null);
    if (l.recent.length > NET_HISTORY) l.recent.shift();
    if (rttMs !== null) l.rtt = l.rtt === null ? rttMs : l.rtt * (1 - NEW_SAMPLE_WEIGHT) + rttMs * NEW_SAMPLE_WEIGHT;
  }

  /** The user's best connection (a phone can have two tabs open); offline is 0 bars. */
  forUser(userId: number): PlayerNet {
    let best: PlayerNet = { userId, pingMs: null, bars: 0 };
    for (const l of this.links.values()) {
      if (l.userId !== userId) continue;
      const cand: PlayerNet = { userId, pingMs: l.rtt === null ? null : roundPing(l.rtt), bars: signalBars(l.rtt, l.recent) };
      if (cand.bars > best.bars || (cand.bars === best.bars && (cand.pingMs ?? Infinity) < (best.pingMs ?? Infinity))) best = cand;
    }
    return best;
  }
}
