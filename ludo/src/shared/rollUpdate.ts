import type { RollUpdate } from './protocol.js';
import { countRoll } from './rolls.js';
import type { GameEvent, PublicGameState } from './types.js';

/**
 * The slim update for a roll that only grew the queue: the events are just that roll, so the
 * rest of the state is as it was. Null for anything else (a roll that ended the turn, the
 * three-sixes penalty, any move), which goes out in full to everyone.
 */
export function rollUpdateOf(state: PublicGameState, events?: GameEvent[]): RollUpdate | null {
  if (events?.length !== 1 || events[0].type !== 'roll' || state.finished) return null;
  return { id: state.id, version: state.version, serverNow: state.serverNow, turn: structuredClone(state.turn), events };
}

/**
 * Applies a slim roll update to the state a phone has, giving what the server has apart from
 * the legal moves (only the roller needs those; the next full update brings them). Null when
 * it doesn't follow on from `base`: the phone missed something and must ask for the full state.
 */
export function applyRollUpdate(base: PublicGameState, u: RollUpdate): PublicGameState | null {
  const roll = u.events[0];
  if (u.id !== base.id || u.version !== base.version + 1 || roll?.type !== 'roll') return null;
  const next: PublicGameState = { ...structuredClone(base), version: u.version, serverNow: u.serverNow, turn: structuredClone(u.turn), legalMoves: [] };
  // The server counts every roll (and the sixes among them); the phone's copy keeps pace.
  const stats = ((next.stats ??= {})[roll.color] ??= { cells: 0, captures: 0, sixes: 0, revenges: 0, machoHome: 0, staches: 0, homeRuns: 0, risks: 0, friendlyFire: 0, firstBlood: false, owed: {} });
  countRoll(stats, roll.value);
  if (roll.value === 6) stats.sixes++;
  return next;
}
