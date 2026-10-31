/** How long a finger stays down before it counts as "tap and hold". */
export const HOLD_MS = 450;
/** A finger that travels further than this is scrolling or dragging, not holding. */
const SLOP_PX = 10;

export interface HoldOptions {
  /** The card a press landed on, or null when it isn't one that can be held. */
  find: (target: Element) => HTMLElement | null;
  /** Called once per hold (and for a right-click or the keyboard's menu key). */
  open: (card: HTMLElement) => void;
  ms?: number;
}

const INNER_CONTROLS = 'button, a, input, select, textarea, [role=button]:not(.holdable)';

/**
 * Tap and hold on a card, for everything inside `root` (so cards that are redrawn keep working).
 * A press on a button inside the card is that button's, not the card's. After a hold the finger
 * lifts without also tapping what is under it. A right-click, the menu key and Enter / Space on a
 * focused card open the same thing, so it doesn't depend on a touch screen. Returns the cleanup.
 */
export function onHold(root: HTMLElement, opts: HoldOptions): () => void {
  const ms = opts.ms ?? HOLD_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heldAt = 0;
  let swallow = false;
  let swallowTimer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', cancel, true);
    document.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('scroll', cancel, true);
  };
  let startX = 0;
  let startY = 0;
  const move = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP_PX) cancel();
  };
  const fire = (card: HTMLElement) => {
    heldAt = Date.now();
    opts.open(card);
  };
  const onDown = (e: PointerEvent) => {
    cancel();
    // Only the main button / a touch; a right-click comes through contextmenu.
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const card = opts.find(e.target);
    if (!card) return;
    const inner = e.target.closest(INNER_CONTROLS);
    if (inner && card.contains(inner) && inner !== card) return;
    startX = e.clientX;
    startY = e.clientY;
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', cancel, true);
    document.addEventListener('pointercancel', cancel, true);
    window.addEventListener('scroll', cancel, true);
    timer = setTimeout(() => {
      cancel();
      swallow = true;
      if (swallowTimer) clearTimeout(swallowTimer);
      // The lifting finger's click comes right after; if it never does, stop waiting.
      swallowTimer = setTimeout(() => (swallow = false), 1500);
      fire(card);
    }, ms);
  };
  const onClick = (e: MouseEvent) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onContextMenu = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const card = opts.find(e.target);
    if (!card) return;
    // (Android raises this too, at the end of the same long press: that hold has opened it already.)
    e.preventDefault();
    if (Date.now() - heldAt > 1000) fire(card);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!(e.target instanceof HTMLElement)) return;
    const card = opts.find(e.target);
    if (!card || card !== e.target) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      fire(card);
    }
  };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('click', onClick, true);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('keydown', onKey);
  return () => {
    cancel();
    if (swallowTimer) clearTimeout(swallowTimer);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('contextmenu', onContextMenu);
    root.removeEventListener('keydown', onKey);
  };
}
