import { ICONS } from './ui.js';

type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function canFullscreen(): boolean {
  const d = document as FsDocument;
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  const d = document as FsDocument;
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement);
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already left */
  }
}

/** Calls fn whenever fullscreen is entered or left. Returns the unsubscribe function. */
export function onFullscreenChange(fn: () => void): () => void {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
  return () => {
    document.removeEventListener('fullscreenchange', fn);
    document.removeEventListener('webkitfullscreenchange', fn);
  };
}

/** Must be called from a user gesture. Locks portrait where the browser allows it. */
export async function enterFullscreen(): Promise<void> {
  if (isFullscreen() || !canFullscreen()) return;
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    return;
  }
  try {
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('portrait');
  } catch {
    /* not supported (desktop, iOS) */
  }
}

/**
 * Turns a button into a fullscreen on/off toggle that tracks the real state. Hidden when the
 * browser can't go fullscreen, or when the app is installed and already fullscreen.
 * Returns the cleanup function.
 */
export function bindFullscreenButton(btn: HTMLButtonElement): () => void {
  const paint = () => {
    // Chrome reports display-mode: fullscreen while API fullscreen is on, so check that first.
    btn.hidden = !canFullscreen() || (isStandalone() && !isFullscreen());
    btn.innerHTML = isFullscreen() ? ICONS.collapse : ICONS.expand;
    btn.setAttribute('aria-label', isFullscreen() ? 'Exit fullscreen' : 'Fullscreen');
  };
  paint();
  btn.onclick = () => void (isFullscreen() ? exitFullscreen() : enterFullscreen());
  return onFullscreenChange(paint);
}
