import { describe, expect, it } from 'vitest';
import { BASE, HOME, LAP2_FIRST, LAP2_LAST, LAST_TRACK, absoluteSquare, pathCells, stepFrom, tokenCell } from '../src/shared/board.js';
import { RuleError, applyMove, applyRoll, createGameState, currentColor, distinctChoices, legalMoves, targetProgress, targetsFor } from '../src/shared/rules.js';
import type { Color, GameState } from '../src/shared/types.js';
import { game, seat, withQueue } from './helpers.js';

const H = HOME;

describe('rules matrix: where a token can go with each die', () => {
  // [from, die, expected targets (lap ones marked)]
  const cases: [number, number, string][] = [
    [BASE, 1, ''],
    [BASE, 5, ''],
    [BASE, 6, '0'],
    [0, 6, '6'],
    [44, 6, '50'],
    [45, 6, '51 lap57'],
    [48, 2, '50'],
    [48, 3, '51 lap57'],
    [50, 1, '51 lap57'],
    [50, 6, '56 lap62'],
    [51, 5, '56'],
    [51, 6, ''],
    [55, 1, '56'],
    [55, 2, ''],
    [H, 1, ''],
    [LAP2_FIRST, 6, '63'],
    [LAP2_LAST - 2, 2, '108'],
    [LAP2_LAST - 2, 3, '51'],
    [LAP2_LAST, 6, '56'],
    [LAP2_LAST - 1, 6, '55'],
  ];
  it.each(cases)('from %i with a %i → %s', (from, die, want) => {
    const got = targetsFor(from, die)
      .map((t) => (t.lap ? `lap${t.to}` : String(t.to)))
      .join(' ');
    expect(got).toBe(want);
  });

  it.each([
    [45, 6],
    [50, 1],
  ])('with its extra lap used, from %i with a %i only heads home', (from, die) => {
    expect(targetsFor(from, die, false).every((t) => !t.lap)).toBe(true);
    expect(targetsFor(from, die, false)).toHaveLength(1);
  });

  it('targetProgress is the head-home target', () => {
    expect(targetProgress(50, 1)).toBe(51);
    expect(targetProgress(BASE, 3)).toBeNull();
  });
});

describe('rules matrix: the board', () => {
  it.each([
    ['red', 0, 0],
    ['green', 0, 13],
    ['yellow', 0, 26],
    ['blue', 0, 39],
    ['blue', 13, 0],
    ['red', LAST_TRACK, 50],
    ['red', LAP2_FIRST, 51],
    ['green', LAP2_FIRST, 12],
    ['red', 51, null],
    ['red', BASE, null],
    ['red', H, null],
  ] as [Color, number, number | null][])('%s at %i is absolute square %s', (color, progress, abs) => {
    expect(absoluteSquare(color, progress)).toBe(abs);
  });

  it('steps: round again past the home turn, and into the home column after the second lap', () => {
    expect(stepFrom(LAST_TRACK, true)).toBe(LAP2_FIRST);
    expect(stepFrom(LAST_TRACK, false)).toBe(51);
    expect(stepFrom(LAP2_LAST, true)).toBe(51);
    expect(pathCells('red', 48, LAP2_FIRST + 1, 0)).toHaveLength(4);
    expect(pathCells('red', BASE, 0, 2)).toEqual([tokenCell('red', 0, 2)]);
    expect(tokenCell('red', H, 0)).toEqual(tokenCell('red', H, 3));
  });
});

