import { describe, expect, it } from 'vitest';
import { BASE, HIDDEN, absoluteSquare, boardOf, laneEntry, pathCells, raidOf, raidProgress } from '../src/shared/board.js';
import { eventsFor, initialOrbs, viewFor } from '../src/shared/powers.js';
import { applyMove, applyRoll, applySurrender, createGameState, distinctChoices, legalMoves } from '../src/shared/rules.js';
import { chooseMove } from '../src/server/bot.js';
import { POWERS, type Color, type GameState, type Power } from '../src/shared/types.js';
import { seat, withQueue } from './helpers.js';

/**
 * The 4-player board: red starts on 0, green 13, yellow 26, blue 39; the stars are 8, 21, 34, 47;
 * each colour turns into its home column after the square two before its start (red 50, green 11,
 * yellow 24, blue 37), and its column is progress 51 to 55, home 56.
 */
function pgame(
  colors: Color[] = ['red', 'yellow'],
  extra: { teams?: boolean; golden?: Partial<Record<Color, number>>; seed?: number; powerUps?: boolean } = {},
): GameState {
  const s = createGameState({
    id: 'g1',
    lobbyId: 'l1',
    seats: colors.map((c, i) => seat(c, i + 1)),
    now: 0,
    teams: extra.teams,
    ...(extra.powerUps !== false && { powerUps: { seed: extra.seed ?? 42 } }),
    ...(extra.golden && { golden: extra.golden }),
  });
  return s;
}

/** No orbs on the board unless a test puts them there. */
function bare(colors?: Color[], extra?: Parameters<typeof pgame>[1]): GameState {
  const s = pgame(colors, extra);
  s.orbs = [];
  return s;
}

function give(s: GameState, color: Color, tokenId: number, power: Power | null): void {
  ((s.powers ??= {})[color] ??= [null, null, null, null])[tokenId] = power;
}

describe('the orbs', () => {
  it('one on every star, each power once, shuffled per game', () => {
    const s = pgame();
    expect(s.orbs!.map((o) => o.square)).toEqual([8, 21, 34, 47]);
    expect(s.orbs!.map((o) => o.power).sort()).toEqual([...POWERS].sort());
    const layouts = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        pgame(undefined, { seed })
          .orbs!.map((o) => o.power)
          .join(),
      ),
    );
    expect(layouts.size).toBeGreaterThan(2);
    // The same seed, the same layout (the rules have no randomness of their own).
    expect(pgame(undefined, { seed: 9 }).orbs).toEqual(pgame(undefined, { seed: 9 }).orbs);
  });

  it('the 5- and 6-player boards have an orb on each of their stars, every power among them', () => {
    for (const n of [5, 6] as const) {
      const s = createGameState({
        id: 'g',
        lobbyId: 'l',
        seats: boardOf(n)
          .colors.slice(0, 2)
          .map((c, i) => seat(c, i + 1)),
        board: n,
        powerUps: { seed: 7 },
      });
      expect(s.orbs).toHaveLength(n);
      expect(new Set(s.orbs!.map((o) => o.power)).size).toBe(4);
      expect(initialOrbs(s).map((o) => o.square)).toEqual([...boardOf(n).stars].sort((a, b) => a - b));
    }
  });

  it('a token landing on one takes its power; the orb comes back a round later on a star without one', () => {
    const s = pgame();
    s.orbs = [
      { square: 8, power: 'double' },
      { square: 21, power: 'shield' },
    ];
    s.tokens.red[0] = 5;
    withQueue(s, [3]);
    const move = legalMoves(s).find((m) => m.tokenId === 0)!;
    expect(move.orb).toBe('double');
    const events = applyMove(s, 0, 0);
    expect(events).toContainEqual({ type: 'power', color: 'red', tokenId: 0, power: 'double', square: 8 });
    expect(s.powers!.red![0]).toBe('double');
    expect(s.orbs).toEqual([{ square: 21, power: 'shield' }]);
    expect(s.orbsDue).toEqual([1]); // the turn already passed to yellow: one more turn change to go
    // Yellow's turn ends: the orb reappears, not on 21 (taken).
    s.turn.phase = 'rolling';
    const back = applyRoll(s, 2);
    const orb = back.find((e) => e.type === 'orb');
    expect(orb).toBeDefined();
    expect(orb && orb.type === 'orb' && [8, 34, 47]).toContain(orb && orb.type === 'orb' && orb.square);
    expect(s.orbs).toHaveLength(2);
    expect(s.orbsDue).toEqual([]);
  });

  it('passing over an orb does not take it, nor does a game without power ups have any', () => {
    const s = pgame();
    s.orbs = [{ square: 8, power: 'cloak' }];
    s.tokens.red[0] = 5;
    withQueue(s, [5]);
    applyMove(s, 0, 0);
    expect(s.powers!.red?.[0] ?? null).toBeNull();
    expect(s.orbs).toHaveLength(1);
    expect(pgame(undefined, { powerUps: false }).orbs).toBeUndefined();
  });

  it('a new orb replaces the power a token had', () => {
    const s = bare();
    s.orbs = [{ square: 21, power: 'vampire' }];
    s.tokens.red[0] = 18;
    give(s, 'red', 0, 'shield');
    withQueue(s, [3]);
    applyMove(s, 0, 0);
    expect(s.powers!.red![0]).toBe('vampire');
  });
});

