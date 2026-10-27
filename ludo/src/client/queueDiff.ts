/**
 * Which queued dice are new since the queue was last drawn, so only those pop in. Dice that
 * were already showing keep still: a roll appends one, a move removes one, so the old queue
 * lines up with the new one in order. Anything else (a new turn) counts as all new.
 */
export function freshDice(shown: readonly number[], next: readonly number[]): boolean[] {
  let j = 0;
  return next.map((v) => {
    while (j < shown.length && shown[j] !== v) j++;
    if (j < shown.length) {
      j++;
      return false;
    }
    return true;
  });
}
