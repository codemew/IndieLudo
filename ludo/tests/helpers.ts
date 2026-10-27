import type { Seat } from '../src/shared/types.js';
import { createGameState } from '../src/shared/rules.js';
import type { Color, GameState } from '../src/shared/types.js';

export function seat(color: Color, userId: number | null = null, controller: Seat['controller'] = 'human'): Omit<Seat, 'timeouts'> {
  return { color, userId, username: color, controller, connected: true };
}

/** A game with the given colours, red (or the first colour) to move. */
export function game(colors: Color[] = ['red', 'yellow'], firstSeat = 0): GameState {
  return createGameState({ id: 'g1', lobbyId: 'l1', seats: colors.map((c, i) => seat(c, i + 1)), firstSeat, now: 0 });
}

/** Puts the current player straight into the moving phase with the given dice. */
export function withQueue(state: GameState, queue: number[]): GameState {
  state.turn.phase = 'moving';
  state.turn.queue = [...queue];
  return state;
}

/** Returns a dice function that plays back the given values, then throws. */
export function scriptedDice(values: number[]): () => number {
  const queue = [...values];
  return () => {
    const v = queue.shift();
    if (v === undefined) throw new Error('scripted dice exhausted');
    return v;
  };
}
