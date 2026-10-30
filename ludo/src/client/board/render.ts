import { BASE, BASE_ORIGIN, HOME_COLUMN, START_INDEX, STAR_SQUARES, TRACK, boardFor, boardOf, isSecondLap, tokenCell, type Board, type BoardShapes, type Cell } from '../../shared/board.js';
import { moustacheLevel } from '../../shared/heft.js';
import { COLORS, type Color, type GameState } from '../../shared/types.js';
import { moustacheSvg } from '../moustache.js';
import { reducedMotion } from './animate.js';

/** After a capture, how long the token must sit still before its moustache grows, so the growth is seen. */
const GROW_DELAY_MS = 2000;
/** How long the moustache takes to grow into its new size. */
const GROW_ANIM_MS = 1400;

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(3)},${(cy + r * Math.sin(a)).toFixed(3)}`);
  }
  return pts.join(' ');
}

const pts = (ps: readonly (readonly [number, number])[]) => ps.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');

/** A tangential polygon (a base kite, the outline) pulled in by `by` around its inscribed circle, its corners rounded to `round` by a stroke. */
function roundedInset(poly: readonly (readonly [number, number])[], [cx, cy]: readonly [number, number], r: number, by: number, round: number): string {
  const k = (r - by - round) / r;
  return `points="${pts(poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]))}" stroke-width="${2 * round}"`;
}

/** The size of the base yard drawn in a corner, in squares (for effects that cover a base). */
export function yardSize(b: Board): number {
  const base = b.shapes && Object.values(b.shapes.bases)[0];
  return base ? 2 * (base.r - 0.35) : 5.3;
}

/** The 5- and 6-player boards: arms of squares round a pentagon or hexagon, bases in the gaps. */
function polygonBoardSvg(b: Board, sh: BoardShapes): string {
  const parts: string[] = [];
  const centre = sh.outline.reduce<[number, number]>((a, p) => [a[0] + p[0] / sh.outline.length, a[1] + p[1] / sh.outline.length], [0, 0]);
  const apothem = Math.hypot(...([0, 1].map((i) => (sh.outline[0][i] + sh.outline[1][i]) / 2 - centre[i]) as [number, number]));
  parts.push(`<polygon class="b-bg b-outline" ${roundedInset(sh.outline, centre, apothem, 0, 0.45)}/>`);
  for (const color of b.colors) {
    const base = sh.bases[color]!;
    parts.push(`<polygon class="base yard c-${color}" ${roundedInset(base.kite, base.inc, base.r, 0.35, 0.7)}/>`);
    parts.push(`<polygon class="b-inner" ${roundedInset(base.kite, base.inc, base.r, 0.95, 0.5)}/>`);
    for (const [x, y] of b.baseSlots[color]!) parts.push(`<circle class="slot c-${color}" cx="${(x + 0.5).toFixed(3)}" cy="${(y + 0.5).toFixed(3)}" r="0.56"/>`);
    for (const sq of sh.homeColumn[color]!) parts.push(`<polygon class="cell c-${color}" points="${pts(sq)}"/>`);
  }
  const startColor = new Map(b.colors.map((c) => [b.start[c]!, c]));
  sh.track.forEach((sq, i) => {
    const c = startColor.get(i);
    const [x, y] = b.track[i];
    parts.push(`<polygon class="cell${c ? ` c-${c}` : ''}" points="${pts(sq)}"/>`);
    if (b.stars.has(i)) parts.push(`<polygon class="star" points="${starPoints(x + 0.5, y + 0.5, 0.36, 0.15)}"/>`);
    if (c) parts.push(`<polygon class="start-star" points="${starPoints(x + 0.5, y + 0.5, 0.34, 0.14)}"/>`);
  });
  for (const color of b.colors) parts.push(`<polygon class="c-${color}" points="${pts(sh.centre[color]!)}"/>`);
  parts.push(`<polygon class="center-line" points="${pts(b.colors.map((c) => sh.centre[c]![2]))}"/>`);
  const [mx, my] = sh.middle;
  parts.push(`<g class="home-label"><rect x="${(mx - 0.88).toFixed(3)}" y="${(my - 0.3).toFixed(3)}" width="1.76" height="0.6" rx="0.3"/><text x="${mx.toFixed(3)}" y="${my.toFixed(3)}" dy="0.02">HOME</text></g>`);
  return `<svg class="board-svg" viewBox="0 0 ${b.w} ${b.h}" aria-hidden="true">${parts.join('')}</svg>`;
}

/** The static board: one SVG in board units (15×15 for 4 players), coloured through CSS classes. */
export function boardSvg(b: Board = boardOf(4)): string {
  if (b.shapes) return polygonBoardSvg(b, b.shapes);
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
    // The finish, labelled: on a second lap, with the token passing its own start again, it's
    // easy to lose track of where "home" is.
    '<g class="home-label"><rect x="6.62" y="7.2" width="1.76" height="0.6" rx="0.3"/><text x="7.5" y="7.5" dy="0.02">HOME</text></g>',
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
      const cell = tokenCell(seat.color, p, id, boardFor(state));
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
      // The shadow stays on the board while the squash layer (body and moustache) hops and squashes.
      b.innerHTML = '<span class="tok-shadow"></span><span class="tok-squash"><span class="tok-body"></span></span>';
      b.dataset.lvl = '0';
      // Each token's moustache twitches on its own schedule: every 3.3–5.5 s (10% more often than
      // the original 3.6–6 s).
      const tw = (3.6 + Math.random() * 2.4) / 1.1;
      b.style.setProperty('--tw', `${tw.toFixed(2)}s`);
      b.style.setProperty('--td', `${(-Math.random() * tw).toFixed(2)}s`);
      b.addEventListener('click', () => this.onTap(color, id));
      this.layer.appendChild(b);
      this.els.set(key, b);
    }
    return b;
  }

  /**
   * Shows the moustache for this level. Shaving (captured) and the first paint of a token are
   * instant. Growing waits until the token is still (no reaction face, not hopping), then pauses
   * GROW_DELAY_MS more, so the growth isn't hidden by another animation; if something starts
   * during the pause, the wait starts over.
   */
  private setMoustache(b: HTMLButtonElement, level: number): void {
    b.dataset.want = String(level);
    const shown = Number(b.dataset.lvl);
    const firstPaint = b.dataset.painted !== '1';
    b.dataset.painted = '1';
    if (level === shown) return;
    if (level < shown || firstPaint || reducedMotion()) return this.drawMoustache(b, level, false);
    if (b.dataset.waiting) return;
    b.dataset.waiting = '1';
    const busy = () => b.classList.contains('shows-emoji') || b.classList.contains('hopping');
    let stillSince = 0;
    const attempt = () => {
      if (!b.isConnected) return;
      if (busy()) stillSince = 0;
      else if (!stillSince) stillSince = performance.now();
      if (!stillSince || performance.now() - stillSince < GROW_DELAY_MS) return void setTimeout(attempt, 100);
      delete b.dataset.waiting;
      const want = Number(b.dataset.want);
      if (want !== Number(b.dataset.lvl)) this.drawMoustache(b, want, want > Number(b.dataset.lvl));
    };
    setTimeout(attempt, 100);
  }

  /**
   * Swaps in the moustache for `level`. Growing is slow: the old moustache fades out while the new
   * one grows in from smaller, swells a little past its size and settles, and the token does a
   * slow proud squash.
   */
  private drawMoustache(b: HTMLButtonElement, level: number, grow: boolean): void {
    const squash = b.querySelector('.tok-squash')!;
    const olds = [...squash.querySelectorAll<SVGSVGElement>('.tok-stache')];
    squash.insertAdjacentHTML('beforeend', moustacheSvg(level));
    b.dataset.lvl = String(level);
    if (!grow) {
      olds.forEach((o) => o.remove());
      return;
    }
    for (const o of olds) {
      o.animate([{ opacity: Number(getComputedStyle(o).opacity) || 1 }, { opacity: 0 }], { duration: GROW_ANIM_MS * 0.35, easing: 'ease-in', fill: 'forwards' }).finished.then(() => o.remove(), () => o.remove());
    }
    squash.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.07, 0.93)', offset: 0.3 },
        { transform: 'scale(0.98, 1.03)', offset: 0.7 },
        { transform: 'scale(1, 1)' },
      ],
      { duration: GROW_ANIM_MS * 0.8, easing: 'ease-in-out' },
    );
    squash.querySelector<SVGSVGElement>('.tok-stache:last-of-type .stache')?.animate(
      // A big pump first (up to twice its size), then it settles with a couple of smaller bounces.
      [
        { transform: 'scale(0.6)', opacity: 0 },
        { transform: 'scale(2) rotate(-4deg)', opacity: 1, offset: 0.3 },
        { transform: 'scale(0.85) rotate(2deg)', offset: 0.55 },
        { transform: 'scale(1.12) rotate(-1deg)', offset: 0.75 },
        { transform: 'scale(0.97) rotate(0.5deg)', offset: 0.9 },
        { transform: 'scale(1) rotate(0deg)', opacity: 1 },
      ],
      { duration: GROW_ANIM_MS, easing: 'ease-in-out' },
    );
  }

  get(color: Color, id: number): HTMLButtonElement | undefined {
    return this.els.get(`${color}:${id}`);
  }

  /** Snaps every token to its final position and marks which ones can be tapped. */
  sync(state: GameState, tappable: Set<string>, activeColor: Color | null): void {
    const place = placements(state);
    const board = boardFor(state);
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
        const p = state.tokens[seat.color][id];
        // On its last lap (round again, or back from home by a wildcard entry): a dashed ring.
        b.classList.toggle('lap2', isSecondLap(p, board) || (p !== board.home && Boolean(state.extraLaps?.[seat.color]?.[id])));
        // Home tokens never move; holding them is for the wildcard entry zone underneath.
        b.classList.toggle('at-home', p === board.home);
        this.setMoustache(b, moustacheLevel(state.kills?.[seat.color]?.[id] ?? 0));
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
