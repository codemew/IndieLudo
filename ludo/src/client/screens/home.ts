import { AVATARS, avatarFace, isAvatarId } from '../../shared/avatars.js';
import { MAX_SPECTATORS, type LobbySummary, type OnlineUser, type PublicLobby } from '../../shared/types.js';
import { humanIds } from '../../shared/lobbyPeople.js';
import { logout, showError } from '../app.js';
import { bindFullscreenButton } from '../fullscreen.js';
import { canInstall, promptInstall } from '../install.js';
import { updateApp, updateAvailable } from '../update.js';
import { ApiError, api } from '../api.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { isMuted, play, setMuted } from '../sound.js';
import { state, subscribe, update } from '../store.js';
import { $, el, errorText, esc, modal, timeAgo, toast } from '../ui.js';
import { KEYS, storage } from '../storage.js';
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
    <nav class="tabs home-tabs" role="tablist" aria-label="Home">
      <button role="tab" id="tab-lobbies" data-tab="lobbies" aria-controls="panel-lobbies">🏠 Lobbies</button>
      <button role="tab" id="tab-users" data-tab="users" aria-controls="panel-users">👥 Users <span class="tab-count" id="users-count"></span></button>
    </nav>
    <section class="home-body">
      <div id="my-lobby"></div>
      <div role="tabpanel" id="panel-lobbies" aria-labelledby="tab-lobbies">
        <div class="section-title"><h3>Lobbies</h3><span class="live-dot" title="Live"></span></div>
        <div class="lobby-list" id="lobby-list"></div>
      </div>
      <div role="tabpanel" id="panel-users" aria-labelledby="tab-users" hidden>
        <div class="section-title"><h3>Online now</h3><span class="live-dot" title="Live"></span></div>
        <ul class="user-list" id="user-list"></ul>
      </div>
    </section>
    <footer class="bottom-bar">
      <div class="app-update" id="app-update"></div>
      <button class="btn btn-primary btn-xl" id="create">＋ Create lobby</button>
      <p class="made-with">Made with <span aria-label="love" role="img">❤️</span>, by Somnath</p>
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

  // Lobbies or Users: one Tab stop, arrow keys switch; the choice is remembered on this phone.
  let tab: HomeTab = storage.get(KEYS.homeTab) === 'users' ? 'users' : 'lobbies';
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.home-tabs [role=tab]')];
  const showTab = (next: HomeTab, focus = false) => {
    tab = next;
    storage.set(KEYS.homeTab, next);
    for (const b of tabs) {
      const on = b.dataset.tab === next;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    $(root, '#panel-lobbies').hidden = next !== 'lobbies';
    $(root, '#panel-users').hidden = next !== 'users';
    $<HTMLButtonElement>(root, '#create').hidden = next !== 'lobbies';
    if (next === 'users') renderUsers($(root, '#user-list'), state.onlineUsers);
  };
  for (const b of tabs) b.onclick = () => showTab(b.dataset.tab as HomeTab);
  $(root, '.home-tabs').addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ke.key)) return;
    ke.preventDefault();
    showTab(ke.key === 'Home' ? 'lobbies' : ke.key === 'End' ? 'users' : tab === 'lobbies' ? 'users' : 'lobbies', true);
  });

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
    renderUsersCount();
    if (tab === 'users') renderUsers($(root, '#user-list'), state.onlineUsers);
    // Cards animate in on the first paint only, not on every live list update.
    root.classList.add('settled');
  };
  const renderUsersCount = () => {
    const n = state.onlineUsers.length;
    $(root, '#users-count').textContent = n ? String(n) : '';
    $(root, '#tab-users').setAttribute('aria-label', `Users, ${n} online`);
  };
  showTab(tab);
  render();
  const offStore = subscribe((changed) => {
    if (changed.some((k) => k === 'lobbies' || k === 'lobby' || k === 'user' || k === 'serverVersion')) render();
    else if (changed.includes('onlineUsers')) {
      renderUsersCount();
      if (tab === 'users') renderUsers($(root, '#user-list'), state.onlineUsers);
    }
  });
  // "Online 5m" moves on by itself.
  const tick = setInterval(() => tab === 'users' && renderUsers($(root, '#user-list'), state.onlineUsers), 30_000);
  return () => {
    clearInterval(tick);
    offStore();
    offFs();
    offMute();
  };
}

type HomeTab = 'lobbies' | 'users';

const WHERE: Record<string, string> = { lobby: 'In lobby', playing: 'Playing in', watching: 'Watching' };

