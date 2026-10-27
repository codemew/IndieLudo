import type { Cell } from '../../shared/board.js';
import { tf } from './render.js';

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Hops a token square by square along `cells`, calling onStep as it lands on each. */
export async function hop(el: HTMLElement, from: Cell, cells: Cell[], msPerStep: number, onStep?: (i: number) => void): Promise<void> {
  if (cells.length === 0) return;
  const step = reducedMotion() ? 30 : msPerStep;
  const n = cells.length;
  const frames: Keyframe[] = [{ transform: tf(from[0], from[1], 1), offset: 0 }];
  let prev = from;
  cells.forEach((c, i) => {
    const mid: Cell = [(prev[0] + c[0]) / 2, (prev[1] + c[1]) / 2];
    frames.push({ transform: tf(mid[0], mid[1], 1.28), offset: (i + 0.5) / n, easing: 'ease-in' });
    frames.push({ transform: tf(c[0], c[1], 1), offset: (i + 1) / n, easing: 'ease-out' });
    prev = c;
  });
  el.style.zIndex = '30';
  const timers = cells.map((_, i) => setTimeout(() => onStep?.(i), (i + 1) * step - 10));
  const anim = el.animate(frames, { duration: n * step, fill: 'forwards' });
  try {
    await anim.finished;
  } catch {
    timers.forEach(clearTimeout);
  } finally {
    el.style.transform = tf(prev[0], prev[1], 1);
    anim.cancel();
    el.style.zIndex = '';
  }
}

/** Straight slide (used to send captured tokens home). */
export async function slide(el: HTMLElement, from: Cell, to: Cell, ms: number): Promise<void> {
  const anim = el.animate(
    [
      { transform: tf(from[0], from[1], 1) },
      { transform: tf((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 1.4), offset: 0.4 },
      { transform: tf(to[0], to[1], 1) },
    ],
    { duration: reducedMotion() ? 40 : ms, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 60) : ms));
