import { describe, expect, it } from 'vitest';
import { BASE, HOME, START_INDEX, TRACK, absoluteSquare } from '../src/shared/board.js';
import { RuleError, applyMove, applyRoll, currentColor, distinctChoices, legalMoves } from '../src/shared/rules.js';
import { COLORS } from '../src/shared/types.js';
import { game, withQueue } from './helpers.js';

describe('board geometry', () => {
  it('has 52 distinct track squares', () => {
    expect(TRACK).toHaveLength(52);
    expect(new Set(TRACK.map((c) => c.join(','))).size).toBe(52);
  });

  it('maps progress to absolute squares with wrap-around for every colour', () => {
    for (const color of COLORS) {
      expect(absoluteSquare(color, 0)).toBe(START_INDEX[color]);
      for (let p = 0; p <= 50; p++) expect(absoluteSquare(color, p)).toBe((START_INDEX[color] + p) % 52);
      expect(absoluteSquare(color, BASE)).toBeNull();
      expect(absoluteSquare(color, 51)).toBeNull();
    }
    expect(absoluteSquare('blue', 13)).toBe(0);
    expect(absoluteSquare('green', 50)).toBe(11);
  });

  it('places the last track square of each colour next to its home column', () => {
    // Progress 50 must be adjacent to progress 51 (the first home column square).
    expect(TRACK[absoluteSquare('red', 50)!]).toEqual([0, 7]);
    expect(TRACK[absoluteSquare('green', 50)!]).toEqual([7, 0]);
    expect(TRACK[absoluteSquare('yellow', 50)!]).toEqual([14, 7]);
    expect(TRACK[absoluteSquare('blue', 50)!]).toEqual([7, 14]);
  });
});

describe('leaving base', () => {
  it('needs a 6', () => {
    const s = withQueue(game(), [6]);
    expect(legalMoves(s).map((m) => m.tokenId)).toEqual([0, 1, 2, 3]);
    expect(legalMoves(s).every((m) => m.from === BASE && m.to === 0)).toBe(true);
  });

  it('skips the moving phase when a 1-5 is rolled with every token in base', () => {
    for (const v of [1, 2, 3, 4, 5]) {
      const s = game();
      const events = applyRoll(s, v);
      expect(events.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
      expect(currentColor(s)).toBe('yellow');
      expect(s.turn).toMatchObject({ phase: 'rolling', queue: [], sixes: 0 });
    }
  });
});

describe('moving', () => {
  it('enters the home column after progress 50', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red[0] = 49;
    applyMove(s, 0, 0);
    expect(s.tokens.red[0]).toBe(52);
    expect(absoluteSquare('red', 52)).toBeNull();
  });

  it('requires an exact roll to finish', () => {
    const s = withQueue(game(), [5, 1]);
    s.tokens.red = [53, BASE, BASE, BASE];
    const moves = legalMoves(s);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ die: 1, tokenId: 0, to: 54 });
  });

  it('lets a token land exactly on home', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [53, 10, BASE, BASE];
    const events = applyMove(s, 0, 0);
    expect(s.tokens.red[0]).toBe(HOME);
    expect(events.some((e) => e.type === 'home')).toBe(true);
    expect(legalMoves({ ...s, turn: { ...s.turn, phase: 'moving', queue: [1] } }).some((m) => m.tokenId === 0)).toBe(false);
  });

  it('reaching home grants a bonus roll', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [53, 10, BASE, BASE];
    const events = applyMove(s, 0, 0);
    expect(events.map((e) => e.type)).toEqual(['move', 'home', 'bonus']);
    expect(currentColor(s)).toBe('red');
    expect(s.turn).toMatchObject({ phase: 'rolling', queue: [], sixes: 0, bonus: 0 });
  });

  it('a home bonus waits until the queued dice are spent', () => {
    const s = withQueue(game(), [3, 2]);
    s.tokens.red = [53, 10, BASE, BASE];
    expect(applyMove(s, 0, 0).map((e) => e.type)).toEqual(['move', 'home']);
    expect(s.turn).toMatchObject({ phase: 'moving', queue: [2], bonus: 1 });
    expect(applyMove(s, 0, 1).map((e) => e.type)).toEqual(['move', 'bonus']);
    expect(currentColor(s)).toBe('red');
  });

  it('home and capture bonuses add up', () => {
    const s = withQueue(game(), [3, 3]);
    s.tokens.red = [53, 2, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5 = red progress 5
    applyMove(s, 0, 0); // home
    applyMove(s, 0, 1); // capture
    expect(s.turn.bonus).toBe(1); // one already used to start the next roll
    expect(s.turn.phase).toBe('rolling');
    applyRoll(s, 2); // red's tokens: home, 5 → 7 is legal
    expect(currentColor(s)).toBe('red');
  });

  it('the last token reaching home gives no bonus: that player is done', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [2]);
    s.tokens.red = [HOME, HOME, HOME, 54];
    const events = applyMove(s, 0, 3);
    expect(events.map((e) => e.type)).not.toContain('bonus');
    expect(currentColor(s)).toBe('green');
  });

  it('rejects illegal moves', () => {
    const s = withQueue(game(), [3]);
    expect(() => applyMove(s, 0, 0)).toThrow(RuleError);
    expect(() => applyMove(s, 5, 0)).toThrow('ILLEGAL_MOVE');
    const r = game();
    expect(() => applyMove(r, 0, 0)).toThrow('WRONG_PHASE');
  });

  it('returns explicit move objects', () => {
    const s = withQueue(game(), [4]);
    s.tokens.red = [2, BASE, BASE, BASE];
    expect(legalMoves(s)).toEqual([{ dieIndex: 0, die: 4, tokenId: 0, from: 2, to: 6, captures: [] }]);
  });
});

