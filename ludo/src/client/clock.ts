/**
 * The server's clock, as this phone knows it. The difference to our own clock is measured at the
 * moment a message carrying the server's time arrives (app.ts), never later: a game update can
 * wait behind an animation, or sit in the store while another screen shows, and by then its
 * `serverNow` is old. Countdowns (the turn timer) read the time from here.
 */
let offset = 0;

/** A message stamped with the server's time has just arrived. */
export function noteServerTime(serverNow: number): void {
  if (Number.isFinite(serverNow)) offset = serverNow - Date.now();
}

/** What the server's clock reads now. */
export const serverTime = (): number => Date.now() + offset;
