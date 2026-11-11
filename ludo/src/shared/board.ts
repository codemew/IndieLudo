import { ALL_COLORS, type Color } from './types.js';

/**
 * Token progress is relative to its own colour. On the 4-player board:
 *   -1        in base
 *   0..50     main track (0 = own start square)
 *   51..55    own home column
 *   56        home (finished)
 *   57..108   a second lap of the main track: a token about to turn into its home column may go
 *             round once more. 57 is the square just before its start, 108 the last square before
 *             its home column again; from there it turns home like on the first lap.
 * The 5- and 6-player boards have 13 more track squares per extra player, so every number after
 * the start moves up by 13 or 26 (see Board: last, home, lap2First, lap2Last).
 */
export const BASE = -1;
/** Power ups: an opponent's cloaked token, as a phone that may not see it gets it (never in the server's own state). */
export const HIDDEN = -2;

/**
 * Power ups: a vampire in another player's home column ("raiding" it). Progress below -10 says
 * whose column (`lane`), how far up it is (`step`, 1 to 5) and whether the vampire came in on its
 * second lap (it comes out on the same lap). See raidOf.
 */
export function raidProgress(lane: Color, step: number, secondLap = false): number {
  return -(10 * (ALL_COLORS.indexOf(lane) + 1) + step + (secondLap ? 100 : 0));
}

export function raidOf(progress: number): { lane: Color; step: number; secondLap: boolean } | null {
  if (progress > -10) return null;
  const n = -progress;
  const secondLap = n >= 100;
  const m = secondLap ? n - 100 : n;
  const lane = ALL_COLORS[Math.floor(m / 10) - 1];
  const step = m % 10;
  return lane && step >= 1 && step <= 5 ? { lane, step, secondLap } : null;
}

export type BoardSize = 4 | 5 | 6;
export const BOARD_SIZES: readonly BoardSize[] = [4, 5, 6];

/** Grid position (in square units) of a one-square box's top-left corner. */
export type Cell = readonly [col: number, row: number];
type Pt = readonly [x: number, y: number];

export interface Board {
  n: BoardSize;
  /** The seats' colours, clockwise; seat k's start square is 13k. */
  colors: readonly Color[];
  trackLength: number;
  /** Progress of a token's last track square before its home column. */
  last: number;
  home: number;
  lap2First: number;
  lap2Last: number;
  start: Partial<Record<Color, number>>;
  /** Start squares plus the stars, as absolute track indexes. */
  safe: ReadonlySet<number>;
  stars: ReadonlySet<number>;
  track: readonly Cell[];
  homeColumn: Partial<Record<Color, readonly Cell[]>>;
  baseSlots: Partial<Record<Color, readonly Cell[]>>;
  homeSpot: Partial<Record<Color, Cell>>;
  /** Size of the board in squares. */
  w: number;
  h: number;
  /** Outlines for drawing the 5- and 6-player boards (the 4-player board is drawn on its grid). */
  shapes?: BoardShapes;
}

export interface BoardShapes {
  outline: Pt[];
  track: Pt[][];
  homeColumn: Partial<Record<Color, Pt[][]>>;
  /** Each base is a kite between two arms; `inc` and `r` are its inscribed circle. */
  bases: Partial<Record<Color, { kite: Pt[]; inc: Pt; r: number }>>;
  /** The centre: one triangle per colour. */
  centre: Partial<Record<Color, Pt[]>>;
  middle: Pt;
}

// ---------- the 4-player board, on a 15×15 grid ----------

/** The 52 shared squares on the 15×15 grid, clockwise from red's start square. */
export const TRACK: readonly Cell[] = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7],
  [0, 6],
];

/** Home column squares for progress 51..55 (4-player board: no purple or orange). */
export const HOME_COLUMN: Readonly<Record<Color, readonly Cell[]>> = {
  red: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
} as Partial<Record<Color, readonly Cell[]>> as Record<Color, readonly Cell[]>;

/** Top-left cell of each colour's 6×6 base (4-player board). */
export const BASE_ORIGIN: Readonly<Record<Color, Cell>> = {
  red: [0, 0],
  green: [9, 0],
  yellow: [9, 9],
  blue: [0, 9],
} as Partial<Record<Color, Cell>> as Record<Color, Cell>;

