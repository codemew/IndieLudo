/**
 * The 5- and 6-player boards: built by the same generator that, for 4 players, gives today's
 * board square for square. Checked as shapes: the track is one unbroken loop, nothing overlaps,
 * and every base and home spot sits on the board.
 */
import { describe, expect, it } from 'vitest';
import { BASE, BOARD_SIZES, HOME_COLUMN, TRACK, absoluteSquare, baseCentre, boardFor, boardOf, generateBoard, isSafeSquare, isSecondLap, onTrack, pathCells, stepFrom, tokenCell, type Board, type BoardSize } from '../src/shared/board.js';
import type { Color } from '../src/shared/types.js';

const centreOf = ([x, y]: readonly [number, number]): [number, number] => [x + 0.5, y + 0.5];
const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Inside the board's outline (a convex polygon), with a margin. */
function inside(b: Board, p: readonly [number, number], margin = 0): boolean {
  const o = b.shapes!.outline;
  const mid = o.reduce((a, q) => [a[0] + q[0] / o.length, a[1] + q[1] / o.length], [0, 0]);
  return o.every((q, i) => {
    const r = o[(i + 1) % o.length];
    // Distance from p to the edge q→r, on the side the middle is on.
    const nx = r[1] - q[1];
    const ny = q[0] - r[0];
    const len = Math.hypot(nx, ny);
    const side = ((mid[0] - q[0]) * nx + (mid[1] - q[1]) * ny) / len;
    const d = ((p[0] - q[0]) * nx + (p[1] - q[1]) * ny) / len;
    return Math.sign(d) === Math.sign(side) && Math.abs(d) >= margin;
  });
}

describe('the 4-player board', () => {
  it('the generator gives today’s track and home columns exactly', () => {
    const g = generateBoard(4, ['red', 'green', 'yellow', 'blue']);
    expect(g.track).toEqual(TRACK);
    for (const c of ['red', 'green', 'yellow', 'blue'] as Color[]) expect(g.homeColumn[c]).toEqual(HOME_COLUMN[c]);
    expect([g.w, g.h]).toEqual([15, 15]);
  });

  it('keeps today’s numbers, and old games without a board are on it', () => {
    const b = boardOf(4);
    expect([b.trackLength, b.last, b.home, b.lap2First, b.lap2Last]).toEqual([52, 50, 56, 57, 108]);
    expect([...b.safe].sort((x, y) => x - y)).toEqual([0, 8, 13, 21, 26, 34, 39, 47]);
    expect(boardFor({})).toBe(b);
    expect(boardOf(7 as BoardSize)).toBe(b);
  });
});

describe.each([5, 6] as const)('the %i-player board', (n) => {
  const b = boardOf(n);

  it('has 13 squares per player and the numbers that follow', () => {
    expect(b.colors).toHaveLength(n);
    expect(b.track).toHaveLength(13 * n);
    expect([b.trackLength, b.last, b.home, b.lap2First, b.lap2Last]).toEqual([13 * n, 13 * n - 2, 13 * n + 4, 13 * n + 5, 26 * n + 4]);
    expect(b.safe.size).toBe(2 * n);
    expect(b.colors.map((c) => b.start[c])).toEqual(b.colors.map((_, k) => 13 * k));
  });

  it('the track is one loop: each square touches the next, by an edge or (turning a corner) diagonally', () => {
    for (let i = 0; i < b.trackLength; i++) {
      const d = dist(centreOf(b.track[i]), centreOf(b.track[(i + 1) % b.trackLength]));
      expect(d === 1 || Math.abs(d - 1) < 1e-6 || (d > 1 && d < 1.5), `squares ${i} → ${i + 1}: ${d}`).toBe(true);
    }
  });

  it('no two squares overlap, and every square is on the board', () => {
    const all = [...b.track, ...b.colors.flatMap((c) => b.homeColumn[c]!)].map(centreOf) as [number, number][];
    for (let i = 0; i < all.length; i++) {
      expect(inside(b, all[i], 0.45)).toBe(true);
      for (let j = i + 1; j < all.length; j++) expect(dist(all[i], all[j])).toBeGreaterThan(0.99);
    }
  });

  it('each home column leads from the arm end to the centre, next to the last track square', () => {
    for (const c of b.colors) {
      const col = b.homeColumn[c]!.map(centreOf) as [number, number][];
      const last = centreOf(b.track[absoluteSquare(c, b.last, b)!]) as [number, number];
      expect(dist(last, col[0])).toBeCloseTo(1, 5);
      for (let i = 1; i < col.length; i++) expect(dist(col[i - 1], col[i])).toBeCloseTo(1, 5);
      expect(dist(col[4], b.shapes!.middle)).toBeLessThan(dist(col[0], b.shapes!.middle));
    }
  });

  it('bases: four slots apart from each other and the track; home spots in the centre', () => {
    const squares = b.track.map(centreOf) as [number, number][];
    for (const c of b.colors) {
      const slots = b.baseSlots[c]!.map(centreOf) as [number, number][];
      for (const s of slots) {
        expect(inside(b, s, 0.5)).toBe(true);
        for (const q of squares) expect(dist(s, q)).toBeGreaterThan(1);
      }
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(dist(slots[i], slots[j])).toBeGreaterThan(1.1);
      // The base sits beside its own start square.
      const start = centreOf(b.track[b.start[c]!]) as [number, number];
      const others = b.colors.filter((o) => o !== c).map((o) => dist(baseCentre(o, b), start));
      expect(dist(baseCentre(c, b), start)).toBeLessThan(Math.min(...others));
      expect(dist(centreOf(b.homeSpot[c]!) as [number, number], b.shapes!.middle)).toBeLessThan(1.5);
    }
  });

  it('progress maps onto it like on today’s board: start, wrap, home column, second lap, home', () => {
    const c = b.colors[n - 1];
    expect(absoluteSquare(c, 0, b)).toBe(13 * (n - 1));
    expect(absoluteSquare(c, 13, b)).toBe(0); // round past the end of the track
    expect(absoluteSquare(c, b.last + 1, b)).toBeNull();
    expect(absoluteSquare(c, b.lap2First, b)).toBe((13 * (n - 1) + b.last + 1) % b.trackLength);
    expect([isSecondLap(b.lap2Last, b), onTrack(b.lap2Last, b), onTrack(b.last + 1, b)]).toEqual([true, true, false]);
    expect(isSafeSquare((13 * (n - 1) + 8) % b.trackLength, b)).toBe(true);
    expect(tokenCell(c, BASE, 2, b)).toEqual(b.baseSlots[c]![2]);
    expect(tokenCell(c, b.home, 0, b)).toEqual(b.homeSpot[c]);
    expect(tokenCell(c, b.last + 3, 0, b)).toEqual(b.homeColumn[c]![2]);
    expect(stepFrom(b.last, true, b)).toBe(b.lap2First);
    expect(stepFrom(b.lap2Last, false, b)).toBe(b.last + 1);
    expect(pathCells(c, b.last - 1, b.last + 2, 0, b)).toEqual([b.track[absoluteSquare(c, b.last, b)!], b.homeColumn[c]![0], b.homeColumn[c]![1]]);
    expect(pathCells(c, BASE, 0, 0, b)).toEqual([b.track[13 * (n - 1)]]);
  });
});

it('every board size is listed once', () => {
  expect(BOARD_SIZES).toEqual([4, 5, 6]);
  expect(new Set(BOARD_SIZES.flatMap((n) => boardOf(n).colors)).size).toBe(6);
});
