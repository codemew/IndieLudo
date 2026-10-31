import type { NetStats } from '../shared/net.js';
import type { Color, LobbySummary, PublicGameState, PublicLobby, VoiceState } from '../shared/types.js';

export interface AppState {
  user: { id: number; username: string; avatar?: string; gamesPlayed?: number; wins?: number } | null;
  isAdmin: boolean;
  lobbies: LobbySummary[];
  lobby: PublicLobby | null;
  game: PublicGameState | null;
  /** Voice channel of the current game (who is in it, muted, quality). */
  voice: VoiceState | null;
  /** Ping and signal bars of the current lobby's players, refreshed every few seconds. */
  net: NetStats | null;
  /** The version the server runs (from hello); differs from __APP_VERSION__ when an update is ready. */
  serverVersion: string | null;
  /** Our pending colour-swap request in the lobby, if any. */
  swapOut: { to: number; color: Color } | null;
  online: boolean;
}

export const state: AppState = {
  user: null,
  isAdmin: false,
  lobbies: [],
  lobby: null,
  game: null,
  voice: null,
  net: null,
  swapOut: null,
  serverVersion: null,
  online: false,
};

const listeners = new Set<(changed: (keyof AppState)[]) => void>();

export function update(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  const changed = Object.keys(patch) as (keyof AppState)[];
  for (const fn of listeners) fn(changed);
}

/** Subscribes to store changes; returns the unsubscribe function. */
export function subscribe(fn: (changed: (keyof AppState)[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