describe('2x', () => {
  it('goes twice as far, and counts the squares it went', () => {
    const s = bare();
    s.tokens.red[0] = 10;
    give(s, 'red', 0, 'double');
    withQueue(s, [3]);
    const [m] = legalMoves(s).filter((x) => x.tokenId === 0);
    expect(m).toMatchObject({ from: 10, to: 16, steps: 6, die: 3 });
    const [e] = applyMove(s, 0, 0);
    expect(e).toMatchObject({ type: 'move', to: 16, steps: 6, die: 3 });
    expect(s.stats!.red!.cells).toBe(6);
    // Its path on the board is all six squares.
    expect(pathCells('red', 10, 16, 0)).toHaveLength(6);
  });

  it('near home it goes as rolled when twice would overshoot, so it can always finish', () => {
    const s = bare();
    s.tokens.red[0] = 53;
    give(s, 'red', 0, 'double');
    withQueue(s, [3, 2, 1]);
    const to = (die: number) =>
      legalMoves(s)
        .filter((m) => m.tokenId === 0 && m.die === die)
        .map((m) => m.to);
    expect(to(3)).toEqual([56]); // 6 would overshoot: as rolled
    expect(to(1)).toEqual([55]); // doubled
    expect(to(2)).toEqual([55]); // 4 overshoots: as rolled
  });

  it('a 6 that is only usable doubled still counts as usable', () => {
    const s = bare();
    s.tokens.red = [52, 56, 56, 56];
    give(s, 'red', 0, 'double');
    s.turn.phase = 'rolling';
    // 52 + 6 overshoots, 52 + 12 too: the six is useless and ends the turn.
    expect(applyRoll(s, 6).map((e) => e.type)).toContain('noMoves');
  });
});

describe('shield', () => {
  it('the first capture fails and breaks the shield; the next one captures', () => {
    const s = bare();
    // Yellow on square 20 (its progress 46), shielded.
    s.tokens.yellow[0] = 46;
    give(s, 'yellow', 0, 'shield');
    s.tokens.red[0] = 17;
    s.tokens.red[1] = 18;
    withQueue(s, [3]);
    const hit = legalMoves(s).find((m) => m.tokenId === 0)!;
    expect(hit.captures).toEqual([]);
    expect(hit.breaks).toEqual([{ color: 'yellow', tokenId: 0 }]);
    const events = applyMove(s, 0, 0);
    expect(events).toContainEqual({ type: 'shield', color: 'red', victim: 'yellow', tokenId: 0 });
    expect(events.some((e) => e.type === 'capture')).toBe(false);
    expect(s.tokens.yellow[0]).toBe(46);
    expect(s.powers!.yellow![0]).toBeNull();
    expect(s.turn.bonus).toBe(0); // no capture, no bonus roll
    // Red again: now it's an ordinary token.
    s.turn.seat = 0;
    withQueue(s, [2]);
    expect(legalMoves(s).find((m) => m.tokenId === 1)!.captures).toEqual([{ color: 'yellow', tokenId: 0 }]);
  });
});