describe('rules matrix: rolling', () => {
  it('a non-6 with everything in base: no moves, turn passes', () => {
    const s = game();
    const events = applyRoll(s, 3);
    expect(events.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
    expect(currentColor(s)).toBe('yellow');
  });

  it('a 6 out of base: roll again, then move', () => {
    const s = game();
    expect(applyRoll(s, 6).map((e) => e.type)).toEqual(['roll']);
    expect(s.turn).toMatchObject({ phase: 'rolling', queue: [6], sixes: 1 });
    applyRoll(s, 2);
    expect(s.turn.phase).toBe('moving');
    expect(legalMoves(s).map((m) => `${m.die}:${m.tokenId}`)).toContain('6:0');
  });

  it('three sixes: the whole queue is lost and the turn passes', () => {
    const s = game();
    s.tokens.red = [10, BASE, BASE, BASE];
    applyRoll(s, 6);
    applyRoll(s, 6);
    const events = applyRoll(s, 6);
    expect(events.map((e) => e.type)).toEqual(['roll', 'penalty', 'turn']);
    expect(s.tokens.red).toEqual([10, BASE, BASE, BASE]);
    expect(currentColor(s)).toBe('yellow');
  });

  it('a six nobody can use (all in the home lane) ends the turn without a re-roll', () => {
    const s = game();
    s.tokens.red = [52, 53, H, H];
    expect(applyRoll(s, 6).map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
  });

  it('refuses bad dice, the wrong phase and a finished game', () => {
    const s = game();
    expect(() => applyRoll(s, 0)).toThrow(RuleError);
    expect(() => applyRoll(s, 7)).toThrow('BAD_DIE');
    expect(() => applyRoll(s, 2.5)).toThrow('BAD_DIE');
    withQueue(s, [3]);
    expect(() => applyRoll(s, 3)).toThrow('WRONG_PHASE');
    s.finished = true;
    expect(() => applyRoll(s, 3)).toThrow('GAME_OVER');
    expect(() => applyMove(s, 0, 0)).toThrow('GAME_OVER');
  });
});

describe('rules matrix: moving and capturing', () => {
  const at = (s: GameState, color: Color, ...tokens: number[]) => {
    s.tokens[color] = [...tokens, BASE, BASE, BASE, BASE].slice(0, 4);
  };

  it('illegal moves are refused: wrong token, wrong die, a lap that is not offered', () => {
    const s = withQueue(game(), [3]);
    at(s, 'red', 10);
    expect(() => applyMove(s, 0, 1)).toThrow('ILLEGAL_MOVE');
    expect(() => applyMove(s, 1, 0)).toThrow('ILLEGAL_MOVE');
    expect(() => applyMove(s, 0, 0, true)).toThrow('ILLEGAL_MOVE');
    const r = game();
    expect(() => applyMove(r, 0, 0)).toThrow('WRONG_PHASE');
  });

  it.each([
    ['a star square', 'yellow', 34 - 26, 32],
    ['a start square', 'yellow', 0, 24],
    ['green start square', 'green', 0, 11],
  ] as [string, Color, number, number][])('no capture on %s', (_name, victim, vp, redFrom) => {
    const s = withQueue(game(['red', victim]), [2]);
    at(s, victim, vp);
    at(s, 'red', redFrom);
    expect(legalMoves(s)[0].captures).toEqual([]);
    applyMove(s, 0, 0);
    expect(s.tokens[victim][0]).toBe(vp);
  });

  it('a capture sends the victim to base, grows the moustache and earns a bonus roll', () => {
    const s = withQueue(game(), [4]);
    at(s, 'yellow', 0 + 5); // absolute 31
    at(s, 'red', 27);
    const events = applyMove(s, 0, 0);
    expect(events.map((e) => e.type)).toEqual(['move', 'capture', 'bonus']);
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(s.kills?.red?.[0]).toBe(1);
    expect(currentColor(s)).toBe('red');
  });

  it('two of the same colour on a plain square are both captured, each worth a bonus roll', () => {
    const s = withQueue(game(), [4]);
    at(s, 'yellow', 5, 5);
    at(s, 'red', 27);
    applyMove(s, 0, 0);
    expect(s.tokens.yellow.slice(0, 2)).toEqual([BASE, BASE]);
    expect(s.kills?.red?.[0]).toBe(2);
    expect(s.turn.bonus).toBe(1);
  });

  it('home with a capture bonus waiting: both bonus rolls are kept', () => {
    const s = withQueue(game(), [4, 1]);
    at(s, 'yellow', 5);
    s.tokens.red = [27, 55, BASE, BASE];
    applyMove(s, 0, 0); // capture
    applyMove(s, 0, 1); // home
    expect(s.turn.phase).toBe('rolling');
    expect(s.turn.bonus).toBe(1);
  });

  it('when no die left can move, the rest of the queue is dropped together', () => {
    const s = withQueue(game(), [6, 5]);
    s.tokens.red = [52, BASE, H, H]; // 6 brings token 1 out, then the 5 can't move anything but token 1
    applyMove(s, 0, 1);
    expect(legalMoves(s).map((m) => m.tokenId)).toEqual([1]);
    // A 2 brings one token home; the 5 left can't move anything: it's dropped and the bonus rolls.
    const t = withQueue(game(), [2, 5]);
    t.tokens.red = [54, 52, H, H];
    const events = applyMove(t, 0, 0);
    expect(events.map((e) => e.type)).toEqual(['move', 'home', 'noMoves', 'bonus']);
    expect(events.find((e) => e.type === 'noMoves')).toMatchObject({ discarded: [5] });
  });

  it('a 3 waiting on a 6 is not dropped: it can move once the 6 has brought a token out', () => {
    const s = withQueue(game(), [3, 6]);
    expect(legalMoves(s).map((m) => m.die)).toEqual([6, 6, 6, 6]);
    applyMove(s, 1, 0);
    expect(s.turn.queue).toEqual([3]);
    expect(legalMoves(s).map((m) => `${m.die}:${m.tokenId}`)).toEqual(['3:0']);
  });

  it('turn order skips finished players and a three-player table wraps around', () => {
    const s = createGameState({ id: 'g', lobbyId: 'l', seats: [seat('blue', 3), seat('red', 1), seat('green', 2)], now: 0 });
    expect(s.seats.map((x) => x.color)).toEqual(['red', 'green', 'blue']);
    s.ranks = ['green'];
    applyRoll(s, 2);
    expect(currentColor(s)).toBe('blue');
    applyRoll(s, 2);
    expect(currentColor(s)).toBe('red');
  });

  it('seat checks: 2 to 4 seats, colours unique', () => {
    expect(() => createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1)] })).toThrow('BAD_SEAT_COUNT');
    expect(() => createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('red', 2)] })).toThrow('DUPLICATE_COLOR');
  });

  it('distinctChoices without a state collapses by die and square only', () => {
    const s = withQueue(game(), [2]);
    s.tokens.red = [10, 10, 12, BASE];
    s.kills = { red: [0, 3, 0, 0] };
    expect(distinctChoices(legalMoves(s))).toHaveLength(2);
    expect(distinctChoices(legalMoves(s), s)).toHaveLength(3);
  });
});
