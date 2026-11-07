import type { LobbyMember, LobbySpectator } from './types.js';

/** Every person in the lobby, seated players first, then spectators. */
export function humanIds(lobby: { members: readonly LobbyMember[]; spectators: readonly LobbySpectator[] }): number[] {
  return [...lobby.members.filter((m) => !m.isBot && m.userId !== null).map((m) => m.userId!), ...lobby.spectators.map((s) => s.userId)];
}
