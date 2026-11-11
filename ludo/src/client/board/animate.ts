import type { Cell } from '../../shared/board.js';
import { BASE_EXIT_HOPS, hopMs, moustacheLevel, settleMs } from '../../shared/heft.js';
import { tf } from './render.js';

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let tempo = 1;
/**
 * How fast the board plays: 1 normally; a bot battle plays faster (tempoOf in shared/types.ts).
 * Every hop, slide, dice roll and pause between events takes this fraction of its usual time,
 * matching what the server waits out.
 */
export function setTempo(t: number): void {
  tempo = t;
}
/** A duration at the current tempo. */
export const atTempo = (ms: number): number => ms * tempo;

export interface HopOptions {
  /** The moving token's captures: more makes it slower and heavier (shared/heft.ts). */
  kills?: number;
  /** Leaving base is one longer jump. */
  fromBase?: boolean;
  /** Called as it lands on each square. */
  onStep?: (i: number, cell: Cell) => void;
  /**
   * Where the token is drawn before it moves, when that isn't the middle of `from` at full size (one
   * of several on a square is smaller and off-centre): the first hop starts there instead of
   * jumping to the middle first.
   */
  startAt?: { x: number; y: number; scale: number };
}

/**
 * Hops a token square by square along `cells`, approved on the review page: it crouches, springs
 * up stretched, lands squashed flat and rebounds, rocking side to side; a heavy token (one with
 * captures) crouches and squashes more, hops lower, flaps its moustache and jiggles to a stop.
 */
export async function hop(el: HTMLElement, from: Cell, cells: Cell[], opts: HopOptions = {}): Promise<void> {
  if (cells.length === 0) return;
  const k = moustacheLevel(opts.kills ?? 0);
  const squash = el.querySelector<HTMLElement>('.tok-squash');
  const shadow = el.querySelector<HTMLElement>('.tok-shadow');
  el.style.zIndex = '30';
  el.classList.add('hopping');
  let prev = from;
  try {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const ms = reducedMotion() ? 30 : atTempo(hopMs(k) * (opts.fromBase && i === 0 ? BASE_EXIT_HOPS : 1));
      const land = setTimeout(() => opts.onStep?.(i, c), ms * 0.8);
      try {
        await hopOnce(el, squash, shadow, prev, c, ms, k, i, i === 0 && opts.startAt ? tf(opts.startAt.x, opts.startAt.y, opts.startAt.scale) : tf(prev[0], prev[1], 1));
      } catch {
        clearTimeout(land);
        throw new Error('cancelled');
      }
      prev = c;
    }
    if (squash && k && !reducedMotion()) await settle(squash, k);
  } catch {
    /* cancelled by a resync */
  } finally {
    el.style.transform = tf(prev[0], prev[1], 1);
    el.getAnimations().forEach((a) => a.cancel());
    squash?.getAnimations().forEach((a) => a.cancel());
    shadow?.getAnimations().forEach((a) => a.cancel());
    el.style.zIndex = '';
    el.classList.remove('hopping');
  }
}

