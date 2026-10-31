import { el } from './ui.js';

export interface BubbleOption {
  /** Classes and attributes of the option's button. */
  cls: string;
  attrs: string;
  /** Its picture. Nothing is written on it: `label` is for screen readers (and a long press). */
  html: string;
  label: string;
  pick: () => void;
}

/** A box in viewport coordinates. */
export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BubbleSpec {
  /** The positioned layer the bubble goes in. It covers the area the bubble may use. */
  layer: HTMLElement;
  /** What the tail points at, read again whenever the bubble is placed (the page may have moved). */
  anchor: () => Anchor;
  options: BubbleOption[];
  /** What a screen reader calls the group. */
  label: string;
  /** An optional short line above the pictures. */
  caption?: string;
  /** The highest edge the bubble may use, in viewport coordinates (default: just below the top of the screen). */
  topLimit?: () => number;
  /** Boxes (viewport coordinates) to keep clear of when the other side has room. */
  avoid?: () => DOMRect[];
  /** Elements whose resizing moves the anchor. */
  watch?: Element[];
  /** A tap on one of these goes through to the page (it is a choice of its own) instead of only closing the bubble. */
  passThrough?: (target: Element) => boolean;
  /** Where the focus goes when Escape closes the bubble. */
  refocus?: () => HTMLElement | null | undefined;
  /** Which option starts with the focus (default: the first). */
  focus?: number;
  onClose?: () => void;
}

export interface OpenBubble {
  el: HTMLElement;
  close: (opts?: { refocus?: boolean }) => void;
}

const TAIL = 11;
const MARGIN = 8;

/**
 * A small speech bubble pointing at a spot, with one round picture to tap per choice: see-through,
 * softly blurred, its tail pointing at the anchor. Tap one to choose; tap anywhere else (that tap
 * only closes it, and doesn't also press what is under it), press Esc, or let the page move on to
 * dismiss it. Used for the token choices on the board and the volume of a player.
 */
export function openBubbleAt(spec: BubbleSpec): OpenBubble {
  const { layer, options } = spec;
  const bubble = el(`<div class="stack-bubble" role="group" aria-label="${spec.label}">
    ${spec.caption ? `<div class="bubble-cap">${spec.caption}</div>` : ''}
    <div class="stack-row">${options.map((o) => `<button class="bubble-opt ${o.cls}" ${o.attrs} aria-label="${o.label}" title="${o.label}">${o.html}</button>`).join('')}</div>
    <i class="stack-tail"></i>
  </div>`);
  layer.appendChild(bubble);

  // Above the anchor, kept inside the screen; below it when there is no room above (the header,
  // with its safe-area inset and fullscreen changes, is the top limit).
  const place = () => {
    const br = layer.getBoundingClientRect();
    const a = spec.anchor();
    const aLeft = a.left - br.left;
    const aTop = a.top - br.top;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const centre = aLeft + a.width / 2;
    const left = Math.min(Math.max(centre - w / 2, MARGIN - br.left), Math.max(MARGIN - br.left, window.innerWidth - MARGIN - br.left - w));
    const topLimit = spec.topLimit?.() ?? MARGIN;
    const upTop = aTop - h - TAIL;
    const downTop = Math.min(aTop + a.height + TAIL, window.innerHeight - MARGIN - br.top - h);
    // Above the anchor, unless there is no room, or the bubble would sit on something to keep clear
    // of (the gold and blue markers stay tappable while it is open): prefer the side that leaves them free.
    const keepClear = spec.avoid?.() ?? [];
    const covers = (top: number) =>
      keepClear.some((m) => m.left < br.left + left + w && m.right > br.left + left && m.top < br.top + top + h && m.bottom > br.top + top);
    const fitsAbove = br.top + upTop >= topLimit;
    const belowOk = downTop >= aTop + a.height && !covers(downTop); // (not squeezed up over the anchor)
    const above = fitsAbove && (!covers(upTop) || !belowOk);
    bubble.classList.toggle('below', !above);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${above ? upTop : downTop}px`;
    bubble.style.setProperty('--tail-x', `${Math.min(Math.max(centre - left, 20), Math.max(20, w - 20))}px`);
  };
  place();
  // Rotating the phone or the address bar sliding away resizes things: follow the anchor.
  const watch = new ResizeObserver(place);
  for (const e of spec.watch ?? []) watch.observe(e);
  window.addEventListener('resize', place);

  // The tap that closes the bubble from outside must not also press what is under it: swallow the
  // click that follows that pointerdown, and only that one.
  const swallowNextClick = () => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      clearTimeout(timer);
      document.removeEventListener('click', swallow, true);
      document.removeEventListener('pointerup', released, true);
      document.removeEventListener('pointercancel', released, true);
    };
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      stop();
    };
    // The click comes right after the finger lifts; if none does (a drag), give up soon after.
    const released = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, 350);
    };
    document.addEventListener('click', swallow, true);
    document.addEventListener('pointerup', released, true);
    document.addEventListener('pointercancel', released, true);
    timer = setTimeout(stop, 1500);
  };

  let closed = false;
  const close = (opts: { refocus?: boolean } = {}) => {
    if (closed) return;
    closed = true;
    bubble.remove();
    watch.disconnect();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('resize', place);
    spec.onClose?.();
    if (opts.refocus) spec.refocus?.()?.focus({ preventScroll: true });
  };
  const outside = (e: Event) => {
    if (bubble.contains(e.target as Node)) return;
    close();
    // A choice of its own (a marker on the board): its click must go through. Anything else that
    // was under the finger is only dismissed with the bubble.
    if (spec.passThrough?.(e.target as Element)) return;
    swallowNextClick();
  };
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && close({ refocus: true });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape);
  // Keyboard and switch users land in the bubble, not behind it.
  const buttons = [...bubble.querySelectorAll<HTMLButtonElement>('.bubble-opt')];
  buttons[spec.focus ?? 0]?.focus({ preventScroll: true });
  buttons.forEach(
    (b, i) =>
      (b.onclick = () => {
        close();
        options[i].pick();
      }),
  );
  return { el: bubble, close };
}