/** "5m", "2h 10m": how long someone has been online. */
function onlineFor(since: number): string {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/**
 * Everyone online: name and avatar, where they are (home, a lobby, a game), how long they've been
 * on, and each phone they're on (model, system, browser and network) unless they hid it.
 */
/** Desktop systems get a computer icon; phones and tablets (and unknowns) a phone. */
const DESKTOP = /^(Windows|macOS|Linux|ChromeOS)\b/;

function renderUsers(list: HTMLElement, users: OnlineUser[]): void {
  const me = state.user?.id;
  // You first, then everyone else, longest online first (the server's order).
  const sorted = [...users.filter((u) => u.id === me), ...users.filter((u) => u.id !== me)];
  const alone = !users.some((u) => u.id !== me);
  const html = sorted.map((u) => userRow(u, u.id === me)).join('') + (alone ? '<li class="empty"><p class="muted">Nobody else is online right now.</p></li>' : '');
  if (list.dataset.html === html) return;
  list.dataset.html = html;
  list.innerHTML = html;
}

function userRow(u: OnlineUser, mine: boolean): string {
  const where = u.where.kind === 'home' ? 'On the home screen' : `${WHERE[u.where.kind]} <b>${esc(u.where.lobby)}</b>`;
  const devices = u.hidden
    ? `<div class="user-device muted">🙈 ${mine ? 'Your phone is hidden from others (Edit profile to show it)' : 'Phone details hidden'}</div>`
    : (u.devices ?? [])
        .map((d) => {
          const phone = [d.model, d.os, d.browser].filter(Boolean).join(' · ') || 'Unknown device';
          const icon = !d.model && DESKTOP.test(d.os) ? '💻' : '📱';
          return `<div class="user-device"><span aria-hidden="true">${icon}</span> ${esc(phone)}${d.isp ? `<br><span aria-hidden="true">🌐</span> ${esc(d.isp)}` : ''}</div>`;
        })
        .join('');
  return `
    <li class="user-row${mine ? ' user-me' : ''}" data-user="${u.id}">
      <div class="avatar avatar-sm${u.avatar ? ' has-avatar' : ''}" aria-hidden="true">${esc(avatarFace(u.avatar, u.username))}</div>
      <div class="user-main">
        <div class="user-name"><b>${esc(u.username)}</b>${mine ? ' <span class="you">you</span>' : ''}<span class="user-since">online ${onlineFor(u.since)}</span></div>
        <div class="user-where">${where}</div>
        ${devices}
      </div>
    </li>`;
}

function renderMyLobby(box: HTMLElement, lobby: PublicLobby | null): void {
  box.innerHTML = '';
  if (!lobby) return;
  const card = el(`
    <button class="my-lobby-card">
      <div><div class="eyebrow">You're in · your place is kept</div><div class="lobby-name">${esc(lobby.name)}</div></div>
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
          <div class="lobby-sub">Host ${esc(l.hostName)}${l.watching ? ` · 👀 ${l.watching} watching` : ''}${l.teams ? ` · <span class="badge badge-team">🤝 Team-up${l.share ? ' · sharing' : ''}</span>` : ''}${size > 4 ? ` · <span class="badge badge-size">👥 ${size} players</span>` : ''}${l.powerUps ? ' · <span class="badge badge-rule">⚡ Power ups</span>' : ''}${l.golden ? ' · <span class="badge badge-rule">👑 Golden</span>' : ''}</div>
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
      ${leaveNote(l.id)}
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

/**
 * A line in the join and create dialogs when you're already in another lobby: going ahead leaves
 * it (and as its host, the next player there takes over).
 */
function leaveNote(target?: string): string {
  const lobby = state.lobby;
  const me = state.user?.id;
  if (!lobby || lobby.id === target || me === undefined) return '';
  const nextHost = lobby.hostId === me ? [...lobby.members, ...lobby.spectators].find((m) => m.userId !== null && m.userId !== me && humanIds(lobby).includes(m.userId)) : undefined;
  return `<p class="form-note">You'll leave <b>${esc(lobby.name)}</b>${nextHost ? ` and <b>${esc(nextHost.username)}</b> becomes its host` : ''}.</p>`;
}

/**
 * New lobby: a name and a join password. The creation password is asked only until this account
 * has entered it once; after that the server remembers the account (an admin can undo that).
 */
function createLobbyDialog(): void {
  const remembered = Boolean(state.user?.canCreate);
  const body = el(`
    <form class="form" autocomplete="off">
      ${leaveNote()}
      <label class="field"><span>Lobby name</span><input class="input" name="name" maxlength="32" placeholder="Friday night" /></label>
      <label class="field"><span>Lobby password <small>(share with friends)</small></span><input class="input" name="password" maxlength="64" /></label>
      <label class="field" id="create-pw"${remembered ? ' hidden' : ''}><span>Creation password <small>(asked once: this account is remembered)</small></span><input class="input" type="password" name="createPassword" maxlength="128" /></label>
      ${remembered ? '<p class="form-note ok" id="create-ok">✓ You can create lobbies without the creation password.</p>' : ''}
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
      const field = $(body, '#create-pw');
      if (r.error === 'WRONG_CREATE_PASSWORD' && field.hidden) {
        // An admin changed the creation password or forgot this account: ask for it once more.
        field.hidden = false;
        body.querySelector('#create-ok')?.remove();
        if (state.user) update({ user: { ...state.user, canCreate: false } });
        errEl.textContent = 'The creation password is needed again (it was changed).';
        $<HTMLInputElement>(field, 'input').focus();
        return false;
      }
      if (r.error === 'WRONG_CREATE_PASSWORD') {
        errEl.textContent = errorText(r.error);
        play('error');
        return false;
      }
      showError(r.error);
      return false;
    }
    if (state.user && !state.user.canCreate) update({ user: { ...state.user, canCreate: true } });
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
  // An id that is no longer on the list counts as none, so one tile is always the tab stop.
  let avatar = isAvatarId(user.avatar) ? user.avatar : '';
  const body = el(`
    <form class="form profile-form" autocomplete="off">
      <div class="avatar avatar-lg" id="avatar-preview" aria-hidden="true"></div>
      <div class="avatar-grid" role="radiogroup" aria-label="Avatar"></div>
      <label class="field">
        <span>Name</span>
        <input class="input" name="username" value="${esc(user.username)}" maxlength="16" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
      </label>
      <p class="muted small">3–16 letters, numbers or _</p>
      <label class="rule-check device-check">
        <input type="checkbox" name="showDevice"${user.showDevice !== false ? ' checked' : ''} />
        <span class="rule-box" aria-hidden="true"></span>
        <span class="rule-text"><b>Show my phone in Users</b><small>Others see your phone model, browser and network (ISP) while you're online</small></span>
      </label>
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input[name=username]');
  const showDevice = $<HTMLInputElement>(body, 'input[name=showDevice]');
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
      b.tabIndex = on ? 0 : -1; // one tab stop for the group; the arrow keys move inside it
    }
    // The "none" tile shows the initial of the name as it is typed, like the preview.
    grid.firstElementChild!.textContent = name[0]?.toUpperCase() ?? '?';
  };
  const option = (id: string, label: string, face: string) => {
    const b = el<HTMLButtonElement>(`<button type="button" class="avatar-opt" role="radio" data-avatar="${id}" aria-label="${esc(label)}" title="${esc(label)}">${esc(face)}</button>`);
    b.onclick = () => {
      avatar = id;
      paint();
    };
    grid.appendChild(b);
  };
  option('', 'No avatar (first letter of your name)', '');
  for (const a of AVATARS) option(a.id, a.name, a.emoji);
  input.addEventListener('input', paint);
  // Radio-group keys: arrows (and Home/End) pick the neighbour and move focus to it.
  grid.addEventListener('keydown', (e) => {
    const opts = [...grid.querySelectorAll<HTMLButtonElement>('.avatar-opt')];
    const at = opts.findIndex((b) => b === document.activeElement);
    if (at < 0) return;
    const to: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: opts.length - 1 };
    if (!(e.key in to)) return;
    e.preventDefault();
    const next = opts[(to[e.key] + opts.length) % opts.length];
    avatar = next.dataset.avatar ?? '';
    paint();
    next.focus();
  });
  paint();

  const save = async () => {
    const username = input.value.trim();
    const patch: { username?: string; avatar?: string; showDevice?: boolean } = {};
    if (username !== user.username) patch.username = username;
    if (avatar !== (user.avatar ?? '')) patch.avatar = avatar;
    if (showDevice.checked !== (user.showDevice !== false)) patch.showDevice = showDevice.checked;
    if (!Object.keys(patch).length) return true;
    try {
      const r = await api<{ user: NonNullable<typeof state.user> }>('PATCH', '/me', patch);
      update({ user: { ...user, ...r.user } });
      toast(patch.username ? `You're now ${r.user.username}` : patch.avatar !== undefined ? 'Avatar saved' : 'Profile saved', 'success');
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
