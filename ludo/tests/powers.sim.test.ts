import { describe, expect, it } from 'vitest';
import { BASE, boardFor, boardOf, isSecondLap, raidOf, type BoardSize } from '../src/shared/board.js';
import { applyMove, applyRoll, createGameState } from '../src/shared/rules.js';
import { chooseMove } from '../src/server/bot.js';
import type { GameState } from '../src/shared/types.js';
import { seat } from './helpers.js';

/** A small seeded random number generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function check(s: GameState): void {
  const b = boardFor(s);
  for (const st of s.seats) {
    s.tokens[st.color].forEach((p, id) => {
      const ok = p === BASE || (p >= 0 && p <= b.home) || isSecondLap(p, b) || raidOf(p) !== null;
      if (!ok) throw new Error(`${st.color} ${id} at ${p}`);
      const power = s.powers?.[st.color]?.[id] ?? null;
      if (power && (p === BASE || p === b.home)) throw new Error(`${st.color} ${id} keeps ${power} at ${p}`);
      if (raidOf(p) && power !== 'vampire') throw new Error(`${st.color} ${id} raids without being a vampire`);
    });
  }
  // Every star has an orb or one on its way back.
  // Every power is on the board or on its way back, and never two of the same.
  if ((s.orbs?.length ?? 0) + (s.orbsDue?.length ?? 0) !== 4) throw new Error('orbs lost');
  if (new Set((s.orbs ?? []).map((o) => o.power)).size !== (s.orbs?.length ?? 0)) throw new Error('two of the same power');
}

/** Bots play a whole game with both rules on; every state on the way is checked. */
function play(n: BoardSize, players: number, seed: number, teams = false): GameState {
  const roll = rng(seed);
  const colors = boardOf(n).colors.slice(0, players);
  const s = createGameState({
    id: 'sim',
    lobbyId: 'l',
    seats: colors.map((c, i) => seat(c, i + 1, 'bot')),
    board: n,
    teams,
    powerUps: { seed },
    golden: Object.fromEntries(colors.map((c, i) => [c, (seed + i) % 4])),
  });
  let raids = 0;
  let pickups = 0;
  for (let i = 0; i < 20_000 && !s.finished; i++) {
    if (s.turn.phase === 'rolling') applyRoll(s, 1 + Math.floor(roll() * 6));
    else {
      const m = chooseMove(s)!;
      if (m.raid) raids++;
      const events = applyMove(s, m.dieIndex, m.tokenId, m.lap === true, m.color, m.raid);
      pickups += events.filter((e) => e.type === 'power').length;
    }
    check(s);
  }
  (s as GameState & { sim?: object }).sim = { raids, pickups };
  return s;
}

describe('whole games with power ups and golden tokens (bots, random dice)', () => {
  it('always finish, with every state valid, on every board', () => {
    let pickups = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const [n, players, teams] of [
        [4, 2, false],
        [4, 4, false],
        [4, 4, true],
        [5, 5, false],
        [6, 6, false],
      ] as const) {
        const s = play(n, players, seed * 7 + n, teams);
        expect(s.finished, `board ${n}, ${players} players, seed ${seed}`).toBe(true);
        pickups += (s as GameState & { sim: { pickups: number } }).sim.pickups;
      }
    }
    expect(pickups).toBeGreaterThan(100);
  });
});
