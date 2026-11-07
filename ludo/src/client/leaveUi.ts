import { humanIds } from '../shared/lobbyPeople.js';
import { markLeaving, takeLeaving } from './leaving.js';
import { emit } from './net.js';
import { go } from './router.js';
import { play } from './sound.js';
import { state } from './store.js';
import { confirmDialog, el, esc, errorText, modal, toast } from './ui.js';

/**
 * Leaving the lobby for good (the ‹ button only goes home; the lobby keeps your seat). A host who
 * leaves while others are in it between games chooses: keep the lobby open for them (the next
 * player becomes host) or close it for everyone. Resolves true once the lobby was left.
 */
export async function leaveLobby(): Promise<boolean> {
  const lobby = state.lobby;
  const me = state.user?.id;
  if (!lobby || me === undefined) return false;
  const others = humanIds(lobby).filter((id) => id !== me);
  const isHost = lobby.hostId === me;
  if (isHost && lobby.status === 'waiting' && others.length) {
    const choice = await hostChoice(lobby.name, nameOf(others[0]));
    if (!choice) return false;
    return send(choice === 'close' ? 'lobby:close' : 'lobby:leave');
  }
  const text = isHost && !others.length ? 'Nobody else is in it, so it closes.' : 'You can join again with the password if there is room.';
  if (!(await confirmDialog('Leave lobby?', text, 'Leave', true))) return false;
  return send('lobby:leave');
}

function nameOf(userId: number): string {
  const lobby = state.lobby!;
  return [...lobby.members, ...lobby.spectators].find((m) => m.userId === userId)?.username ?? 'someone';
}

/** The host's question: keep the lobby open for the others, or close it for everyone. */
function hostChoice(lobbyName: string, nextHost: string): Promise<'leave' | 'close' | null> {
  return new Promise((resolve) => {
    const body = el(`<p>Close <b>${esc(lobbyName)}</b> for everyone too, or leave it open? If it stays open, <b>${esc(nextHost)}</b> becomes the host.</p>`);
    modal({
      title: 'Leave the lobby?',
      body,
      actions: [
        { label: 'Cancel', onClick: () => resolve(null) },
        { label: 'Leave, keep it open', onClick: () => resolve('leave') },
        { label: 'Close for everyone', kind: 'danger', onClick: () => resolve('close') },
      ],
      onDismiss: () => resolve(null),
    });
  });
}

async function send(event: 'lobby:leave' | 'lobby:close'): Promise<boolean> {
  markLeaving();
  go('home');
  const r = await emit(event, {});
  if (!r.ok) {
    takeLeaving();
    toast(errorText(r.error), 'error');
    return false;
  }
  play('tap');
  if (event === 'lobby:close') toast('Lobby closed', 'success');
  return true;
}