describe('captures', () => {
  it('sends an opponent on a normal square back to base and grants a bonus roll', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    // Yellow progress 31 is absolute (26 + 31) % 52 = 5, which red reaches with 2 + 3.
    s.tokens.yellow = [31, BASE, BASE, BASE];
    const events = applyMove(s, 0, 0);
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(events.map((e) => e.type)).toEqual(['move', 'capture', 'bonus']);
    expect(currentColor(s)).toBe('red');
    expect(s.turn.phase).toBe('rolling');
  });

  it('never captures on start squares or stars', () => {
    const s = withQueue(game(), [6]);
    s.tokens.red = [2, BASE, BASE, BASE];
    // Absolute 8 is a star: yellow progress 34 → (26 + 34) % 52 = 8.
    s.tokens.yellow = [34, BASE, BASE, BASE];
    const m = legalMoves(s).find((x) => x.tokenId === 0)!;
    expect(m.to).toBe(8);
    expect(m.captures).toEqual([]);
    applyMove(s, 0, 0);
    expect(s.tokens.yellow[0]).toBe(34);

    // Leaving base onto your start square never captures either.
    const t = withQueue(game(), [6]);
    t.tokens.yellow = [26, BASE, BASE, BASE]; // absolute 0 = red's start
    expect(legalMoves(t).find((x) => x.from === BASE)!.captures).toEqual([]);
  });

  it('captures every opponent token on the square', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.green = [44, BASE, BASE, BASE]; // (13 + 44) % 52 = 5
    s.tokens.yellow = [31, 31, BASE, BASE]; // (26 + 31) % 52 = 5
    const events = applyMove(s, 0, 0);
    expect(events.filter((e) => e.type === 'capture')).toHaveLength(3);
    expect(s.tokens.green[0]).toBe(BASE);
    expect(s.tokens.yellow.slice(0, 2)).toEqual([BASE, BASE]);
    expect(s.turn.bonus).toBe(2);
  });

  it('the first capture of the game is first blood, once', () => {
    const s = withQueue(game(), [3]);
    expect(s.firstBlood).toBe(false);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5
    const first = applyMove(s, 0, 0).filter((e) => e.type === 'capture');
    expect(first).toEqual([expect.objectContaining({ victim: 'yellow', firstBlood: true })]);
    expect(s.firstBlood).toBe(true);

    // The bonus roll: red captures again, and it is not first blood any more.
    s.turn = { ...s.turn, phase: 'moving', queue: [1] };
    s.tokens.yellow = [32, BASE, BASE, BASE]; // absolute 6
    const second = applyMove(s, 0, 0).filter((e) => e.type === 'capture');
    expect(second).toHaveLength(1);
    expect(second[0]).not.toHaveProperty('firstBlood');
  });

  it('a first move that captures several tokens is first blood only once', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.green = [44, BASE, BASE, BASE];
    s.tokens.yellow = [31, 31, BASE, BASE];
    const caps = applyMove(s, 0, 0).filter((e) => e.type === 'capture');
    expect(caps.filter((e) => 'firstBlood' in e)).toHaveLength(1);
    expect(caps[0]).toMatchObject({ firstBlood: true });
  });

  it('a game saved before first blood existed treats its next capture as the first', () => {
    const s = withQueue(game(), [3]);
    delete s.firstBlood;
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE];
    expect(applyMove(s, 0, 0).find((e) => e.type === 'capture')).toMatchObject({ firstBlood: true });
  });

  it('does not capture tokens in a home column', () => {
    const s = withQueue(game(), [1]);
    s.tokens.red = [51, BASE, BASE, BASE];
    expect(legalMoves(s)[0].captures).toEqual([]);
  });
});