function hopOnce(el: HTMLElement, squash: HTMLElement | null, shadow: HTMLElement | null, a: Cell, b: Cell, ms: number, k: number, n: number, start: string): Promise<unknown> {
  const opts: KeyframeAnimationOptions = { duration: ms, fill: 'forwards' };
  const mid: Cell = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (reducedMotion() || !squash) {
    return el.animate([{ transform: start }, { transform: tf(b[0], b[1], 1) }], opts).finished;
  }
  // Across the board: hold during the crouch, travel in the air, arrive on landing.
  el.animate(
    [
      { transform: start, offset: 0 },
      { transform: start, offset: 0.2, easing: 'cubic-bezier(.3,.1,.5,1)' },
      { transform: tf(mid[0], mid[1], 1.12), offset: 0.5 },
      { transform: tf(b[0], b[1], 1), offset: 0.8 },
      { transform: tf(b[0], b[1], 1), offset: 1 },
    ],
    opts,
  );
  const crouch = 0.08 + 0.035 * k;
  const thump = 0.12 + 0.05 * k;
  const lift = Math.max(14, 38 - 4.5 * k); // % of the token: heavier tokens hop lower
  const sway = (n % 2 ? 1 : -1) * (1.5 + 3.2 * k);
  shadow?.animate(
    [
      { opacity: 0, transform: 'scale(1)', offset: 0 },
      { opacity: 0.5, transform: `scale(${1 + crouch * 0.6})`, offset: 0.2 },
      { opacity: 0.3, transform: 'scale(0.6)', offset: 0.5 },
      { opacity: 0.55, transform: `scale(${1 + thump * 0.8})`, offset: 0.8 },
      { opacity: 0, transform: 'scale(1)', offset: 1 },
    ],
    opts,
  );
  if (k) flapMoustache(squash, k, ms);
  return squash.animate(
    [
      { transform: 'translateY(0) scale(1, 1) rotate(0deg)', offset: 0 },
      { transform: `translateY(0) scale(${1 + crouch}, ${1 - crouch}) rotate(0deg)`, offset: 0.2, easing: 'cubic-bezier(.2,.7,.4,1)' },
      { transform: `translateY(${-lift * 0.6}%) scale(0.93, 1.1) rotate(${sway * 0.5}deg)`, offset: 0.34, easing: 'ease-out' },
      { transform: `translateY(${-lift}%) scale(1, 1) rotate(${sway}deg)`, offset: 0.5, easing: 'ease-in' },
      { transform: `translateY(${-lift * 0.4}%) scale(0.96, 1.06) rotate(${sway * 0.4}deg)`, offset: 0.7, easing: 'ease-in' },
      { transform: `translateY(0) scale(${1 + thump}, ${1 - thump}) rotate(0deg)`, offset: 0.8, easing: 'cubic-bezier(.2,.8,.4,1.2)' },
      { transform: `translateY(0) scale(${1 - thump * 0.35}, ${1 + thump * 0.4}) rotate(0deg)`, offset: 0.91 },
      { transform: 'translateY(0) scale(1, 1) rotate(0deg)', offset: 1 },
    ],
    opts,
  ).finished;
}

/** The moustache follows the hop a beat late: bunches on the crouch, lifts in the air, slams down on landing. */
function flapMoustache(squash: HTMLElement, k: number, ms: number): void {
  const amt = 5 + 2.6 * k;
  squash.querySelectorAll<SVGGElement>('.mh').forEach((h) => {
    const s = Number(h.dataset.side);
    h.animate(
      [
        { transform: 'rotate(0deg) scale(1, 1)', offset: 0 },
        { transform: `rotate(${s * amt * 0.4}deg) scale(0.96, 1.1)`, offset: 0.2 },
        { transform: `rotate(${s * -amt * 0.6}deg) scale(1, 0.9)`, offset: 0.36 },
        { transform: `rotate(${s * amt * 0.7}deg) scale(1, 1.06)`, offset: 0.55 },
        { transform: `rotate(${s * -amt}deg) scale(1.04, 0.84)`, offset: 0.82 },
        { transform: `rotate(${s * amt * 0.5}deg) scale(1, 1.06)`, offset: 0.92 },
        { transform: 'rotate(0deg) scale(1, 1)', offset: 1 },
      ],
      { duration: ms, composite: 'add' },
    );
  });
}