/** Where each token sits inside its base, as a cell offset from the base origin. */
const BASE_SLOTS: readonly Cell[] = [[1.5, 1.5], [3.5, 1.5], [1.5, 3.5], [3.5, 3.5]];

/** Finished tokens gather in their colour's triangle of the centre square. */
const HOME_SPOT: Partial<Record<Color, Cell>> = {
  red: [6.25, 7],
  green: [7, 6.25],
  yellow: [7.75, 7],
  blue: [7, 7.75],
};

function numbers(n: BoardSize, colors: readonly Color[]) {
  const trackLength = 13 * n;
  const home = trackLength + 4;
  const start = Object.fromEntries(colors.map((c, k) => [c, 13 * k])) as Partial<Record<Color, number>>;
  const stars = new Set(colors.map((_, k) => 13 * k + 8));
  return { n, colors, trackLength, last: trackLength - 2, home, lap2First: home + 1, lap2Last: home + trackLength, start, stars, safe: new Set([...stars, ...Object.values(start)]) };
}

const BOARD4: Board = {
  ...numbers(4, ['red', 'green', 'yellow', 'blue']),
  track: TRACK,
  homeColumn: HOME_COLUMN,
  baseSlots: Object.fromEntries(Object.entries(BASE_ORIGIN).map(([c, [ox, oy]]) => [c, BASE_SLOTS.map(([sx, sy]) => [ox + sx, oy + sy] as Cell)])),
  homeSpot: HOME_SPOT,
  w: 15,
  h: 15,
};

// ---------- the 5- and 6-player boards ----------

/** The first (red) arm's direction, in degrees clockwise from pointing right: 5 has an arm at the top, 6 arms left and right. */
const TURN: Record<BoardSize, number> = { 4: 180, 5: 198, 6: 180 };

/**
 * A board for n players built around a regular n-gon of side 3. Arm k leaves its k-th side; its
 * squares are (r, c): r = 0..5 outward from the centre, c = -1, 0, 1 across, with c = +1 the side
 * a token leaves along (clockwise). Each arm holds 13 track squares laid out exactly like today's:
 * absolute index 13k is seat k's start (second square out on its leaving side) and 13k + 8 the star
 * on the next arm. The bases are kites in the gaps between arms, and the outline is a regular
 * n-gon through the arm ends. For n = 4 this gives today's 15×15 board square for square.
 */
