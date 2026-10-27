import type { LobbySummary, PublicGameState, PublicLobby } from '../shared/types.js';

export interface AppState {
  user: { id: number; username: string; gamesPlayed?: number; wins?: number } | null;
  isAdmin: boolean;
  lobbies: LobbySummary[];
  lobby: PublicLobby | null;
  game: PublicGameState | null;
  online: boolean;
}

export const state: AppState = {
  user: null,
  isAdmin: false,
  lobbies: [],
  lobby: null,
  game: null,
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