/** After the last landing: a few dying wobbles, longer and bigger the heavier it is. */
function settle(squash: HTMLElement, k: number): Promise<unknown> {
  const c = 0.04 + 0.022 * k;
  return squash.animate(
    [
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + c}, ${1 - c})` },
      { transform: `scale(${1 - c * 0.6}, ${1 + c * 0.6})` },
      { transform: `scale(${1 + c * 0.3}, ${1 - c * 0.3})` },
      { transform: `scale(${1 - c * 0.12}, ${1 + c * 0.12})` },
      { transform: 'scale(1, 1)' },
    ],
    { duration: atTempo(settleMs(k)), easing: 'ease-out' },
  ).finished;
}

/**
 * Sends a token across the board in one go (a captured token home, a surrendered one to base). It
 * swells towards the viewer on the way. `knocked`: it was hit: it recoils from the blow first, then
 * tumbles head over heels all the way, and lands in its slot with a squash.
 */
export async function slide(el: HTMLElement, from: Cell, to: Cell, ms: number, opts: { knocked?: boolean } = {}): Promise<void> {
  const still = reducedMotion();
  const mid: Cell = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  // The blow comes along the line of the move's last hop, which we don't know here: recoil upwards.
  const frames: Keyframe[] =
    opts.knocked && !still
      ? [
          { transform: `${tf(from[0], from[1], 1)} rotate(0deg)`, offset: 0 },
          { transform: `${tf(from[0], from[1] - 0.35, 1.25)} rotate(-25deg)`, offset: 0.16, easing: 'cubic-bezier(.4,0,.6,1)' },
          { transform: `${tf(mid[0], mid[1] - 0.6, 1.5)} rotate(-360deg)`, offset: 0.55, easing: 'cubic-bezier(.3,0,.7,1)' },
          { transform: `${tf(to[0], to[1], 1.1)} rotate(-700deg)`, offset: 0.92 },
          { transform: `${tf(to[0], to[1], 1)} rotate(-720deg)`, offset: 1 },
        ]
      : [{ transform: tf(from[0], from[1], 1) }, { transform: tf(mid[0], mid[1], 1.4), offset: 0.4 }, { transform: tf(to[0], to[1], 1) }];
  const anim = el.animate(frames, { duration: still ? 40 : atTempo(ms), easing: opts.knocked && !still ? 'linear' : 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  el.style.zIndex = '31';
  try {
    await anim.finished;
  } catch {
    /* cancelled */
  } finally {
    el.style.transform = tf(to[0], to[1], 1);
    anim.cancel();
    el.style.zIndex = '';
  }
  // Not waited for: it plays under whatever comes next, so the move takes no longer than before.
  if (opts.knocked && !still) squashOnce(el, 0.16, 260);
}

/** One quick squash and rebound of a token where it stands (it landed, or was pressed). */
export function squashOnce(el: HTMLElement, by: number, ms: number): void {
  if (reducedMotion()) return;
  el.querySelector<HTMLElement>('.tok-squash')?.animate(
    [
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + by}, ${1 - by})`, offset: 0.3 },
      { transform: `scale(${1 - by * 0.45}, ${1 + by * 0.5})`, offset: 0.62 },
      { transform: 'scale(1, 1)' },
    ],
    { duration: atTempo(ms), easing: 'ease-out' },
  );
}

/**
 * A wildcard entry: the token rises from home, swells and spins with a glow, flies in a high
 * arc across the board and drops heavily into its base slot.
 */
export async function fly(el: HTMLElement, from: Cell, to: Cell, ms: number): Promise<void> {
  const peak: Cell = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 2.5];
  const at = (t: number): Cell => [(1 - t) ** 2 * from[0] + 2 * (1 - t) * t * peak[0] + t * t * to[0], (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * peak[1] + t * t * to[1]];
  const frames: Keyframe[] = [
    { transform: `${tf(from[0], from[1], 1)} rotate(0deg)`, offset: 0 },
    { transform: `${tf(from[0], from[1] - 0.4, 1.9)} rotate(-20deg)`, offset: 0.22, easing: 'ease-in-out' },
    { transform: `${tf(from[0], from[1] - 0.5, 2.1)} rotate(340deg)`, offset: 0.4 },
  ];
  for (const t of [0.25, 0.5, 0.75]) {
    const [x, y] = at(t);
    frames.push({ transform: `${tf(x, y, 2.1 - 0.6 * t)} rotate(${360 + 180 * t}deg)`, offset: 0.4 + 0.45 * t });
  }
  frames.push({ transform: `${tf(to[0], to[1], 1.25)} rotate(540deg)`, offset: 0.9, easing: 'cubic-bezier(.5,0,.9,.4)' });
  frames.push({ transform: `${tf(to[0], to[1], 1)} rotate(720deg)`, offset: 1 });
  el.style.zIndex = '32';
  el.classList.add('flying');
  const anim = el.animate(frames, { duration: reducedMotion() ? 40 : atTempo(ms), fill: 'forwards' });
  try {
    await anim.finished;
  } catch {
    /* cancelled */
  } finally {
    el.style.transform = tf(to[0], to[1], 1);
    anim.cancel();
    el.style.zIndex = '';
    el.classList.remove('flying');
  }
}

/** A pause between events on the board (at the current tempo). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 60) : atTempo(ms)));
