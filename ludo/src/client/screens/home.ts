import type { LobbySummary, PublicLobby } from '../../shared/types.js';
import { logout, showError } from '../app.js';
import { bindFullscreenButton } from '../fullscreen.js';
import { canInstall, promptInstall } from '../install.js';
import { updateApp, updateAvailable } from '../update.js';
import { ApiError, api } from '../api.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { isMuted, play, setMuted } from '../sound.js';
import { state, subscribe, update } from '../store.js';
import { $, el, errorText, esc, modal, toast } from '../ui.js';
import { bindMuteButton } from '../voiceUi.js';
import { adminLoginDialog } from './admin.js';

export function homeScreen(root: HTMLElement): () => void {
  root.innerHTML = `
    <header class="topbar">
      <button class="me" id="me" aria-label="Change your name">
        <div class="avatar" id="avatar"></div>
        <div>
          <div class="me-name"><span id="me-name"></span> <span class="me-edit" aria-hidden="true">✎</span></div>
          <div class="me-stats" id="me-stats"></div>
        </div>
      </button>
      <div class="topbar-actions">
        <button class="icon-btn" id="mute" aria-label="Mute myself" hidden></button>
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
      <div class="app-update" id="app-update"></div>
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
  $(root, '#me').onclick = () => renameDialog();
  $(root, '#create').onclick = () => createLobbyDialog();

  const offFs = bindFullscreenButton($<HTMLButtonElement>(root, '#fullscreen'));
  // While in a lobby you are in its voice chat even here, so the mute control stays at hand.
  const offMute = bindMuteButton($<HTMLButtonElement>(root, '#mute'));

  const render = () => {
    const u = state.user;
    if (u) {
      $(root, '#avatar').textContent = u.username[0]?.toUpperCase() ?? '?';
      $(root, '#me-name').textContent = u.username;
      $(root, '#me-stats').textContent = u.gamesPlayed !== undefined ? `${u.wins ?? 0} wins · ${u.gamesPlayed} games` : '';
    }
    renderMyLobby($(root, '#my-lobby'), state.lobby);
    renderUpdate($(root, '#app-update'));
    renderList($(root, '#lobby-list'), state.lobbies, state.lobby);
    // Cards animate in on the first paint only, not on every live list update.
    root.classList.add('settled');
  };
  render();
  const offStore = subscribe((changed) => {
    if (changed.some((k) => k === 'lobbies' || k === 'lobby' || k === 'user' || k === 'serverVersion')) render();
  });
  return () => {
    offStore();
    offFs();
    offMute();
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
  item('✎ Change my name', () => renameDialog());
  if (canInstall()) item('📲 Install app (fullscreen, no browser bars)', () => void promptInstall());
  item(state.isAdmin ? '🛡️ Admin panel' : '🛡️ Admin login', () => (state.isAdmin ? go('admin') : adminLoginDialog()));
  item('↩ Sign out on this phone', () => void logout());
}

/** Tap your name or avatar: pick a new name. Lobbies and games you're in update for everyone. */
function renameDialog(): void {
  const user = state.user;
  if (!user) return;
  const body = el(`
    <form class="form" autocomplete="off">
      <label class="field">
        <span>New name</span>
        <input class="input" name="username" value="${esc(user.username)}" maxlength="16" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
      </label>
      <p class="muted small">3–16 letters, numbers or _</p>
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input');
  const save = async () => {
    const username = input.value.trim();
    if (username === user.username) return true;
    try {
      const r = await api<{ user: NonNullable<typeof state.user> }>('PATCH', '/me', { username });
      update({ user: { ...user, ...r.user } });
      toast(`You're now ${r.user.username}`, 'success');
      return true;
    } catch (e) {
      $(body, '.form-error').textContent = errorText((e as ApiError).code);
      return false;
    }
  };
  const m = modal({ title: 'Change your name', body, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: save }] });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    void save().then((ok) => ok && m.close());
  });
  setTimeout(() => input.select(), 50);
}

/** The app's version, and the button that loads the newest build (highlighted when one is ready). */
function renderUpdate(box: HTMLElement): void {
  const ready = updateAvailable();
  const html = ready
    ? `<span><b>v${esc(state.serverVersion)} is ready</b> <span class="muted small">· you have v${__APP_VERSION__}</span></span><button class="btn btn-small btn-primary" id="update">⟳ Update now</button>`
    : `<span class="muted small">Ludo v${__APP_VERSION__}</span><button class="btn btn-small btn-ghost" id="update">⟳ Update app</button>`;
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
  box.classList.toggle('ready', ready);
  const btn = $<HTMLButtonElement>(box, '#update');
  btn.onclick = () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    void updateApp();
  };
}
