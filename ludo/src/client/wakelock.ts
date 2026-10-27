/**
 * Keeps the phone screen on while the app is open (Screen Wake Lock API, HTTPS only).
 * The browser drops the lock whenever the page is hidden, so it is re-requested when the
 * page becomes visible again and on taps (some browsers only grant it after a gesture).
 */
let lock: WakeLockSentinel | null = null;
let pending = false;

export async function keepScreenOn(): Promise<void> {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if ((lock && !lock.released) || pending) return;
  pending = true;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch {
    /* denied (battery saver) or unsupported */
  } finally {
    pending = false;
  }
}

export function installWakeLock(): void {
  document.addEventListener('visibilitychange', () => void keepScreenOn());
  window.addEventListener('pointerdown', () => void keepScreenOn(), { capture: true, passive: true });
}