describe('the invisibility cloak', () => {
  function cloaked(): GameState {
    const s = bare(['red', 'yellow']);
    s.tokens.yellow[0] = 46; // square 20
    give(s, 'yellow', 0, 'cloak');
    s.tokens.red[0] = 17;
    return withQueue(s, [3]);
  }

  it('is left out of what the opponent and spectators get, with every legal move that would capture it; its owner sees it', () => {
    const s = cloaked();
    const pub = { ...s, legalMoves: legalMoves(s), serverNow: 0 };
    expect(pub.legalMoves.find((m) => m.tokenId === 0)!.captures).toEqual([{ color: 'yellow', tokenId: 0 }]);
    for (const viewer of ['red', null] as const) {
      const v = viewFor(pub, viewer);
      expect(v.tokens.yellow[0]).toBe(HIDDEN);
      expect(v.legalMoves.find((m) => m.tokenId === 0)!.captures).toEqual([]);
      expect(JSON.stringify(v)).not.toContain('"orbSeed"');
    }
    expect(viewFor(pub, 'yellow').tokens.yellow[0]).toBe(46);
    // Nothing is hidden once the game is over.
    expect(viewFor({ ...pub, finished: true }, 'red').tokens.yellow[0]).toBe(46);
  });

  it("the owner's moves with it reach only the owner (and a teammate)", () => {
    const s = bare(['red', 'green', 'yellow', 'blue'], { teams: true });
    s.turn.seat = 2; // yellow
    s.tokens.yellow[0] = 10;
    give(s, 'yellow', 0, 'cloak');
    withQueue(s, [2]);
    const events = applyMove(s, 0, 0);
    expect(events[0]).toMatchObject({ type: 'move', color: 'yellow', cloaked: true });
    expect(eventsFor(s, events, 'yellow').some((e) => e.type === 'move')).toBe(true);
    expect(eventsFor(s, events, 'red').some((e) => e.type === 'move')).toBe(true); // red is yellow's partner
    expect(eventsFor(s, events, 'green').some((e) => e.type === 'move')).toBe(false);
    expect(eventsFor(s, events, null).some((e) => e.type === 'move')).toBe(false);
    expect(viewFor(s, 'red').tokens.yellow[0]).toBe(12);
    expect(viewFor(s, 'blue').tokens.yellow[0]).toBe(HIDDEN);
  });

  it('landing on it blindly still captures it, and the cloak is gone', () => {
    const s = cloaked();
    const events = applyMove(s, 0, 0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'capture', victim: 'yellow', tokenId: 0, from: 46 }));
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(s.powers!.yellow![0]).toBeNull();
  });

  it("a bot judges the board as its player sees it: an opponent's cloaked token neither tempts nor scares it", () => {
    const s = bare(['red', 'yellow']);
    s.tokens.red[0] = 10;
    s.tokens.red[1] = 20;
    s.tokens.yellow[0] = 38; // square 12, two ahead of red's first token
    withQueue(s, [2]);
    expect(chooseMove(s)!.tokenId).toBe(0); // a capture, seen
    give(s, 'yellow', 0, 'cloak');
    expect(chooseMove(s)!.tokenId).toBe(1); // not seen: just the furthest token on
  });
});

describe('the vampire', () => {
  it("may turn into an opponent's home column where it passes their turn, capturing there", () => {
    const s = bare(['red', 'blue']);
    s.tokens.red[0] = 35;
    give(s, 'red', 0, 'vampire');
    s.tokens.blue[0] = 52; // up its own column, 2 squares in
    withQueue(s, [4]);
    const options = legalMoves(s).filter((m) => m.tokenId === 0);
    expect(options.map((m) => ({ to: m.to, raid: m.raid }))).toEqual([
      { to: 39, raid: undefined },
      { to: raidProgress('blue', 2), raid: 'blue' },
    ]);
    expect(options[1].captures).toEqual([{ color: 'blue', tokenId: 0 }]);
    // Its path: along the track to blue's turn (square 37), then up blue's column.
    const b = boardOf(4);
    expect(pathCells('red', 35, raidProgress('blue', 2), 0, b, 'blue')).toEqual([b.track[36], b.track[37], b.homeColumn.blue![0], b.homeColumn.blue![1]]);
    const events = applyMove(s, 0, 0, false, undefined, 'blue');
    expect(events[0]).toMatchObject({ type: 'move', to: raidProgress('blue', 2), via: 'blue' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'capture', victim: 'blue', tokenId: 0, from: 52 }));
    expect(s.tokens.blue[0]).toBe(BASE);
    expect(events.at(-1)).toEqual({ type: 'bonus', color: 'red' }); // a capture's bonus roll
  });

  it("comes out at that player's start square by reaching their home exactly", () => {
    const s = bare(['red', 'blue']);
    s.tokens.red[0] = raidProgress('blue', 2);
    give(s, 'red', 0, 'vampire');
    withQueue(s, [5, 4]);
    expect(legalMoves(s).filter((m) => m.tokenId === 0 && m.die === 5)).toEqual([]); // overshoots
    const out = legalMoves(s).find((m) => m.tokenId === 0 && m.die === 4)!;
    expect(out.to).toBe(39);
    expect(absoluteSquare('red', out.to)).toBe(39); // blue's start
    applyMove(s, 1, 0);
    expect(s.tokens.red[0]).toBe(39);
    expect(s.powers!.red![0]).toBe('vampire'); // kept until captured or home
  });

  it('a 6 from the turn square goes in and straight out again', () => {
    const s = bare(['red', 'blue']);
    s.tokens.red[0] = 37; // on blue's turn square
    give(s, 'red', 0, 'vampire');
    withQueue(s, [6]);
    const raid = legalMoves(s).find((m) => m.raid === 'blue')!;
    expect(raid.to).toBe(39);
    const b = boardOf(4);
    expect(pathCells('red', 37, 39, 0, b, 'blue')).toEqual([...b.homeColumn.blue!, b.homeSpot.blue!, b.track[39]]);
  });

  it('the owner coming up their own column captures a vampire there', () => {
    const s = bare(['red', 'blue'], {});
    s.turn.seat = 1; // blue
    s.tokens.red[0] = raidProgress('blue', 2);
    give(s, 'red', 0, 'vampire');
    s.tokens.blue[0] = 50;
    withQueue(s, [2]);
    const m = legalMoves(s).find((x) => x.tokenId === 0)!;
    expect(m.captures).toEqual([{ color: 'red', tokenId: 0 }]);
    applyMove(s, 0, 0);
    expect(s.tokens.red[0]).toBe(BASE);
    expect(s.powers!.red![0]).toBeNull();
  });

  it("in Team-up it leaves the partner's column alone", () => {
    const s = bare(['red', 'green', 'yellow', 'blue'], { teams: true });
    s.tokens.red[0] = 22; // two before yellow's turn (24)
    give(s, 'red', 0, 'vampire');
    withQueue(s, [4]);
    expect(laneEntry('yellow')).toBe(24);
    expect(
      legalMoves(s)
        .filter((m) => m.tokenId === 0)
        .map((m) => m.raid),
    ).toEqual([undefined]);
  });

  it('on its second lap it comes out on its second lap, and only a vampire can raid', () => {
    const s = bare(['red', 'green']);
    s.tokens.red[0] = 64; // second lap, square 6 + … : 64 - 6 = 58 → square 6
    give(s, 'red', 0, 'vampire');
    withQueue(s, [6]);
    // Green's turn is square 11: 5 on, then 1 up the column.
    const raid = legalMoves(s).find((m) => m.raid === 'green')!;
    expect(raidOf(raid.to)).toEqual({ lane: 'green', step: 1, secondLap: true });
    applyMove(s, 0, 0, false, undefined, 'green');
    s.turn.seat = 0;
    withQueue(s, [5]);
    const out = legalMoves(s).find((m) => m.tokenId === 0)!;
    expect(absoluteSquare('red', out.to)).toBe(13);
    expect(out.to).toBeGreaterThanOrEqual(57); // still the second lap
    give(s, 'red', 0, null);
    s.tokens.red[0] = 9;
    expect(
      legalMoves(s)
        .filter((m) => m.tokenId === 0)
        .every((m) => !m.raid),
    ).toBe(true);
  });

  it('the server rejects a raid that is not on offer', () => {
    const s = bare(['red', 'blue']);
    s.tokens.red[0] = 35;
    withQueue(s, [4]);
    expect(() => applyMove(s, 0, 0, false, undefined, 'blue')).toThrow('ILLEGAL_MOVE');
  });
});

