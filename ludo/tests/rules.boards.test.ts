/**
 * The same rules on the 4-, 5- and 6-player boards: only the track is longer (13 squares per
 * player), so every number after the start moves with it.
 */
import { describe, expect, it } from 'vitest';
import { BASE, boardOf, type BoardSize } from '../src/shared/board.js';
import { RuleError, applyMove, applyRespawn, applyRoll, createGameState, currentColor, legalMoves, targetsFor } from '../src/shared/rules.js';
import { threatenedTokens } from '../src/shared/threats.js';
import { chooseMove } from '../src/server/bot.js';
import type { Color, GameState } from '../src/shared/types.js';
import { seat, withQueue } from './helpers.js';

function boardGame(n: BoardSize, colors: Color[] = boardOf(n).colors.slice(), firstSeat = 0): GameState {
  return createGameState({ id: 'g', lobbyId: 'l', seats: colors.map((c, i) => seat(c, i + 1)), firstSeat, now: 0, board: n });
}

describe.each([4, 5, 6] as const)('on the %i-player board', (n) => {
  const b = boardOf(n);

  it('targets: out of base on a 6, the home turn (or round again), the second lap, exact roll home', () => {
    expect(targetsFor(BASE, 6, true, b)).toEqual([{ to: 0 }]);
    expect(targetsFor(b.last - 6, 6, true, b)).toEqual([{ to: b.last }]);
    expect(targetsFor(b.last - 2, 3, true, b)).toEqual([{ to: b.last + 1 }, { to: b.lap2First, lap: true }]);
    expect(targetsFor(b.last - 2, 3, false, b)).toEqual([{ to: b.last + 1 }]);
    expect(targetsFor(b.last, 6, true, b)).toEqual([{ to: b.home }, { to: b.lap2First + 5, lap: true }]);
    expect(targetsFor(b.home - 2, 2, true, b)).toEqual([{ to: b.home }]);
    expect(targetsFor(b.home - 2, 3, true, b)).toEqual([]);
    expect(targetsFor(b.lap2Last - 1, 1, true, b)).toEqual([{ to: b.lap2Last }]);
    expect(targetsFor(b.lap2Last - 1, 2, true, b)).toEqual([{ to: b.last + 1 }]);
    expect(targetsFor(b.lap2Last, 6, true, b)).toEqual([{ to: b.home }]);
    expect(targetsFor(b.home, 1, true, b)).toEqual([]);
  });

  it('seats sit clockwise in board order, and turns pass round them skipping empty seats', () => {
    const colors = [...b.colors].reverse().filter((_, i) => i % 2 === 0); // every other seat, given out of order
    const s = boardGame(n, colors);
    expect(s.seats.map((x) => x.color)).toEqual(b.colors.filter((c) => colors.includes(c)));
    const order: Color[] = [];
    for (let i = 0; i < s.seats.length; i++) {
      order.push(currentColor(s));
      applyRoll(s, 1); // nothing out of base: the turn passes
    }
    expect(order).toEqual(s.seats.map((x) => x.color));
    expect(s.board).toBe(n === 4 ? undefined : n);
  });

  it('captures work across the end of the track, and not on a safe square', () => {
    const [first, last] = [b.colors[0], b.colors[n - 1]];
    const s = boardGame(n, [first, last]);
    // The last seat's token just past the end of the track (index 1), red's from the start square + 1.
    s.tokens[last][0] = b.trackLength - 13 * (n - 1) + 1;
    s.tokens[first][0] = 0;
    withQueue(s, [1]);
    expect(legalMoves(s).find((m) => m.tokenId === 0)?.captures).toEqual([{ color: last, tokenId: 0 }]);
    applyMove(s, 0, 0);
    expect(s.tokens[last][0]).toBe(BASE);
    // On a star nobody is captured.
    const t = boardGame(n, [first, last]);
    t.tokens[first][0] = 7;
    t.tokens[last][0] = (b.trackLength + 8 - 13 * (n - 1)) % b.trackLength;
    withQueue(t, [1]);
    expect(legalMoves(t).find((m) => m.tokenId === 0)?.captures).toEqual([]);
  });

  it('a token going home finishes; with one player left the game is over', () => {
    const [a, z] = [b.colors[0], b.colors[2]];
    const s = boardGame(n, [a, z]);
    s.tokens[a] = [b.home, b.home, b.home, b.home - 3];
    withQueue(s, [3]);
    applyMove(s, 0, 3);
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual([a, z]);
  });

  it('a wildcard entry sends a home token back to base, once', () => {
    const [a, z] = [b.colors[0], b.colors[1]];
    const s = boardGame(n, [a, z]);
    s.tokens[a][0] = b.home;
    expect(applyRespawn(s, a, [0])).toEqual([{ type: 'respawn', color: a, tokenIds: [0] }]);
    expect(s.tokens[a][0]).toBe(BASE);
    s.tokens[a][0] = b.home;
    expect(() => applyRespawn(s, a, [0])).toThrow(new RuleError('NO_LAPS_LEFT'));
    s.tokens[a][1] = b.last;
    expect(() => applyRespawn(s, a, [1])).toThrow(new RuleError('NOT_HOME'));
  });

  it('threats and the bot count squares round this board', () => {
    const [a, z] = [b.colors[0], b.colors[n - 1]];
    const s = boardGame(n, [a, z]);
    s.tokens[a][0] = 2; // absolute 2
    s.tokens[z][0] = b.trackLength - 13 * (n - 1) - 1; // absolute -1: three behind, across the wrap
    expect(threatenedTokens(s).has(`${a}:0`)).toBe(true);
    withQueue(s, [3]);
    s.turn.seat = 1;
    expect(chooseMove(s)).toMatchObject({ tokenId: 0, captures: [{ color: a, tokenId: 0 }] });
  });
});

describe('boards and seats', () => {
  it('a seat colour must be on the board, and the seats must fit it', () => {
    expect(() => boardGame(4, ['red', 'purple'])).toThrow(new RuleError('INVALID_COLOR'));
    expect(() => boardGame(5, ['red', 'orange'])).toThrow(new RuleError('INVALID_COLOR'));
    expect(() => createGameState({ id: 'g', lobbyId: 'l', seats: ['red', 'green', 'yellow', 'blue', 'purple'].map((c) => seat(c as Color)) })).toThrow(new RuleError('BAD_SEAT_COUNT'));
    expect(boardGame(6).seats).toHaveLength(6);
  });

  it('Team-up is only on the 4-player board', () => {
    expect(() => createGameState({ id: 'g', lobbyId: 'l', seats: boardOf(5).colors.slice(0, 4).map((c) => seat(c)), teams: true, board: 5 })).toThrow(new RuleError('TEAMS_NEED_FOUR'));
  });

  it.each([5, 6] as const)('bots play a %i-player game to the end', (n) => {
    const s = boardGame(n);
    s.seats.forEach((x) => (x.controller = 'bot'));
    let rng = 7;
    const die = () => (rng = (rng * 16807) % 2147483647) % 6 + 1;
    for (let i = 0; i < 40_000 && !s.finished; i++) {
      if (s.turn.phase === 'rolling') applyRoll(s, die());
      else {
        const m = chooseMove(s)!;
        applyMove(s, m.dieIndex, m.tokenId, Boolean(m.lap));
      }
    }
    expect(s.finished).toBe(true);
    expect(new Set(s.ranks).size).toBe(n);
  });
});
