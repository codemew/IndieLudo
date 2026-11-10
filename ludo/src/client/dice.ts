import { atTempo, reducedMotion } from './board/animate.js';

const PIPS: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

/** A pose of the cube: its rotation about X and Y, in degrees. */
type Pose = readonly [number, number];

/** Resting pose while waiting for a roll: a tilted cube showing three faces, so no value is implied. */
const IDLE: Pose = [-20, -32];

/** Cube rotation that shows each face to the viewer. */
const SHOW: Record<number, Pose> = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

const css = ([x, y]: Pose, z = 0): string => `rotateX(${x}deg) rotateY(${y}deg)${z ? ` rotateZ(${z}deg)` : ''}`;
/** The first angle at or past `min` that shows the same face as `face` (whole turns added). */
const turnsPast = (face: number, min: number): number => face + 360 * Math.ceil((min - face) / 360);

/** One tumble of the wind-up: a whole turn about X and two about Y. */
const WIND_MS = 620;
const WIND_TURN: Pose = [360, 720];

function face(n: number): string {
  const cells = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[n].includes(i + 1) ? 'pip' : ''}"></i>`).join('');
  return `<div class="face f${n}">${cells}</div>`;
}

/** 3D CSS die. It only ever shows values the server sent. */
export class Dice {
  readonly el: HTMLButtonElement;
  private cube: HTMLElement;
  private impact: HTMLElement;
  private pose: Pose = IDLE;
  /** The tumble that starts with the tap, until the server's roll arrives (windUp). */
  private winding: Animation | null = null;

  constructor() {
    this.el = document.createElement('button');
    this.el.className = 'dice';
    this.el.setAttribute('aria-label', 'Roll the dice');
    this.el.innerHTML = `<div class="cube"><div class="core"></div><div class="core core-x"></div><div class="core core-y"></div>${[1, 2, 3, 4, 5, 6].map(face).join('')}</div><i class="dice-impact" aria-hidden="true"></i>`;
    this.cube = this.el.querySelector('.cube')!;
    this.impact = this.el.querySelector('.dice-impact')!;
    this.idle();
  }

  private set(pose: Pose): void {
    this.pose = pose;
    this.cube.style.transform = css(pose);
  }

  /** Stops the wind-up, giving the pose the cube had reached. */
  private stopWinding(): Pose {
    const w = this.winding;
    if (!w) return this.pose;
    this.winding = null;
    const p = Number(w.effect?.getComputedTiming().progress ?? 0) || 0;
    w.cancel();
    return [this.pose[0] + WIND_TURN[0] * p, this.pose[1] + WIND_TURN[1] * p];
  }

  show(v: number): void {
    this.stopWinding();
    this.set(SHOW[v]);
  }

  idle(): void {
    if (this.el.classList.contains('rolling')) return;
    this.stopWinding();
    this.set(IDLE);
  }

  /**
   * The tap landed: the die dips under the finger and starts to tumble at once, without waiting
   * for the server. It shows no value yet; roll() takes the tumble over when the server's roll
   * arrives, and settle() stops it if none does.
   */
  windUp(): void {
    if (reducedMotion() || this.winding || this.el.classList.contains('rolling')) return;
    this.el.animate(
      [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(6%) scale(0.88)', offset: 0.35 },
        { transform: 'translateY(-10%) scale(1.06)', offset: 0.75 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: 260, easing: 'ease-out' },
    );
    const [x, y] = this.pose;
    this.winding = this.cube.animate([{ transform: css([x, y]) }, { transform: css([x + WIND_TURN[0], y + WIND_TURN[1]]) }], { duration: WIND_MS, iterations: Infinity, easing: 'linear' });
  }

  /** No roll came of the tap (the server said no, or the board moved on without one): back to rest. */
  settle(): void {
    if (!this.winding || this.el.classList.contains('rolling')) return;
    this.stopWinding();
    this.set(this.pose);
  }

  async roll(v: number): Promise<void> {
    // From wherever the cube is (mid-tumble after a tap, or at rest), on round in the same
    // direction: at least a turn and a half about X and two and a half about Y, ending on the face.
    const from = this.stopWinding();
    if (reducedMotion()) {
      this.show(v);
      return;
    }
    const to: Pose = [turnsPast(SHOW[v][0], from[0] + 540), turnsPast(SHOW[v][1], from[1] + 900)];
    const mid: Pose = [from[0] + (to[0] - from[0]) * 0.55, from[1] + (to[1] - from[1]) * 0.55];
    this.el.classList.add('rolling');
    const spin = this.cube.animate([{ transform: css(from) }, { transform: css(mid, 40), offset: 0.45 }, { transform: css(to) }], { duration: atTempo(720), easing: 'cubic-bezier(.15,.7,.25,1)' });
    const bounce = this.el.animate(
      [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(-34%) scale(1.08)', offset: 0.3 },
        { transform: 'translateY(0) scale(0.96)', offset: 0.65 },
        { transform: 'translateY(-6%) scale(1.02)', offset: 0.82 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: atTempo(720), easing: 'ease-out' },
    );
    // It hits the table at the bottom of the bounce: a ring in the roller's colour spreads from under it.
    this.impact.animate([{ transform: 'scale(0.5)', opacity: 0 }, { transform: 'scale(0.7)', opacity: 0.75, offset: 0.1 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: atTempo(460), delay: atTempo(720 * 0.62), easing: 'ease-out' });
    try {
      await Promise.all([spin.finished, bounce.finished]);
    } catch {
      /* cancelled */
    }
    this.show(v);
    this.el.classList.remove('rolling');
  }

  shake(): void {
    this.el.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-10%) rotate(-8deg)' }, { transform: 'translateX(10%) rotate(8deg)' }, { transform: 'translateX(-6%)' }, { transform: 'translateX(0)' }],
      { duration: atTempo(420) },
    );
  }
}

/** Small flat die face for the queued-dice chips. */
export function dieChip(v: number): string {
  const cells = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[v].includes(i + 1) ? 'pip' : ''}"></i>`).join('');
  return `<span class="mini-die">${cells}</span>`;
}
