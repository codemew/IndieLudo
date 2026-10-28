/** How often the server measures each player's ping, and sends a lobby the results. */
export const NET_PING_INTERVAL_MS = 3000;
/** A ping with no reply by then counts as lost. */
export const NET_PING_TIMEOUT_MS = 2500;
/** Lost pings are counted over this many recent pings. */
export const NET_HISTORY = 5;

export type SignalBars = 0 | 1 | 2 | 3 | 4;

/**
 * The ping shown beside a name: exact below 50 ms, then to the nearest 5 ms, and 10 ms from
 * 200 ms. Nobody can tell 143 from 145 ms, and a steadier number means the server can skip
 * sending an update when nothing visible changed.
 */
export function roundPing(ms: number): number {
  const step = ms < 50 ? 1 : ms < 200 ? 5 : 10;
  return Math.round(ms / step) * step;
}

export interface PlayerNet {
  userId: number;
  /** Smoothed round trip to the server, or null before the first reply / while unreachable. */
  pingMs: number | null;
  bars: SignalBars;
}

export interface NetStats {
  lobbyId: string;
  players: PlayerNet[];
}

/**
 * Signal strength from the smoothed ping and recent lost pings:
 * ≤80 ms 4 bars, ≤150 ms 3, ≤300 ms 2, slower 1; each lost ping of the last few costs a bar
 * (never below 1 while replies still come); two lost in a row, or no reply yet, is 0.
 */
export function signalBars(pingMs: number | null, recent: readonly boolean[]): SignalBars {
  const missedLastTwo = recent.length >= 2 && !recent[recent.length - 1] && !recent[recent.length - 2];
  if (pingMs === null || missedLastTwo) return 0;
  const base = pingMs <= 80 ? 4 : pingMs <= 150 ? 3 : pingMs <= 300 ? 2 : 1;
  const lost = recent.filter((ok) => !ok).length;
  return Math.max(1, base - lost) as SignalBars;
}
