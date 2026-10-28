import type { SwapEnd, SwapRequest } from '../shared/types.js';
import { emit } from './net.js';
import { vibrate } from './haptics.js';
import { play } from './sound.js';
import { state, update } from './store.js';
import { COLOR_NAME, el, errorText, esc, modal, toast } from './ui.js';

/**
 * Colour swaps in the lobby. Asking: the lobby seat's ⇄ chip (see lobby.ts). Being asked: a
 * prompt on whatever screen you are on, one at a time, gone when the request ends.
 */
const incoming: SwapRequest[] = [];
let showing: { req: SwapRequest; close: () => void } | null = null;

const nameOf = (userId: number) => state.lobby?.members.find((m) => m.userId === userId)?.username ?? 'They';
const dot = (c: SwapRequest['fromColor']) => `<span class="swap-dot s-${c}"></span><b>${COLOR_NAME[c]}</b>`;

export function onSwapRequest(req: SwapRequest): void {
  if (req.lobbyId !== state.lobby?.id) return;
  for (let i = incoming.length - 1; i >= 0; i--) if (incoming[i].from === req.from) incoming.splice(i, 1);
  incoming.push(req);
  play('turn');
  vibrate([30, 40, 30]);
  showNext();
}

export function onSwapEnded(e: { from: number; to: number; how: SwapEnd }): void {
  const me = state.user?.id;
  if (e.from === me) {
    update({ swapOut: null });
    const who = esc(nameOf(e.to));
    if (e.how === 'accepted') toast(`Swapped colours with ${who}`, 'success');
    else if (e.how === 'declined') toast(`${who} said no to swapping`);
    else if (e.how === 'expired') toast(`${who} didn't answer the swap`);
  }
  if (e.to === me) {
    for (let i = incoming.length - 1; i >= 0; i--) if (incoming[i].from === e.from) incoming.splice(i, 1);
    if (showing?.req.from === e.from) {
      showing.close();
      showing = null;
      if (e.how === 'cancelled' || e.how === 'expired') toast(`${esc(nameOf(e.from))}'s swap request ended`);
      showNext();
    }
  }
}

function showNext(): void {
  if (showing) return;
  const req = incoming.shift();
  if (!req) return;
  const left = req.expiresAt - Date.now();
  if (left <= 0) return showNext();
  const body = el(`
    <div class="swap-ask">
      <p><b>${esc(req.fromName)}</b> wants to swap colours.</p>
      <p class="swap-line">You'd be ${dot(req.fromColor)} · ${esc(req.fromName)} would be ${dot(req.toColor)}</p>
      <div class="swap-timer"><i style="animation-duration:${left}ms"></i></div>
    </div>`);
  const answer = async (accept: boolean) => {
    showing = null;
    const r = await emit('lobby:swapAnswer', { from: req.from, accept });
    if (!r.ok) toast(errorText(r.error), 'error');
    else if (accept) toast(`You're ${COLOR_NAME[req.fromColor]} now`, 'success');
    showNext();
  };
  const m = modal({
    title: 'Swap colours?',
    body,
    actions: [
      { label: 'No thanks', onClick: () => void answer(false) },
      { label: 'Swap', kind: 'primary', onClick: () => void answer(true) },
    ],
    onDismiss: () => void answer(false),
  });
  showing = { req, close: m.close };
}

/** Lobby seat chip: ask the player on that seat (a bot swaps at once), or cancel our request. */
export async function askSwap(color: SwapRequest['toColor'], toUserId: number | null): Promise<void> {
  play('tap');
  const r = await emit<{ swapped: boolean }>('lobby:swapAsk', { color });
  if (!r.ok) return toast(errorText(r.error), 'error');
  if (r.data?.swapped) toast(`You're ${COLOR_NAME[color]} now`, 'success');
  else if (toUserId !== null) update({ swapOut: { to: toUserId, color } });
}

export async function cancelSwap(): Promise<void> {
  play('tap');
  update({ swapOut: null });
  await emit('lobby:swapCancel', {});
}
