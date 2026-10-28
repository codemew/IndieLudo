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
        await hopOnce(el, squash, shadow, prev, c, ms, k, i);
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

function hopOnce(el: HTMLElement, squash: HTMLElement | null, shadow: HTMLElement | null, a: Cell, b: Cell, ms: number, k: number, n: number): Promise<unknown> {
  const opts: KeyframeAnimationOptions = { duration: ms, fill: 'forwards' };
  const mid: Cell = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (reducedMotion() || !squash) {
    return el.animate([{ transform: tf(a[0], a[1], 1) }, { transform: tf(b[0], b[1], 1) }], opts).finished;
  }
  // Across the board: hold during the crouch, travel in the air, arrive on landing.
  el.animate(
    [
      { transform: tf(a[0], a[1], 1), offset: 0 },
      { transform: tf(a[0], a[1], 1), offset: 0.2, easing: 'cubic-bezier(.3,.1,.5,1)' },
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

/** Straight slide (used to send captured tokens home). */
export async function slide(el: HTMLElement, from: Cell, to: Cell, ms: number): Promise<void> {
  const anim = el.animate(
    [
      { transform: tf(from[0], from[1], 1) },
      { transform: tf((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 1.4), offset: 0.4 },
      { transform: tf(to[0], to[1], 1) },
    ],
    { duration: reducedMotion() ? 40 : atTempo(ms), easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
  );
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
}

/** A pause between events on the board (at the current tempo). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 60) : atTempo(ms)));
