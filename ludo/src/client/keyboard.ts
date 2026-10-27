/**
 * Keeps text fields above the on-screen keyboard. Android Chrome shrinks the page itself
 * (interactive-widget=resizes-content), but iOS Safari and other browsers only shrink the
 * visual viewport and slide the keyboard over fixed-position content. So the app and its
 * dialogs are pinned to the visual viewport (--vv-top / --vv-height), and the focused field
 * is scrolled into the middle of what's left.
 */
const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select';
/** A visible area this much shorter than the page means a keyboard is up. */
const KEYBOARD_MIN_PX = 120;

export function installKeyboardAvoidance(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let raf = 0;

  const reveal = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.matches(FIELD)) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const sync = () => {
    raf = 0;
    if (!vv) return;
    const open = window.innerHeight - vv.height > KEYBOARD_MIN_PX;
    root.classList.toggle('kb-open', open);
    if (open) {
      root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      root.style.setProperty('--vv-height', `${vv.height}px`);
    } else {
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-height');
    }
    reveal();
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(sync);
  };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);

  // The keyboard animates in after focus; reveal again once it has settled.
  document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches(FIELD)) return;
    setTimeout(reveal, 300);
    setTimeout(reveal, 650);
  });
}