export function generateBoard(n: BoardSize, colors: readonly Color[]): Board {
  const half = Math.PI / n;
  const a = 1.5 / Math.tan(half); // the centre polygon's apothem
  const A = a + 6; // the outline's apothem: the arm ends lie on it
  const R = A / Math.cos(half);
  const th = (k: number) => (TURN[n] * Math.PI) / 180 + (k * 2 * Math.PI) / n;
  const pt = (k: number, d: number, c: number): Pt => {
    const ux = Math.cos(th(k));
    const uy = Math.sin(th(k));
    return [d * ux - c * uy, d * uy + c * ux];
  };
  const polar = (r: number, ang: number): Pt => [r * Math.cos(ang), r * Math.sin(ang)];
  const outline = Array.from({ length: n }, (_, k) => polar(R, th(k) + half));
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  // Into board units with the origin at the top left; rounded so the 4-player board comes out in whole squares.
  const at = ([x, y]: Pt): Pt => [Math.round((x - x0) * 1e6) / 1e6, Math.round((y - y0) * 1e6) / 1e6];
  const square = (k: number, r: number, c: number) => ({
    poly: [pt(k, a + r, c - 0.5), pt(k, a + r + 1, c - 0.5), pt(k, a + r + 1, c + 0.5), pt(k, a + r, c + 0.5)].map(at),
    cell: ((p: Pt): Cell => [p[0] - 0.5, p[1] - 0.5])(at(pt(k, a + r + 0.5, c))),
  });
  const T = 13 * n;
  const trackSq: ReturnType<typeof square>[] = new Array(T);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < 13; j++) {
      const [r, c] = j < 6 ? [j, -1] : j === 6 ? [5, 0] : [12 - j, 1];
      trackSq[(((13 * k - 8 + j) % T) + T) % T] = square(k, r, c);
    }
  }
  const homeCol = (k: number) => [4, 3, 2, 1, 0].map((r) => square(k, r, 0));
  const side = A * Math.tan(half) - 1.5; // a base kite's short side
  const r = (6 * side) / (6 + side); // and its inradius
  const slotSpread = Math.min(Math.SQRT2, r - 1.35);
  const bases = colors.map((_, k) => {
    const P = pt(k, a, 1.5); // the centre's corner between this arm and the next
    const bis = th(k) + half;
    const inc: Pt = [P[0] + (r / Math.sin(half)) * Math.cos(bis), P[1] + (r / Math.sin(half)) * Math.sin(bis)];
    // Token order as on today's board: reading order once the base is turned to the top left.
    const slots = [0, 1, 3, 2].map((m) => polar(slotSpread, bis + (m * Math.PI) / 2)).map(([dx, dy]): Pt => [inc[0] + dx, inc[1] + dy]);
    return { kite: [P, pt(k, A, 1.5), outline[k], pt(k + 1, A, -1.5)].map(at), inc: at(inc), slots: slots.map(at).map(([x, y]): Cell => [x - 0.5, y - 0.5]) };
  });
  const byColor = <T>(f: (k: number) => T) => Object.fromEntries(colors.map((c, k) => [c, f(k)])) as Partial<Record<Color, T>>;
  return {
    ...numbers(n, colors),
    track: trackSq.map((s) => s.cell),
    homeColumn: byColor((k) => homeCol(k).map((s) => s.cell)),
    baseSlots: byColor((k) => bases[k].slots),
    homeSpot: byColor((k) => ((p: Pt): Cell => [p[0] - 0.5, p[1] - 0.5])(at(pt(k, a * 0.55, 0)))),
    w: Math.round((Math.max(...xs) - x0) * 1e6) / 1e6,
    h: Math.round((Math.max(...ys) - y0) * 1e6) / 1e6,
    shapes: {
      outline: outline.map(at),
      track: trackSq.map((s) => s.poly),
      homeColumn: byColor((k) => homeCol(k).map((s) => s.poly)),
      bases: byColor((k) => ({ kite: bases[k].kite, inc: bases[k].inc, r })),
      centre: byColor((k) => [at([0, 0]), at(pt(k, a, -1.5)), at(pt(k, a, 1.5))]),
      middle: at([0, 0]),
    },
  };
}

const BOARDS: Record<BoardSize, Board> = {
  4: BOARD4,
  5: generateBoard(5, ['red', 'green', 'yellow', 'blue', 'purple']),
  6: generateBoard(6, ['red', 'green', 'yellow', 'blue', 'orange', 'purple']),
};

export function boardOf(n: BoardSize = 4): Board {
  return BOARDS[n] ?? BOARD4;
}

/** The board a game is played on; games saved before 5 and 6 players existed are on the 4-player board. */
export function boardFor(state: { board?: BoardSize }): Board {
  return boardOf(state.board ?? 4);
}

// The 4-player numbers, under their old names.
export const LAST_TRACK = BOARD4.last;
export const HOME = BOARD4.home;
export const TRACK_LENGTH = BOARD4.trackLength;
export const LAP2_FIRST = BOARD4.lap2First;
export const LAP2_LAST = BOARD4.lap2Last;
export const START_INDEX = BOARD4.start as Readonly<Record<Color, number>>;
export const SAFE_SQUARES = BOARD4.safe;
export const STAR_SQUARES = BOARD4.stars;

export const isSecondLap = (progress: number, b: Board = BOARD4): boolean => progress >= b.lap2First && progress <= b.lap2Last;
/** On the shared track (either lap), where it can capture and be captured. */
export const onTrack = (progress: number, b: Board = BOARD4): boolean => (progress >= 0 && progress <= b.last) || isSecondLap(progress, b);

export function absoluteSquare(color: Color, progress: number, b: Board = BOARD4): number | null {
  const start = b.start[color] ?? 0;
  if (progress >= 0 && progress <= b.last) return (start + progress) % b.trackLength;
  // Second lap: lap2First is `last + 1` squares on from the start (the one just before it), and so on.
  if (isSecondLap(progress, b)) return (start + progress - (b.lap2First - b.last - 1)) % b.trackLength;
  return null;
}

export function isSafeSquare(abs: number, b: Board = BOARD4): boolean {
  return b.safe.has(abs);
}

