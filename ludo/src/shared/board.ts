import type { Color } from './types.js';

/**
 * Token progress is relative to its own colour:
 *   -1        in base
 *   0..50     main track (0 = own start square)
 *   51..55    own home column
 *   56        home (finished)
 *   57..108   a second lap of the main track: a token about to turn into its home column may go
 *             round once more. 57 is the square just before its start, 108 the last square before
 *             its home column again; from there it turns home like on the first lap.
 */
export const BASE = -1;
export const LAST_TRACK = 50;
export const HOME = 56;
export const TRACK_LENGTH = 52;
export const LAP2_FIRST = 57;
export const LAP2_LAST = 108;

export const isSecondLap = (progress: number): boolean => progress >= LAP2_FIRST && progress <= LAP2_LAST;
/** On the shared track (either lap), where it can capture and be captured. */
export const onTrack = (progress: number): boolean => (progress >= 0 && progress <= LAST_TRACK) || isSecondLap(progress);

export const START_INDEX: Record<Color, number> = { red: 0, green: 13, yellow: 26, blue: 39 };

/** Start squares plus the four stars, as absolute track indexes. */
export const SAFE_SQUARES: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const STAR_SQUARES: ReadonlySet<number> = new Set([8, 21, 34, 47]);

export type Cell = readonly [col: number, row: number];

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

/** Home column squares for progress 51..55. */
export const HOME_COLUMN: Record<Color, readonly Cell[]> = {
  red: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};

/** Top-left cell of each colour's 6×6 base. */
export const BASE_ORIGIN: Record<Color, Cell> = {
  red: [0, 0],
  green: [9, 0],
  yellow: [9, 9],
  blue: [0, 9],
};

/** Where each token sits inside its base, as a cell offset from the base origin. */
const BASE_SLOTS: readonly Cell[] = [[1.5, 1.5], [3.5, 1.5], [1.5, 3.5], [3.5, 3.5]];

/** Finished tokens gather in their colour's triangle of the centre square. */
const HOME_SPOT: Record<Color, Cell> = {
  red: [6.25, 7],
  green: [7, 6.25],
  yellow: [7.75, 7],
  blue: [7, 7.75],
};

export function absoluteSquare(color: Color, progress: number): number | null {
  if (progress >= 0 && progress <= LAST_TRACK) return (START_INDEX[color] + progress) % TRACK_LENGTH;
  // Second lap: 57 is 51 squares on from the start (the one just before it), and so on.
  if (isSecondLap(progress)) return (START_INDEX[color] + progress - (LAP2_FIRST - LAST_TRACK - 1)) % TRACK_LENGTH;
  return null;
}

export function isSafeSquare(abs: number): boolean {
  return SAFE_SQUARES.has(abs);
}

/** Top-left grid position (in cell units) of a token at the given progress. */
export function tokenCell(color: Color, progress: number, tokenId: number): Cell {
  if (progress === BASE) {
    const [ox, oy] = BASE_ORIGIN[color];
    const [sx, sy] = BASE_SLOTS[tokenId];
    return [ox + sx, oy + sy];
  }
  if (onTrack(progress)) return TRACK[absoluteSquare(color, progress)!];
  if (progress >= HOME) return HOME_SPOT[color];
  return HOME_COLUMN[color][progress - LAST_TRACK - 1];
}

/** The next square along a token's way; `lapping` takes it round again past its home turn. */
export function stepFrom(progress: number, lapping: boolean): number {
  if (progress === LAST_TRACK) return lapping ? LAP2_FIRST : LAST_TRACK + 1;
  if (progress === LAP2_LAST) return LAST_TRACK + 1;
  return progress + 1;
}

/** Every cell a token passes through moving from `from` to `to`, excluding the start. */
export function pathCells(color: Color, from: number, to: number, tokenId: number): Cell[] {
  if (from === BASE) return [tokenCell(color, 0, tokenId)];
  const lapping = isSecondLap(to) && !isSecondLap(from);
  const cells: Cell[] = [];
  for (let p = from, i = 0; p !== to && i < 6; i++) {
    p = stepFrom(p, lapping);
    cells.push(tokenCell(color, p, tokenId));
  }
  return cells;
}
