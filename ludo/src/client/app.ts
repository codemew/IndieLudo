import type { GameUpdate, Hello } from '../shared/protocol.js';
import type { PublicGameState, PublicLobby } from '../shared/types.js';
import { ApiError, api } from './api.js';
import { connect, disconnect, emit, isConnected } from './net.js';
import { currentScreen, go } from './router.js';
import { state, subscribe, update } from './store.js';
import { KEYS, storage } from './storage.js';
import { errorText, toast } from './ui.js';
import { voice } from './voice.js';

/** The game screen registers itself here while mounted so it can animate updates. */
let gameHandler: ((u: GameUpdate) => void) | null = null;
export function setGameHandler(fn: ((u: GameUpdate) => void) | null): void {
  gameHandler = fn;
}

let firstHello = true;

/** After the splash tap: device gate → session → socket. */
export async function boot(): Promise<void> {
  try {
    const s = await api<{ verified: boolean; deviceToken?: string }>('GET', '/gate/status');
    if (s.deviceToken) storage.set(KEYS.device, s.deviceToken);
    if (!s.verified) {
      storage.remove(KEYS.device);
      go('gate');
      return;
    }
  } catch (e) {
    go('offline');
    return;
  }
  await enterApp();
}

export async function enterApp(): Promise<void> {
  const token = storage.get(KEYS.session);
  if (!token) {
    go('signup');
    return;
  }
  let me: { user: PublicUser | null; isAdmin: boolean };
  try {
    me = await api('GET', '/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      storage.remove(KEYS.session);
      go('signup');
      return;
    }
    go('offline');
    return;
  }
  update({ user: me.user, isAdmin: me.isAdmin });
  if (!me.user) {
    go('admin');
    return;
  }
  connectSocket(token);
}

interface PublicUser {
  id: number;
  username: string;
  gamesPlayed?: number;
  wins?: number;
}

function connectSocket(token: string): void {
  firstHello = true;
  connect(token, {
    bind: (s) => {
      s.on('hello', (h) => void onHello(h));
      s.on('lobby:list', (l) => update({ lobbies: l }));
      s.on('lobby:state', (l) => onLobbyState(l));
      s.on('game:state', (u) => onGameUpdate(u));
      s.on('session:revoked', () => signOut('Your session was ended by an admin.'));
      s.on('voice:state', (v) => {
        if (v.lobbyId === state.lobby?.id) update({ voice: v });
        voice.onState(v);
      });
      s.on('voice:signal', (sig) => void voice.onSignal(sig));
    },
    // The server dropped us from voice when the old socket went away; rejoin if we were in.
    onConnect: (reconnected) => reconnected && void voice.onReconnect(),
    onUnauthorized: () => signOut('Please sign in again.'),
  });
}

async function onHello(h: Hello): Promise<void> {
  update({ user: { ...state.user, ...h.user }, lobby: h.lobby });
  void emit<typeof state.lobbies>('lobby:list', {}).then((r) => r.ok && r.data && update({ lobbies: r.data }));
  const wasFirst = firstHello;
  firstHello = false;

  if (h.game) {
    onGameUpdate({ state: h.game });
    return;
  }
  // No running game: maybe ours ended while we were away.
  const lastGame = state.game?.id ?? storage.get(KEYS.lastGame);
  if (lastGame) {
    const r = await emit<PublicGameState>('game:resume', { gameId: lastGame });
    if (r.ok && r.data?.finished) {
      update({ game: r.data });
      if (currentScreen() === 'game' && gameHandler) gameHandler({ state: r.data });
      else go('results');
      return;
    }
    storage.remove(KEYS.lastGame);
  }
  if (wasFirst || currentScreen() === 'game') go(h.lobby ? 'lobby' : 'home');
}

function onLobbyState(l: PublicLobby | null): void {
  update({ lobby: l });
  // Leaving on purpose navigates home first, so still being on the lobby screen means we were removed.
  if (!l && currentScreen() === 'lobby') {
    go('home');
    toast('You were removed from the lobby.');
  }
}

function onGameUpdate(u: GameUpdate): void {
  storage.set(KEYS.lastGame, u.state.id);
  if (gameHandler && state.game?.id === u.state.id) {
    gameHandler(u);
    return;
  }
  const isNew = state.game?.id !== u.state.id;
  update({ game: u.state });
  const screen = currentScreen();
  if (u.state.finished) {
    if (screen !== 'results' && screen !== 'admin') go('results');
    return;
  }
  // A new game (or one starting from the lobby) opens the board; a player who went home
  // on purpose stays there and can resume from the lobby card.
  if (isNew || screen === 'lobby') go('game');
}

/** Coming back to the foreground: refetch the game in case updates were missed. */
export async function resyncGame(): Promise<void> {
  const g = state.game;
  if (!g || g.finished || !isConnected()) return;
  const r = await emit<PublicGameState>('game:resume', { gameId: g.id });
  if (r.ok && r.data) onGameUpdate({ state: r.data });
}

/**
 * Every lobby member is in the lobby's voice chat: join when we enter a lobby (and are
 * online), leave when we leave it. Matches and results don't interrupt it.
 */
function syncVoice(): void {
  const lobbyId = state.lobby?.id ?? null;
  if (voice.lobbyId && voice.lobbyId !== lobbyId) void voice.leave();
  if (!lobbyId) {
    if (state.voice) update({ voice: null });
    return;
  }
  if (state.voice && state.voice.lobbyId !== lobbyId) update({ voice: null });
  if (state.user && state.online && !voice.lobbyId) void voice.join(lobbyId, state.user.id);
}
subscribe((changed) => {
  if (changed.includes('lobby') || changed.includes('online')) syncVoice();
});

export function signOut(message?: string): void {
  void voice.leave(false);
  disconnect();
  storage.remove(KEYS.session);
  storage.remove(KEYS.lastGame);
  update({ user: null, isAdmin: false, lobby: null, game: null, voice: null, lobbies: [] });
  go('signup');
  if (message) toast(message, 'error', 3500);
}

export async function logout(): Promise<void> {
  try {
    await api('POST', '/logout');
  } catch {
    /* already gone */
  }
  signOut();
}

export function showError(code: string): void {
  toast(errorText(code), 'error');
}