/** The square where a colour's tokens turn into its home column: a vampire turns in there too. */
export function laneEntry(color: Color, b: Board = BOARD4): number {
  return ((b.start[color] ?? 0) + b.last) % b.trackLength;
}

/** A spot in a home column, a colour's own token or a vampire: whose column, and how far up (1 to 5). */
export function laneSpot(color: Color, progress: number, b: Board = BOARD4): { lane: Color; step: number } | null {
  if (progress > b.last && progress < b.home) return { lane: color, step: progress - b.last };
  const r = raidOf(progress);
  return r && { lane: r.lane, step: r.step };
}

/** Where a vampire comes out of a raided column (that colour's start square), as its own progress on the same lap. */
export function raidExitProgress(color: Color, lane: Color, secondLap: boolean, b: Board = BOARD4): number {
  const rel = ((b.start[lane] ?? 0) - (b.start[color] ?? 0) + b.trackLength) % b.trackLength;
  return secondLap ? rel + (b.lap2First - b.last - 1) + b.trackLength : rel;
}

/** Top-left grid position (in square units) of a token at the given progress. */
export function tokenCell(color: Color, progress: number, tokenId: number, b: Board = BOARD4): Cell {
  if (progress === BASE || progress === HIDDEN) return b.baseSlots[color]![tokenId];
  const raid = raidOf(progress);
  if (raid) return b.homeColumn[raid.lane]![raid.step - 1];
  if (onTrack(progress, b)) return b.track[absoluteSquare(color, progress, b)!];
  if (progress >= b.home) return b.homeSpot[color]!;
  return b.homeColumn[color]![progress - b.last - 1];
}

/** The middle of a colour's base, in square units (the centre of its four slots). */
export function baseCentre(color: Color, b: Board = BOARD4): Cell {
  const slots = b.baseSlots[color]!;
  return [slots.reduce((s, p) => s + p[0], 0) / slots.length + 0.5, slots.reduce((s, p) => s + p[1], 0) / slots.length + 0.5];
}

/** The next square along a token's way; `lapping` takes it round again past its home turn. */
export function stepFrom(progress: number, lapping: boolean, b: Board = BOARD4): number {
  if (progress === b.last) return lapping ? b.lap2First : b.last + 1;
  if (progress === b.lap2Last) return b.last + 1;
  return progress + 1;
}

/** Power ups: the squares an astronaut floats through backwards, from `from` down to `to`, excluding the start. */
export function backPathCells(color: Color, from: number, to: number, tokenId: number, b: Board = BOARD4): Cell[] {
  const cells: Cell[] = [];
  for (let p = from - 1; p >= to && cells.length < MAX_STEPS; p--) cells.push(tokenCell(color, p, tokenId, b));
  return cells;
}

/** Longest move there is: a doubled 6 (power ups). */
const MAX_STEPS = 12;

/**
 * Every cell a token passes through moving from `from` to `to`, excluding the start. `via`: the
 * home column a vampire goes up (power ups): along the track to that colour's turn, up its column,
 * and, if the move takes it all the way in, out at that colour's start square.
 */
export function pathCells(color: Color, from: number, to: number, tokenId: number, b: Board = BOARD4, via?: Color): Cell[] {
  if (from === BASE) return [tokenCell(color, 0, tokenId, b)];
  const cells: Cell[] = [];
  const raid = raidOf(from);
  if (raid || via) {
    const lane = raid?.lane ?? via!;
    let step = raid?.step ?? 0;
    if (!raid) {
      // Along the track up to the turn into that colour's column.
      const entry = laneEntry(lane, b);
      for (let p = from, i = 0; absoluteSquare(color, p, b) !== entry && i < MAX_STEPS; i++) {
        p = stepFrom(p, false, b);
        cells.push(tokenCell(color, p, tokenId, b));
      }
    }
    const target = raidOf(to)?.step ?? 6;
    for (step++; step <= Math.min(target, 5); step++) cells.push(b.homeColumn[lane]![step - 1]);
    if (target === 6) cells.push(b.homeSpot[lane]!, b.track[b.start[lane]!]);
    return cells;
  }
  const lapping = isSecondLap(to, b) && !isSecondLap(from, b);
  for (let p = from, i = 0; p !== to && i < MAX_STEPS; i++) {
    p = stepFrom(p, lapping, b);
    cells.push(tokenCell(color, p, tokenId, b));
  }
  return cells;
}
