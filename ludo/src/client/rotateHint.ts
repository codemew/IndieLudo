/**
 * Shows "Turn your phone upright" when a phone is held sideways. This used to be the CSS
 * `(orientation: landscape)` query, but that compares the page's width and height. When the
 * keyboard opens, the page gets shorter than it is wide and the query reported a sideways
 * phone that was upright. So it now asks the screen itself, and never shows while typing.
 */
const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select';
/** Phones only: a tablet or desktop held landscape is fine. */
const PHONE_SHORT_SIDE_MAX = 500;

/** True for a phone turned on its side; exported for tests. */
export function isSideways(o: { orientationType?: string; screenW: number; screenH: number; typing: boolean }): boolean {
  if (o.typing) return false;
  const landscape = o.orientationType ? o.orientationType.startsWith('landscape') : o.screenW > o.screenH;
  return landscape && Math.min(o.screenW, o.screenH) <= PHONE_SHORT_SIDE_MAX;
}

export function installRotateHint(): void {
  const sync = () => {
    const active = document.activeElement;
    // Older iOS has no screen.orientation and never swaps screen.width/height; it has window.orientation.
    const legacy = (window as { orientation?: number }).orientation;
    const sideways = isSideways({
      orientationType: screen.orientation?.type ?? (typeof legacy === 'number' ? (Math.abs(legacy) === 90 ? 'landscape' : 'portrait') : undefined),
      screenW: screen.width,
      screenH: screen.height,
      typing: active instanceof HTMLElement && active.matches(FIELD),
    });
    document.documentElement.classList.toggle('sideways', sideways);
  };
  screen.orientation?.addEventListener?.('change', sync);
  window.addEventListener('orientationchange', sync);
  window.addEventListener('resize', sync);
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => setTimeout(sync, 0));
  sync();
}
