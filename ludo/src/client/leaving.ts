/**
 * Set just before this phone leaves (or closes) its lobby on purpose, so the `lobby:state` null
 * that follows isn't taken for being removed or the lobby being closed by someone else.
 */
let onPurpose = false;

export function markLeaving(): void {
  onPurpose = true;
}

/** Whether the lobby was left on purpose; reading it clears it. */
export function takeLeaving(): boolean {
  const was = onPurpose;
  onPurpose = false;
  return was;
}
