import { BASE, BASE_ORIGIN, HOME_COLUMN, START_INDEX, STAR_SQUARES, TRACK, tokenCell, type Cell } from '../../shared/board.js';
import { COLORS, type Color, type GameState } from '../../shared/types.js';

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(3)},${(cy + r * Math.sin(a)).toFixed(3)}`);
  }
  return pts.join(' ');
}

/** The static board: one SVG in a 15×15 user space, coloured through CSS classes. */
export function boardSvg(): string {
  const parts: string[] = ['<rect class="b-bg" x="0" y="0" width="15" height="15" rx="0.45"/>'];
  const startColor = new Map(COLORS.map((c) => [START_INDEX[c], c]));

  for (const color of COLORS) {
    const [ox, oy] = BASE_ORIGIN[color];
    // The base yards are drawn compact (inset from their corner) so the track reads as the main thing.
    parts.push(`<rect class="base c-${color}" x="${ox + 0.35}" y="${oy + 0.35}" width="5.3" height="5.3" rx="0.7"/>`);
    parts.push(`<rect class="b-inner" x="${ox + 0.95}" y="${oy + 0.95}" width="4.1" height="4.1" rx="0.55"/>`);
    for (const [sx, sy] of [[2, 2], [4, 2], [2, 4], [4, 4]]) {
      parts.push(`<circle class="slot c-${color}" cx="${ox + sx}" cy="${oy + sy}" r="0.56"/>`);
    }
    for (const [x, y] of HOME_COLUMN[color]) parts.push(`<rect class="cell c-${color}" x="${x}" y="${y}" width="1" height="1"/>`);
  }

  TRACK.forEach(([x, y], i) => {
    const c = startColor.get(i);
    parts.push(`<rect class="cell${c ? ` c-${c}` : ''}" x="${x}" y="${y}" width="1" height="1"/>`);
    if (STAR_SQUARES.has(i)) parts.push(`<polygon class="star" points="${starPoints(x + 0.5, y + 0.5, 0.36, 0.15)}"/>`);
    if (c) parts.push(`<polygon class="start-star" points="${starPoints(x + 0.5, y + 0.5, 0.34, 0.14)}"/>`);
  });

  parts.push(
    '<polygon class="c-red" points="6,6 6,9 7.5,7.5"/>',
    '<polygon class="c-green" points="6,6 9,6 7.5,7.5"/>',
    '<polygon class="c-yellow" points="9,6 9,9 7.5,7.5"/>',
    '<polygon class="c-blue" points="6,9 9,9 7.5,7.5"/>',
    '<rect class="center-line" x="6" y="6" width="3" height="3"/>',
  );
  return `<svg class="board-svg" viewBox="0 0 15 15" aria-hidden="true">${parts.join('')}</svg>`;
}

/** CSS transform placing a one-cell element at grid position (x, y). */
export function tf(x: number, y: number, scale = 1): string {
  return `translate(${x * 100}%, ${y * 100}%) scale(${scale})`;
}

const STACK_OFFSETS: Record<number, Cell[]> = {
  2: [[-0.19, -0.19], [0.19, 0.19]],
  3: [[-0.21, -0.19], [0.21, -0.19], [0, 0.21]],
  4: [[-0.21, -0.21], [0.21, -0.21], [-0.21, 0.21], [0.21, 0.21]],
};

/** Full-size tokens alone on a square; smaller the more of them share it. */
function stackScale(n: number): number {
  return n <= 1 ? 1 : n === 2 ? 0.66 : n <= 4 ? 0.56 : 0.46;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

/** Final position of every token, fanning out tokens that share a square. */
export function placements(state: GameState): Map<string, Placement> {
  const groups = new Map<string, { key: string; cell: Cell }[]>();
  for (const seat of state.seats) {
    state.tokens[seat.color].forEach((p, id) => {
      const cell = tokenCell(seat.color, p, id);
      const key = `${seat.color}:${id}`;
      const g = p === BASE ? key : `${cell[0]},${cell[1]}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ key, cell });
    });
  }
  const out = new Map<string, Placement>();
  for (const members of groups.values()) {
    const n = members.length;
    const offs = STACK_OFFSETS[Math.min(n, 4)];
    members.forEach((m, i) => {
      if (n === 1) out.set(m.key, { x: m.cell[0], y: m.cell[1], scale: 1 });
      else {
        const [dx, dy] = offs[i % offs.length];
        out.set(m.key, { x: m.cell[0] + dx, y: m.cell[1] + dy, scale: stackScale(n) });
      }
    });
  }
  return out;
}

export class TokenLayer {
  readonly els = new Map<string, HTMLButtonElement>();

  constructor(
    private layer: HTMLElement,
    private onTap: (color: Color, tokenId: number) => void,
  ) {}

  private ensure(color: Color, id: number): HTMLButtonElement {
    const key = `${color}:${id}`;
    let b = this.els.get(key);
    if (!b) {
      b = document.createElement('button');
      b.className = `token t-${color}`;
      b.setAttribute('aria-label', `${color} token ${id + 1}`);
      b.innerHTML = '<span class="tok-body"></span>';
      b.addEventListener('click', () => this.onTap(color, id));
      this.layer.appendChild(b);
      this.els.set(key, b);
    }
    return b;
  }

  get(color: Color, id: number): HTMLButtonElement | undefined {
    return this.els.get(`${color}:${id}`);
  }

  /** Snaps every token to its final position and marks which ones can be tapped. */
  sync(state: GameState, tappable: Set<string>, activeColor: Color | null): void {
    const place = placements(state);
    const live = new Set<string>();
    for (const seat of state.seats) {
      state.tokens[seat.color].forEach((_p, id) => {
        const key = `${seat.color}:${id}`;
        live.add(key);
        const b = this.ensure(seat.color, id);
        const pl = place.get(key)!;
        b.getAnimations().forEach((a) => a.cancel());
        b.style.transform = tf(pl.x, pl.y, pl.scale);
        b.classList.toggle('legal', tappable.has(key));
        b.classList.toggle('active', seat.color === activeColor);
        b.disabled = !tappable.has(key);
      });
    }
    for (const [key, b] of this.els) {
      if (!live.has(key)) {
        b.remove();
        this.els.delete(key);
      }
    }
  }
}
