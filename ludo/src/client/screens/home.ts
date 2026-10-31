import { AVATARS, avatarFace } from '../../shared/avatars.js';
import { MAX_SPECTATORS, type LobbySummary, type PublicLobby } from '../../shared/types.js';
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
      <button class="me" id="me" aria-label="Edit your profile">
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
  $(root, '#me').onclick = () => profileDialog();
  $(root, '#create').onclick = () => createLobbyDialog();

  const offFs = bindFullscreenButton($<HTMLButtonElement>(root, '#fullscreen'));
  // While in a lobby you are in its voice chat even here, so the mute control stays at hand.
  const offMute = bindMuteButton($<HTMLButtonElement>(root, '#mute'));

  const render = () => {
    const u = state.user;
    if (u) {
      const av = $(root, '#avatar');
      av.textContent = avatarFace(u.avatar, u.username);
      av.classList.toggle('has-avatar', Boolean(u.avatar));
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
    const size = l.size ?? 4;
    const card = el<HTMLButtonElement>(`
      <button class="lobby-card" style="animation-delay:${i * 40}ms">
        <div class="lobby-main">
          <div class="lobby-name">🔒 ${esc(l.name)}</div>
          <div class="lobby-sub">Host ${esc(l.hostName)}${l.watching ? ` · 👀 ${l.watching} watching` : ''}${l.teams ? ' · <span class="badge badge-team">🤝 Team-up</span>' : ''}${size > 4 ? ` · <span class="badge badge-size">👥 ${size} players</span>` : ''}</div>
        </div>
        <div class="lobby-meta">
          <span class="seats">${'<i class="on"></i>'.repeat(l.players)}${'<i></i>'.repeat(Math.max(0, size - l.players))}</span>
          ${l.status === 'playing' ? '<span class="badge badge-live">In game · 👀 Watch</span>' : `<span class="badge">${l.players}/${size}</span>`}
        </div>
      </button>`);
    // A running game or a full lobby can still be watched, while there's room on the side.
    card.disabled = !isMine && (l.watching ?? 0) >= MAX_SPECTATORS && (l.status === 'playing' || l.players >= size);
    card.onclick = () => (isMine ? go('lobby') : joinLobbyDialog(l));
    list.appendChild(card);
  });
}

/** Join with the password: on a free seat, or to watch (the only choice once a game runs or the seats are full). */
function joinLobbyDialog(l: LobbySummary): void {
  const canSit = l.status === 'waiting' && l.players < (l.size ?? 4);
  const canWatch = (l.watching ?? 0) < MAX_SPECTATORS;
  const body = el(`
    <form class="form" autocomplete="off">
      <input class="input" type="password" name="password" placeholder="Lobby password" maxlength="64" enterkeyhint="go" />
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input');
  const errEl = $(body, '.form-error');
  const submit = async (watch = !canSit) => {
    const r = await emit<PublicLobby>('lobby:join', { lobbyId: l.id, password: input.value, watch });
    if (!r.ok) {
      errEl.textContent = r.error === 'WRONG_LOBBY_PASSWORD' ? 'Wrong password.' : errorText(r.error);
      play('error');
      return false;
    }
    update({ lobby: r.data ?? null });
    play('turn');
    go('lobby');
    return true;
  };
  const watchAction = { label: '👀 Watch', kind: canSit ? undefined : ('primary' as const), onClick: () => submit(true) };
  const m = modal({
    title: canSit ? `Join ${l.name}` : `Watch ${l.name}`,
    body,
    actions: [{ label: 'Cancel' }, ...(canWatch ? [watchAction] : []), ...(canSit ? [{ label: 'Join', kind: 'primary' as const, onClick: () => submit(false) }] : [])],
  });
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
  item('✎ Edit my profile', () => profileDialog());
  if (canInstall()) item('📲 Install app (fullscreen, no browser bars)', () => void promptInstall());
  item(state.isAdmin ? '🛡️ Admin panel' : '🛡️ Admin login', () => (state.isAdmin ? go('admin') : adminLoginDialog()));
  item('↩ Sign out on this phone', () => void logout());
}

/**
 * Tap your name tag: pick an avatar (an animal or pet) and/or a new name. Lobbies and games you're
 * in show the change for everyone right away.
 */
function profileDialog(): void {
  const user = state.user;
  if (!user) return;
  let avatar = user.avatar ?? '';
  const body = el(`
    <form class="form profile-form" autocomplete="off">
      <div class="avatar avatar-lg" id="avatar-preview" aria-hidden="true"></div>
      <div class="avatar-grid" role="radiogroup" aria-label="Avatar"></div>
      <label class="field">
        <span>Name</span>
        <input class="input" name="username" value="${esc(user.username)}" maxlength="16" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
      </label>
      <p class="muted small">3–16 letters, numbers or _</p>
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input');
  const grid = $(body, '.avatar-grid');
  const preview = $(body, '#avatar-preview');
  const paint = () => {
    const name = input.value.trim() || user.username;
    preview.textContent = avatarFace(avatar, name);
    preview.classList.toggle('has-avatar', Boolean(avatar));
    for (const b of grid.querySelectorAll<HTMLButtonElement>('.avatar-opt')) {
      const on = b.dataset.avatar === avatar;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  const option = (id: string, label: string, face: string) => {
    const b = el<HTMLButtonElement>(`<button type="button" class="avatar-opt" role="radio" data-avatar="${id}" aria-label="${esc(label)}" title="${esc(label)}">${esc(face)}</button>`);
    b.onclick = () => {
      avatar = id;
      paint();
    };
    grid.appendChild(b);
  };
  option('', 'No avatar (first letter of your name)', user.username[0]?.toUpperCase() ?? '?');
  for (const a of AVATARS) option(a.id, a.name, a.emoji);
  input.addEventListener('input', paint);
  paint();

  const save = async () => {
    const username = input.value.trim();
    const patch: { username?: string; avatar?: string } = {};
    if (username !== user.username) patch.username = username;
    if (avatar !== (user.avatar ?? '')) patch.avatar = avatar;
    if (!Object.keys(patch).length) return true;
    try {
      const r = await api<{ user: NonNullable<typeof state.user> }>('PATCH', '/me', patch);
      update({ user: { ...user, ...r.user } });
      toast(patch.username ? `You're now ${r.user.username}` : 'Avatar saved', 'success');
      return true;
    } catch (e) {
      $(body, '.form-error').textContent = errorText((e as ApiError).code);
      return false;
    }
  };
  const m = modal({ title: 'Your profile', body, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: save }] });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    void save().then((ok) => ok && m.close());
  });
}

/**
 * The app's version, and the button that loads the newest build. It only works when the server
 * has a newer version than this phone runs; otherwise it is disabled and says so.
 */
function renderUpdate(box: HTMLElement): void {
  const ready = updateAvailable();
  const known = Boolean(state.serverVersion);
  const html = ready
    ? `<span><b>v${esc(state.serverVersion)} is ready</b> <span class="muted small">· you have v${__APP_VERSION__}</span></span><button class="btn btn-small btn-primary" id="update">⟳ Update now</button>`
    : `<span class="muted small">Ludo v${__APP_VERSION__}</span><button class="btn btn-small btn-ghost" id="update" disabled aria-disabled="true">${known ? '✓ Up to date' : 'Checking…'}</button>`;
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
  box.classList.toggle('ready', ready);
  const btn = $<HTMLButtonElement>(box, '#update');
  if (!ready) return;
  btn.onclick = () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    void updateApp();
  };
}
