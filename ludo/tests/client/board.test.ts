import { describe, expect, it } from 'vitest';
import { BASE, BASE_ORIGIN, HOME, HOME_COLUMN, SAFE_SQUARES, START_INDEX, TRACK, pathCells, tokenCell } from '../../src/shared/board.js';
import { placements } from '../../src/client/board/render.js';
import { COLORS } from '../../src/shared/types.js';
import { game } from '../helpers.js';

const inBase = (x: number, y: number) => (x < 6 || x >= 9) && (y < 6 || y >= 9);

describe('board geometry for rendering', () => {
  it('every progress value of every colour maps to a cell on the board', () => {
    for (const color of COLORS) {
      for (let p = BASE; p <= HOME; p++) {
        for (let id = 0; id < 4; id++) {
          const [x, y] = tokenCell(color, p, id);
          expect(x >= 0 && x <= 14 && y >= 0 && y <= 14, `${color} ${p}`).toBe(true);
        }
      }
    }
  });

  it('track and home columns never overlap a base, and steps are adjacent', () => {
    for (const [x, y] of TRACK) expect(inBase(x, y)).toBe(false);
    for (let i = 0; i < TRACK.length; i++) {
      const [ax, ay] = TRACK[i];
      const [bx, by] = TRACK[(i + 1) % TRACK.length];
      // Neighbouring squares, or the diagonal hop around an inner corner.
      expect(Math.abs(ax - bx) + Math.abs(ay - by)).toBeLessThanOrEqual(2);
      expect(Math.max(Math.abs(ax - bx), Math.abs(ay - by))).toBe(1);
    }
    for (const color of COLORS) for (const [x, y] of HOME_COLUMN[color]) expect(inBase(x, y)).toBe(false);
  });

  it('home columns are distinct from the track and from each other', () => {
    const track = new Set(TRACK.map((c) => c.join(',')));
    const seen = new Set<string>();
    for (const color of COLORS) {
      for (const c of HOME_COLUMN[color]) {
        const k = c.join(',');
        expect(track.has(k)).toBe(false);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('base slots sit inside their own base, one per token', () => {
    for (const color of COLORS) {
      const [ox, oy] = BASE_ORIGIN[color];
      const slots = new Set<string>();
      for (let id = 0; id < 4; id++) {
        const [x, y] = tokenCell(color, BASE, id);
        expect(x > ox && x < ox + 5 && y > oy && y < oy + 5).toBe(true);
        slots.add(`${x},${y}`);
      }
      expect(slots.size).toBe(4);
    }
  });

  it('start squares are safe and sit next to their base', () => {
    for (const color of COLORS) {
      expect(SAFE_SQUARES.has(START_INDEX[color])).toBe(true);
      const [sx, sy] = TRACK[START_INDEX[color]];
      const [ox, oy] = BASE_ORIGIN[color];
      const dist = Math.min(Math.abs(sx - ox), Math.abs(sx - (ox + 5))) + Math.min(Math.abs(sy - oy), Math.abs(sy - (oy + 5)));
      expect(dist).toBeLessThanOrEqual(2);
    }
  });

  it('a hop path visits one square per step', () => {
    expect(pathCells('red', 0, 6, 0)).toHaveLength(6);
    expect(pathCells('red', BASE, 0, 1)).toEqual([TRACK[0]]);
    expect(pathCells('blue', 48, 53, 0).at(-1)).toEqual(HOME_COLUMN.blue[2]);
  });
});

describe('placements', () => {
  it('fans out tokens sharing a square and keeps single tokens full size', () => {
    const s = game(['red', 'green']);
    s.tokens.red = [5, 5, 10, BASE];
    s.tokens.green = [44, BASE, BASE, BASE]; // (13 + 44) % 52 = 5 → same square as red's two
    const p = placements(s);
    const shared = ['red:0', 'red:1', 'green:0'].map((k) => p.get(k)!);
    expect(shared.every((x) => x.scale < 1)).toBe(true);
    expect(new Set(shared.map((x) => `${x.x},${x.y}`)).size).toBe(3);
    expect(p.get('red:2')).toEqual({ x: TRACK[10][0], y: TRACK[10][1], scale: 1 });
    expect(p.get('red:3')!.scale).toBe(1);
  });

  it('a token on its second lap stacks with a first-lap token on the same square', () => {
    const s = game(['red', 'green']);
    s.tokens.red = [57, BASE, BASE, BASE]; // second lap: absolute (0 + 57 - 6) % 52 = 51
    s.tokens.green = [38, BASE, BASE, BASE]; // first lap: (13 + 38) % 52 = 51
    const p = placements(s);
    const [a, b] = [p.get('red:0')!, p.get('green:0')!];
    expect(a.scale).toBeLessThan(1);
    expect(b.scale).toBe(a.scale);
    expect(`${a.x},${a.y}`).not.toBe(`${b.x},${b.y}`);
    expect(Math.hypot(a.x - TRACK[51][0], a.y - TRACK[51][1])).toBeLessThan(0.5);
  });

  it('tokens in base keep their own slots and full size, never fanned out', () => {
    const s = game(['red', 'green']);
    const p = placements(s);
    for (const color of ['red', 'green'] as const) {
      for (let id = 0; id < 4; id++) {
        const [x, y] = tokenCell(color, BASE, id);
        expect(p.get(`${color}:${id}`)).toEqual({ x, y, scale: 1 });
      }
    }
  });

  it('three and four tokens on one square all get their own spot, smaller the more there are', () => {
    const s = game(['red', 'green']);
    s.tokens.red = [5, 5, 5, BASE];
    const three = placements(s);
    s.tokens.red = [5, 5, 5, 5];
    const four = placements(s);
    const spots = (p: ReturnType<typeof placements>, n: number) => new Set([...Array(n).keys()].map((i) => `${p.get(`red:${i}`)!.x},${p.get(`red:${i}`)!.y}`)).size;
    expect(spots(three, 3)).toBe(3);
    expect(spots(four, 4)).toBe(4);
    expect(four.get('red:0')!.scale).toBeLessThanOrEqual(three.get('red:0')!.scale);
  });
});
