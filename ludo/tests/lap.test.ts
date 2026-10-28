import { describe, expect, it } from 'vitest';
import { BASE, HOME, LAP2_FIRST, LAP2_LAST, TRACK, absoluteSquare, isSecondLap, pathCells, tokenCell } from '../src/shared/board.js';
import { SCHEMAS, matchesSchema } from '../src/shared/protocol.js';
import { applyMove, distinctChoices, legalMoves, targetsFor } from '../src/shared/rules.js';
import { chooseMove } from '../src/server/bot.js';
import { playerStats } from '../src/shared/awards.js';
import { COLORS } from '../src/shared/types.js';
import { game, withQueue } from './helpers.js';

describe('second lap: the board', () => {
  it('second-lap positions are the same track squares again, one lap on', () => {
    for (const c of COLORS) {
      expect(absoluteSquare(c, LAP2_FIRST)).toBe(absoluteSquare(c, 0)! === 0 ? 51 : (absoluteSquare(c, 0)! + 51) % 52); // just before its start
      expect(absoluteSquare(c, LAP2_FIRST + 1)).toBe(absoluteSquare(c, 0)); // its start square
      expect(absoluteSquare(c, LAP2_LAST)).toBe(absoluteSquare(c, 50)); // its last square before home
      for (let p = LAP2_FIRST; p <= LAP2_LAST; p++) expect(tokenCell(c, p, 0)).toEqual(TRACK[absoluteSquare(c, p)!]);
    }
    expect(isSecondLap(HOME)).toBe(false);
  });

  it('every move walks exactly the number rolled, round the turn or into the home column', () => {
    expect(pathCells('red', 48, 59, 0)).toHaveLength(5); // 48 → 50, round past the start → 59
    expect(pathCells('red', 48, 59, 0).at(-1)).toEqual(TRACK[1]);
    expect(pathCells('red', 48, 53, 0).at(-1)).toEqual(tokenCell('red', 53, 0)); // into the home column
    expect(pathCells('red', 106, 53, 0)).toHaveLength(5); // second lap → home column (107, 108, 51, 52, 53)
    expect(pathCells('red', 106, 53, 0).at(-1)).toEqual(tokenCell('red', 53, 0));
  });
});

describe('second lap: the rules', () => {
  it('a token about to turn home on its first lap may go round again instead', () => {
    expect(targetsFor(48, 5)).toEqual([{ to: 53 }, { to: 59, lap: true }]);
    expect(targetsFor(50, 1)).toEqual([{ to: 51 }, { to: LAP2_FIRST, lap: true }]);
    expect(targetsFor(44, 6)).toEqual([{ to: 50 }]); // still on the track: no choice
    expect(targetsFor(52, 3)).toEqual([{ to: 55 }]); // already in the home column
  });

  it('only once: a second-lap token turns home at the end, and needs an exact roll to finish', () => {
    expect(targetsFor(100, 6)).toEqual([{ to: 106 }]);
    expect(targetsFor(LAP2_LAST, 1)).toEqual([{ to: 51 }]);
    expect(targetsFor(105, 6)).toEqual([{ to: 53 }]);
    expect(targetsFor(LAP2_LAST, 6)).toEqual([{ to: HOME }]);
    expect(targetsFor(104, 6)).toEqual([{ to: 52 }]); // 104 + 6 → home column square 52
  });

  it('both choices are separate legal moves; the player picks one', () => {
    const s = withQueue(game(), [5]);
    s.tokens.red = [48, BASE, BASE, BASE];
    const moves = legalMoves(s);
    expect(moves.map((m) => [m.to, Boolean(m.lap)])).toEqual([
      [53, false],
      [59, true],
    ]);
    expect(distinctChoices(moves)).toHaveLength(2); // so the server won't auto-play it
    applyMove(s, 0, 0, true);
    expect(s.tokens.red[0]).toBe(59);
    expect(playerStats(s, 'red').cells).toBe(5);
  });

  it('heading home is the default when no choice is sent', () => {
    const s = withQueue(game(), [5]);
    s.tokens.red = [48, BASE, BASE, BASE];
    applyMove(s, 0, 0);
    expect(s.tokens.red[0]).toBe(53);
  });

  it('a second-lap token captures and is captured like any other', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [60, BASE, BASE, BASE]; // absolute 2 on its second lap
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5
    applyMove(s, 0, 0); // 60 + 3 = 63 → absolute 5
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(s.tokens.red[0]).toBe(63);
    // Now yellow catches it: a captured second-lap token goes back to base.
    const t = withQueue(game(['red', 'yellow'], 1), [3]);
    t.tokens.red = [63, BASE, BASE, BASE]; // absolute 5
    t.tokens.yellow = [28, BASE, BASE, BASE]; // absolute 2, three behind
    applyMove(t, 0, 0);
    expect(t.tokens.red[0]).toBe(BASE);
  });

  it('bots head home, unless going round would capture someone', () => {
    const s = withQueue(game(), [5]);
    s.tokens.red = [48, BASE, BASE, BASE];
    expect(chooseMove(s)).toMatchObject({ to: 53 });
    s.tokens.yellow = [27, BASE, BASE, BASE]; // absolute 1 = where going round lands (59 → absolute 1)
    expect(absoluteSquare('red', 59)).toBe(1);
    expect(chooseMove(s)).toMatchObject({ to: 59, lap: true });
  });

  it('the move message takes the choice as an optional true/false', () => {
    const base = { gameId: 'g', version: 1, actionId: 'abcdefgh-1', dieIndex: 0, tokenId: 0 };
    expect(matchesSchema(base, SCHEMAS.move)).toBe(true);
    expect(matchesSchema({ ...base, lap: true }, SCHEMAS.move)).toBe(true);
    expect(matchesSchema({ ...base, lap: 'yes' }, SCHEMAS.move)).toBe(false);
    expect(matchesSchema({ ...base, to: 59 }, SCHEMAS.move)).toBe(false);
    expect(matchesSchema({ ...base, toString: 1 }, SCHEMAS.move)).toBe(false);
  });
});
