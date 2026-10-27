/** Android-only vibration; iOS Safari has no Vibration API, so this quietly does nothing there. */
export function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignored */
    }
  }
}
