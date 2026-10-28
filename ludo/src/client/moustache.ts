import { MAX_MOUSTACHE } from '../shared/heft.js';

/**
 * The Evolution moustache a token grows with its captures (approved on the review page):
 * a bold chevron, a horseshoe, a handlebar, then a giant bushy imperial. Drawn as SVG in the
 * same 100-unit box as the review page, where the token is a circle of radius ~35 centred at
 * (50, 52); styles.css (.tok-stache) lines that box up with the token's body.
 */
interface Stroke {
  /** Half-width of the moustache, from under the nose to a tip. */
  w: number;
  /** Thickness under the nose. */
  t: number;
  droop: number;
  arch: number;
  lift: number;
  /** Degrees of upward curl at the tips (handlebar). */
  curl: number;
  /** Length of a downward hook at the tips (horseshoe). */
  hook?: number;
  c: number;
  tipMin?: number;
  bristles?: number;
}

/** The line it sits on, a little below the token's centre. */
export const MOUSTACHE_Y = 61;

const LEVELS: (Stroke | null)[] = [
  null,
  { w: 21, t: 11, droop: 2, arch: 0.7, lift: 0, curl: 0, c: 0, tipMin: 0.62 }, // bold chevron
  { w: 23, t: 13, droop: 0.6, arch: 0.8, lift: 0, curl: 0, hook: 11, c: 4, tipMin: 0.55 }, // horseshoe
  { w: 30, t: 15.6, droop: 1, arch: 1.7, lift: 3, curl: 285, c: 6 }, // handlebar
  { w: 36, t: 18, droop: 1.3, arch: 2.3, lift: 5.6, curl: 440, c: 7.8, bristles: 0.7 }, // imperial
];

const f = (n: number) => Math.round(n * 100) / 100;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Closed smooth path through points (Catmull-Rom). */
function smooth(pts: [number, number][]): string {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

/** The left half's centre line: out from under the nose to the tip, then a curl or a hook. */
function centreLine(m: Stroke): [number, number][] {
  const pts: [number, number][] = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    pts.push([49.5 - s * m.w, MOUSTACHE_Y + m.droop * Math.pow(s, 1.4) + m.arch * Math.sin(Math.PI * s) - m.lift * s * s]);
  }
  const [tx, ty] = pts[pts.length - 1];
  if (m.curl > 0) {
    const cx = tx, cy = ty - m.c;
    for (let a = 15; a <= m.curl; a += 15) {
      const r = m.c * (1 - 0.5 * (a / Math.max(m.curl, 200)));
      pts.push([cx + r * Math.cos(rad(90 + a)), cy + r * Math.sin(rad(90 + a))]);
    }
  } else if (m.hook) {
    const cx = tx, cy = ty + m.c;
    for (let a = 15; a <= 90; a += 15) pts.push([cx + m.c * Math.cos(rad(270 - a)), cy + m.c * Math.sin(rad(270 - a))]);
    const [lx, ly] = pts[pts.length - 1];
    for (let i = 1; i <= 3; i++) pts.push([lx + 0.3 * i, ly + (m.hook * i) / 3]);
  }
  return pts;
}

/** The left half as a filled shape: fat under the nose, tapering to the tip, bristly if bushy. */
function halfPath(m: Stroke): string {
  const line = centreLine(m);
  const n = line.length;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy, ny = dx;
    const u = i / (n - 1);
    const w = m.t * (u < 0.1 ? 0.78 + 2.2 * u : Math.max(m.tipMin ?? 0.2, 1 - Math.pow(u, 1.15) * 0.86));
    const bristle = m.bristles && u > 0.05 && u < 0.85 && i % 2 ? 1 + 0.38 * m.bristles : 1;
    top.push([line[i][0] + nx * w * 0.5, line[i][1] + ny * w * 0.5]);
    bottom.push([line[i][0] - nx * w * 0.5 * bristle, line[i][1] - ny * w * 0.5 * bristle]);
  }
  return smooth([[51.2, top[0][1]], ...top, ...bottom.reverse(), [51.2, bottom[bottom.length - 1][1]]]);
}

const cache = new Map<number, string>();

/** SVG for a moustache level (1–4); '' for none. Each half pivots under the nose to twitch and flap. */
export function moustacheSvg(level: number): string {
  const l = Math.max(0, Math.min(MAX_MOUSTACHE, level));
  if (!l) return '';
  let svg = cache.get(l);
  if (!svg) {
    const d = halfPath(LEVELS[l]!);
    const half = (side: -1 | 1) =>
      `<g class="mh" data-side="${side}" style="--side:${side}"><g${side > 0 ? ' transform="translate(100 0) scale(-1 1)"' : ''}>` +
      `<path d="${d}" fill="#1f130c" stroke="rgba(255,255,255,0.42)" stroke-width="1.5" stroke-linejoin="round"></path>` +
      `<path d="${d}" fill="url(#stache-gloss)"></path></g></g>`;
    svg = `<svg class="tok-stache" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g class="stache">${half(-1)}${half(1)}</g></svg>`;
    cache.set(l, svg);
  }
  return svg;
}

/** The shared gradient the moustache uses for its sheen; added to the page once. */
export function installMoustacheDefs(): void {
  if (document.getElementById('stache-defs')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<svg id="stache-defs" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
      <linearGradient id="stache-gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8a6243" stop-opacity="0.85"></stop>
        <stop offset="0.45" stop-color="#8a6243" stop-opacity="0"></stop>
      </linearGradient></defs></svg>`,
  );
}