describe('dice queue and the three-sixes penalty', () => {
  it('[6,4]: keeps rolling after a six, then moves with both dice', () => {
    const s = game();
    s.tokens.red = [10, BASE, BASE, BASE];
    applyRoll(s, 6);
    expect(s.turn).toMatchObject({ phase: 'rolling', queue: [6], sixes: 1 });
    applyRoll(s, 4);
    expect(s.turn).toMatchObject({ phase: 'moving', queue: [6, 4] });
    applyMove(s, 0, 1); // bring a token out with the 6
    expect(s.turn.queue).toEqual([4]);
    applyMove(s, 0, 0);
    expect(s.tokens.red.slice(0, 2)).toEqual([14, 0]);
    expect(currentColor(s)).toBe('yellow');
  });

  it('[6,6,3]: two sixes are fine', () => {
    const s = game();
    applyRoll(s, 6);
    applyRoll(s, 6);
    applyRoll(s, 3);
    expect(s.turn).toMatchObject({ phase: 'moving', queue: [6, 6, 3], sixes: 2 });
  });

  it('[6,6,6]: nullifies the turn without moving any token', () => {
    const s = game();
    s.tokens.red = [10, BASE, BASE, BASE];
    const before = structuredClone(s.tokens);
    applyRoll(s, 6);
    applyRoll(s, 6);
    const events = applyRoll(s, 6);
    expect(events.map((e) => e.type)).toEqual(['roll', 'penalty', 'turn']);
    expect(s.tokens).toEqual(before);
    expect(currentColor(s)).toBe('yellow');
    expect(s.turn).toMatchObject({ phase: 'rolling', queue: [], sixes: 0, bonus: 0 });
  });

  it('lets the player choose which die to play first, and order changes the outcome', () => {
    // Red at 0 with [2, 3]. Yellow sits on absolute 2 (not safe).
    const setup = () => {
      const s = withQueue(game(), [2, 3]);
      s.tokens.red = [0, BASE, BASE, BASE];
      s.tokens.yellow = [28, BASE, BASE, BASE]; // (26 + 28) % 52 = 2
      return s;
    };
    const a = setup();
    applyMove(a, 0, 0); // play the 2 first: lands on yellow
    expect(a.tokens.yellow[0]).toBe(BASE);
    expect(a.turn.bonus).toBe(1);

    const b = setup();
    applyMove(b, 1, 0); // play the 3 first: passes over, no capture
    expect(b.tokens.yellow[0]).toBe(28);
    expect(b.turn.queue).toEqual([2]);
  });

  it('[6,3] with all tokens in base keeps the 3 until the 6 brings a token out', () => {
    const s = game();
    applyRoll(s, 6);
    applyRoll(s, 3);
    expect(s.turn.phase).toBe('moving');
    expect(legalMoves(s).every((m) => m.die === 6)).toBe(true);
    applyMove(s, 0, 2);
    expect(s.turn.queue).toEqual([3]);
    expect(legalMoves(s)).toEqual([expect.objectContaining({ die: 3, tokenId: 2, from: 0, to: 3 })]);
  });

  it('ends the turn when a leftover die cannot be used after a move', () => {
    const s = withQueue(game(), [1, 5]);
    s.tokens.red = [54, HOME, HOME, BASE];
    applyMove(s, 0, 0); // 54 → 55; the 5 can't move anything
    expect(currentColor(s)).toBe('yellow');
  });

  it('a bonus roll after a capture resets the six counter', () => {
    const s = game();
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [32, BASE, BASE, BASE]; // absolute 6
    applyRoll(s, 6);
    applyRoll(s, 6);
    applyRoll(s, 4);
    applyMove(s, 2, 0); // 2 → 6 captures yellow
    // The two sixes are still queued; spend them.
    applyMove(s, 0, 1);
    applyMove(s, 0, 2);
    expect(s.turn).toMatchObject({ phase: 'rolling', sixes: 0, queue: [], bonus: 0 });
    expect(currentColor(s)).toBe('red');
    applyRoll(s, 6);
    applyRoll(s, 6);
    expect(s.turn.phase).toBe('rolling');
    expect(currentColor(s)).toBe('red');
  });

  it('a six no token can use ends the turn at once: no extra roll', () => {
    // Only tokens in the home lane are left: 51 + 6 already overshoots home.
    for (const tokens of [
      [HOME, HOME, HOME, 51],
      [HOME, 52, HOME, 55],
      [53, 54, 55, 51],
    ]) {
      const s = game();
      s.tokens.red = [...tokens];
      const events = applyRoll(s, 6);
      expect(events.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
      expect(currentColor(s)).toBe('yellow');
      expect(s.turn).toMatchObject({ phase: 'rolling', queue: [], sixes: 0 });
    }
  });

  it('a six still rolls again while any token can use it', () => {
    for (const tokens of [
      [HOME, HOME, 52, BASE], // a token in base can come out
      [HOME, HOME, 52, 50], // a token on the track can move 6
    ]) {
      const s = game();
      s.tokens.red = [...tokens];
      applyRoll(s, 6);
      expect(s.turn).toMatchObject({ phase: 'rolling', queue: [6], sixes: 1 });
      expect(currentColor(s)).toBe('red');
    }
  });

  it('home-lane tokens still move with smaller rolls', () => {
    const s = game();
    s.tokens.red = [HOME, HOME, HOME, 52];
    applyRoll(s, 4);
    expect(legalMoves(s)).toEqual([expect.objectContaining({ tokenId: 3, from: 52, to: 56 })]);
  });

  it('only accepts dice values 1-6 in the rolling phase', () => {
    const s = game();
    expect(() => applyRoll(s, 0)).toThrow('BAD_DIE');
    expect(() => applyRoll(s, 7)).toThrow('BAD_DIE');
    expect(() => applyRoll(withQueue(game(), [3]), 3)).toThrow('WRONG_PHASE');
  });
});

describe('turn order, ranking and game end', () => {
  it('skips players who have finished', () => {
    const s = game(['red', 'green', 'yellow']);
    s.tokens.green = [HOME, HOME, HOME, HOME];
    s.ranks = ['green'];
    applyRoll(s, 2); // red has no moves
    expect(currentColor(s)).toBe('yellow');
  });

  it('ranks players and ends the game when one is left', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [1]);
    s.tokens.red = [HOME, HOME, HOME, 55];
    let events = applyMove(s, 0, 3);
    expect(s.ranks).toEqual(['red']);
    expect(events.map((e) => e.type)).toEqual(['move', 'home', 'rank', 'turn']);
    expect(currentColor(s)).toBe('green');
    expect(s.finished).toBe(false);

    withQueue(s, [2]);
    s.tokens.green = [HOME, HOME, HOME, 54];
    events = applyMove(s, 0, 3);
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual(['red', 'green', 'yellow']);
    expect(events.at(-1)).toEqual({ type: 'gameOver', ranks: ['red', 'green', 'yellow'] });
    expect(() => applyRoll(s, 3)).toThrow('GAME_OVER');
  });

  it('a pending capture bonus is dropped once the player finishes', () => {
    const s = withQueue(game(['red', 'green', 'yellow']), [3, 2]);
    s.tokens.red = [HOME, HOME, 2, 54];
    s.tokens.yellow = [31, BASE, BASE, BASE]; // absolute 5
    applyMove(s, 0, 2); // 2 → 5 captures yellow: bonus pending
    expect(s.turn.bonus).toBe(1);
    // Pretend token 2 already made it home, so token 3 (54 → 56) is the last one in.
    s.tokens.red[2] = HOME;
    applyMove(s, 0, 3);
    expect(s.ranks).toEqual(['red']);
    expect(currentColor(s)).toBe('green');
    expect(s.turn).toMatchObject({ bonus: 0, phase: 'rolling' });
  });
});

describe('distinctChoices', () => {
  it('collapses equivalent moves so a forced move can be auto-played', () => {
    const s = withQueue(game(), [6]);
    expect(legalMoves(s)).toHaveLength(4);
    expect(distinctChoices(legalMoves(s))).toHaveLength(1);
    s.tokens.red = [5, BASE, BASE, BASE];
    expect(distinctChoices(legalMoves(s))).toHaveLength(2);
  });
});
