import type { SignalBars } from '../shared/net.js';
import { state } from './store.js';

const LABEL: Record<SignalBars, string> = { 0: 'no signal', 1: 'weak signal', 2: 'fair signal', 3: 'good signal', 4: 'excellent signal' };

/** A player's ping, measured by the server every few seconds; undefined for bots and before the first one. */
function netOf(userId: number | null) {
  if (userId === null) return undefined;
  return state.net?.players.find((p) => p.userId === userId);
}

/** Four signal bars, like a phone's, coloured by strength. Empty for bots. */
export function signalBars(userId: number | null): string {
  const n = netOf(userId);
  if (!n) return '';
  const label = `${LABEL[n.bars]}${n.pingMs !== null ? `, ${n.pingMs} ms` : ''}`;
  return `<span class="sig sig-${n.bars}" role="img" title="${label}" aria-label="${label}"><i></i><i></i><i></i><i></i></span>`;
}

/** Small "42ms" label for beside the player's icon. */
export function pingText(userId: number | null): string {
  const n = netOf(userId);
  if (!n) return '';
  return `<span class="ping sig-${n.bars}">${n.pingMs === null ? '—' : `${n.pingMs}ms`}</span>`;
}
