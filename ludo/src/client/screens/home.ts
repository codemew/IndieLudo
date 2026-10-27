import type { LobbySummary, PublicLobby } from '../../shared/types.js';
import { logout, showError } from '../app.js';
import { bindFullscreenButton } from '../fullscreen.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { isMuted, play, setMuted } from '../sound.js';
import { state, subscribe, update } from '../store.js';
import { $, el, esc, modal } from '../ui.js';
import { adminLoginDialog } from './admin.js';

export function homeScreen(root: HTMLElement): () => void {
  root.innerHTML = `
    <header class="topbar">
      <div class="me">
        <div class="avatar" id="avatar"></div>
        <div>
          <div class="me-name" id="me-name"></div>
          <div class="me-stats" id="me-stats"></div>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" id="fullscreen" aria-label="Fullscreen" hidden></button>
        <button class="icon-btn" id="sound" aria-label="Sound"></button>
        <button class="icon-btn" id="menu" aria-label="Menu">⋯</button>
      </div>
    </header>
    <section class="home-body">
      <div id="my-lobby"></div>
      <div class="section-title"><h3>Lobbies</h3><span class="live-dot" title="Live"></span></div>
      <div class="lobby-list" id="lobby-list"></div>
    </section>
    <footer class="bottom-bar">
      <button class="btn btn-primary btn-xl" id="create">＋ Create lobby</button>
    </footer>`;

  const paintSound = () => ($(root, '#sound').textContent = isMuted() ? '🔇' : '🔊');
  paintSound();
  $(root, '#sound').onclick = () => {
    setMuted(!isMuted());
    paintSound();
    play('tap');
  };
  $(root, '#menu').onclick = () => openMenu();
  $(root, '#create').onclick = () => createLobbyDialog();

  const offFs = bindFullscreenButton($<HTMLButtonElement>(root, '#fullscreen'));

  const render = () => {
    const u = state.user;
    if (u) {
      $(root, '#avatar').textContent = u.username[0]?.toUpperCase() ?? '?';
      $(root, '#me-name').textContent = u.username;
      $(root, '#me-stats').textContent = u.gamesPlayed !== undefined ? `${u.wins ?? 0} wins · ${u.gamesPlayed} games` : '';
    }
    renderMyLobby($(root, '#my-lobby'), state.lobby);
    renderList($(root, '#lobby-list'), state.lobbies, state.lobby);
    // Cards animate in on the first paint only, not on every live list update.
    root.classList.add('settled');
  };
  render();
  const offStore = subscribe((changed) => {
    if (changed.some((k) => k === 'lobbies' || k === 'lobby' || k === 'user')) render();
  });
  return () => {
    offStore();
    offFs();
  };
}

function renderMyLobby(box: HTMLElement, lobby: PublicLobby | null): void {
  box.innerHTML = '';
  if (!lobby) return;
  const card = el(`
    <button class="my-lobby-card">
      <div><div class="eyebrow">You're in</div><div class="lobby-name">${esc(lobby.name)}</div></div>
      <span class="chev">${lobby.status === 'playing' ? 'Resume ▶' : 'Open ›'}</span>
    </button>`);
  card.onclick = () => go(lobby.status === 'playing' ? 'game' : 'lobby');
  box.appendChild(card);
}

function renderList(list: HTMLElement, lobbies: LobbySummary[], mine: PublicLobby | null): void {
  list.innerHTML = '';
  if (lobbies.length === 0) {
    list.appendChild(el(`<div class="empty"><div class="big-emoji">🏠</div><p>No lobbies yet.</p><p class="muted">Create one and invite your friends.</p></div>`));
    return;
  }
  lobbies.forEach((l, i) => {
    const isMine = mine?.id === l.id;
    const card = el<HTMLButtonElement>(`
      <button class="lobby-card" style="animation-delay:${i * 40}ms">
        <div class="lobby-main">
          <div class="lobby-name">🔒 ${esc(l.name)}</div>
          <div class="lobby-sub">Host ${esc(l.hostName)}</div>
        </div>
        <div class="lobby-meta">
          <span class="seats">${'<i class="on"></i>'.repeat(l.players)}${'<i></i>'.repeat(Math.max(0, 4 - l.players))}</span>
          ${l.status === 'playing' ? '<span class="badge badge-live">In game</span>' : `<span class="badge">${l.players}/4</span>`}
        </div>
      </button>`);
    card.disabled = !isMine && (l.status === 'playing' || l.players >= 4);
    card.onclick = () => (isMine ? go('lobby') : joinLobbyDialog(l));
    list.appendChild(card);
  });
}

function joinLobbyDialog(l: LobbySummary): void {
  const body = el(`
    <form class="form" autocomplete="off">
      <input class="input" type="password" name="password" placeholder="Lobby password" maxlength="64" enterkeyhint="go" />
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input');
  const errEl = $(body, '.form-error');
  const submit = async () => {
    const r = await emit<PublicLobby>('lobby:join', { lobbyId: l.id, password: input.value });
    if (!r.ok) {
      errEl.textContent = r.error === 'WRONG_LOBBY_PASSWORD' ? 'Wrong password.' : r.error;
      play('error');
      return false;
    }
    update({ lobby: r.data ?? null });
    play('turn');
    go('lobby');
    return true;
  };
  const m = modal({ title: `Join ${l.name}`, body, actions: [{ label: 'Cancel' }, { label: 'Join', kind: 'primary', onClick: submit }] });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit().then((ok) => ok && m.close());
  });
}

function createLobbyDialog(): void {
  const body = el(`
    <form class="form" autocomplete="off">
      <label class="field"><span>Lobby name</span><input class="input" name="name" maxlength="32" placeholder="Friday night" /></label>
      <label class="field"><span>Lobby password <small>(share with friends)</small></span><input class="input" name="password" maxlength="64" /></label>
      <label class="field"><span>Creation password <small>(from the server config)</small></span><input class="input" type="password" name="createPassword" maxlength="128" /></label>
      <p class="form-error"></p>
    </form>`);
  const val = (n: string) => $<HTMLInputElement>(body, `[name=${n}]`).value;
  const errEl = $(body, '.form-error');
  const submit = async () => {
    const problem = !val('name').trim() ? 'Give the lobby a name.' : !val('password') ? 'Set a lobby password.' : '';
    if (problem) {
      errEl.textContent = problem;
      return false;
    }
    const r = await emit<PublicLobby>('lobby:create', { name: val('name').trim(), password: val('password'), createPassword: val('createPassword') });
    if (!r.ok) {
      showError(r.error);
      return false;
    }
    update({ lobby: r.data ?? null });
    play('turn');
    go('lobby');
    return true;
  };
  const m = modal({ title: 'Create lobby', body, actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: submit }] });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit().then((ok) => ok && m.close());
  });
}

function openMenu(): void {
  const body = el(`<div class="menu-list"></div>`);
  const m = modal({ title: 'Menu', body, actions: [{ label: 'Close' }] });
  const item = (label: string, fn: () => void) => {
    const b = el<HTMLButtonElement>(`<button class="menu-item">${label}</button>`);
    b.onclick = () => {
      m.close();
      fn();
    };
    body.appendChild(b);
  };
  item(state.isAdmin ? '🛡️ Admin panel' : '🛡️ Admin login', () => (state.isAdmin ? go('admin') : adminLoginDialog()));
  item('↩ Sign out on this phone', () => void logout());
}