describe('the golden token', () => {
  it('leaves base on any roll; the others still need a 6', () => {
    const s = bare(['red', 'yellow'], { golden: { red: 2, yellow: 0 } });
    expect(s.golden).toEqual({ red: 2, yellow: 0 });
    s.turn.phase = 'rolling';
    const events = applyRoll(s, 3);
    expect(events.map((e) => e.type)).toEqual(['roll']); // a move to make, not "no moves"
    expect(legalMoves(s).map((m) => [m.tokenId, m.to])).toEqual([[2, 0]]);
    withQueue(s, [6]);
    expect(legalMoves(s).map((m) => m.tokenId)).toEqual([0, 1, 2, 3]);
    // With a 6 the golden token and an ordinary one are different choices.
    expect(distinctChoices(legalMoves(s), s).map((m) => m.tokenId)).toEqual([0, 2]);
  });

  it('a capture sends it to its start square, not to base', () => {
    const s = createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('yellow', 2)], golden: { red: 0, yellow: 1 } });
    s.tokens.yellow[1] = 46; // square 20
    s.tokens.red[0] = 17;
    withQueue(s, [3]);
    const events = applyMove(s, 0, 0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'capture', victim: 'yellow', tokenId: 1, to: 0 }));
    expect(s.tokens.yellow[1]).toBe(0);
    expect(s.kills!.yellow![1]).toBe(0);
  });

  it('a surrender still sends it to base; powers go with a surrender and with getting home', () => {
    const s = bare(['red', 'yellow', 'green'], { golden: { red: 0 } });
    s.tokens.red[0] = 12;
    give(s, 'red', 0, 'shield');
    applySurrender(s, 'red');
    expect(s.tokens.red[0]).toBe(BASE);
    expect(s.powers!.red).toEqual([null, null, null, null]);
    const t = bare();
    t.tokens.red[0] = 54;
    give(t, 'red', 0, 'double');
    withQueue(t, [2]);
    applyMove(t, 0, 0);
    expect(t.tokens.red[0]).toBe(56);
    expect(t.powers!.red![0]).toBeNull();
  });
});
