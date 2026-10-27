import { reducedMotion } from './board/animate.js';

const PIPS: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

/** Resting pose while waiting for a roll: a tilted cube showing three faces, so no value is implied. */
const IDLE = 'rotateX(-20deg) rotateY(-32deg)';

/** Cube rotation that shows each face to the viewer. */
const SHOW: Record<number, [number, number]> = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

function face(n: number): string {
  const cells = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[n].includes(i + 1) ? 'pip' : ''}"></i>`).join('');
  return `<div class="face f${n}">${cells}</div>`;
}

/** 3D CSS die. It only ever shows values the server sent. */
export class Dice {
  readonly el: HTMLButtonElement;
  private cube: HTMLElement;
  private pose = IDLE;

  constructor() {
    this.el = document.createElement('button');
    this.el.className = 'dice';
    this.el.setAttribute('aria-label', 'Roll the dice');
    this.el.innerHTML = `<div class="dice-shadow"></div><div class="cube">${[1, 2, 3, 4, 5, 6].map(face).join('')}</div>`;
    this.cube = this.el.querySelector('.cube')!;
    this.idle();
  }

  private transformFor(v: number, spinsX = 0, spinsY = 0): string {
    const [x, y] = SHOW[v];
    return `rotateX(${x + spinsX * 360}deg) rotateY(${y + spinsY * 360}deg)`;
  }

  show(v: number): void {
    this.pose = this.transformFor(v);
    this.cube.style.transform = this.pose;
  }

  idle(): void {
    if (this.el.classList.contains('rolling')) return;
    this.pose = IDLE;
    this.cube.style.transform = IDLE;
  }

  async roll(v: number): Promise<void> {
    const from = this.pose;
    const to = this.transformFor(v, 2, 3);
    if (reducedMotion()) {
      this.show(v);
      return;
    }
    this.el.classList.add('rolling');
    const spin = this.cube.animate(
      [
        { transform: from },
        { transform: `rotateX(${380}deg) rotateY(${520}deg) rotateZ(40deg)`, offset: 0.45 },
        { transform: to },
      ],
      { duration: 720, easing: 'cubic-bezier(.15,.7,.25,1)' },
    );
    const bounce = this.el.animate(
      [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(-34%) scale(1.08)', offset: 0.3 },
        { transform: 'translateY(0) scale(0.96)', offset: 0.65 },
        { transform: 'translateY(-6%) scale(1.02)', offset: 0.82 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: 720, easing: 'ease-out' },
    );
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
      { duration: 420 },
    );
  }
}

/** Small flat die face for the queued-dice chips. */
export function dieChip(v: number): string {
  const cells = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[v].includes(i + 1) ? 'pip' : ''}"></i>`).join('');
  return `<span class="mini-die">${cells}</span>`;
}
