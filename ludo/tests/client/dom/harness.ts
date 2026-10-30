/**
 * Shared set-up for the client DOM tests (happy-dom): the page skeleton the screens expect, and
 * stand-ins for what happy-dom lacks (the Web Animations API, a reduced-motion preference so
 * every board animation is instant).
 */
import { vi } from 'vitest';

export function setupDom(): void {
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div><div id="modal-root"></div><div id="net-banner" hidden></div>';
  const fakeAnimation = () => ({ finished: Promise.resolve(), cancel() {}, play() {}, pause() {}, finish() {}, onfinish: null, currentTime: 0 });
  (Element.prototype as any).animate = vi.fn(fakeAnimation);
  (Element.prototype as any).getAnimations = () => [];
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any;
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
}

/** Lets pending promises and short timers run. */
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Clicks the first element matching `sel` (throws if there is none, to fail loudly). */
export function click(sel: string, root: ParentNode = document): void {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`nothing matches ${sel}`);
  el.click();
}

/** The text of every toast shown so far. */
export const toasts = () => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent);

/** The dialog on top (closing ones fade out for a moment first). */
export function topModal(): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>('#modal-root .modal-backdrop:not(.out) .modal')];
  if (!all.length) throw new Error('no dialog open');
  return all.at(-1)!;
}

/** Clicks a button of the dialog on top by its label. */
export function modalButton(label: string): void {
  const m = topModal();
  const b = [...m.querySelectorAll<HTMLButtonElement>('.modal-actions .btn')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no modal button "${label}" (have: ${[...m.querySelectorAll('.btn')].map((x) => x.textContent).join(', ')})`);
  b.click();
}
