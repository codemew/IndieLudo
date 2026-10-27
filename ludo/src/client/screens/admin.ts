import { enterApp, signOut } from '../app.js';
import { ApiError, api } from '../api.js';
import { go } from '../router.js';
import { state, update } from '../store.js';
import { KEYS, storage } from '../storage.js';
import { $, confirmDialog, el, errorText, esc, modal, timeAgo, toast } from '../ui.js';

interface AdminUser {
  id: number;
  username: string;
  created_at: number;
  last_seen: number;
  games_played: number;
  wins: number;
}
interface AdminSession {
  id: number;
  user_id: number | null;
  username: string | null;
  device_id: number;
  is_admin: number;
  user_agent: string;
  last_seen: number;
}
interface AdminDevice {
  id: number;
  user_agent: string;
  ip_first_seen: string;
  verified_at: number;
  last_seen: number;
}

/** Short, readable device label from a user agent string. */
function deviceLabel(ua: string): string {
  const os = /Android [\d.]+/.exec(ua)?.[0] ?? /iPhone|iPad/.exec(ua)?.[0] ?? /Windows|Mac OS X|Linux/.exec(ua)?.[0] ?? 'Unknown';
  const browser = /SamsungBrowser|CriOS|FxiOS|Firefox|Edg|Chrome|Safari/.exec(ua)?.[0] ?? '';
  return `${os}${browser ? ' · ' + browser.replace('CriOS', 'Chrome').replace('FxiOS', 'Firefox').replace('Edg', 'Edge') : ''}`;
}

export function adminLoginDialog(): void {
  const body = el(`
    <form class="form" autocomplete="off">
      <input class="input" type="password" placeholder="Admin password" maxlength="128" enterkeyhint="go" />
      <p class="form-error"></p>
    </form>`);
  const input = $<HTMLInputElement>(body, 'input');
  const errEl = $(body, '.form-error');
  const submit = async () => {
    try {
      const r = await api<{ token: string }>('POST', '/admin/login', { password: input.value });
      storage.set(KEYS.session, r.token);
      update({ isAdmin: true });
      if (state.user) go('admin');
      else await enterApp();
      return true;
    } catch (e) {
      errEl.textContent = errorText((e as ApiError).code);
      return false;
    }
  };
  const m = modal({ title: 'Admin login', body, actions: [{ label: 'Cancel' }, { label: 'Log in', kind: 'primary', onClick: submit }] });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit().then((ok) => ok && m.close());
  });
}

type Tab = 'users' | 'devices' | 'sessions' | 'code';

export function adminScreen(root: HTMLElement): void {
  let tab: Tab = 'users';
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Back">‹</button>
      <div class="topbar-title"><div class="eyebrow">Admin</div><div class="lobby-name">Control panel</div></div>
      <button class="icon-btn" id="exit" aria-label="Leave admin">⏻</button>
    </header>
    <nav class="tabs">
      <button data-tab="users" class="active">Users</button>
      <button data-tab="devices">Devices</button>
      <button data-tab="sessions">Sessions</button>
      <button data-tab="code">Code</button>
    </nav>
    <section class="admin-body" id="panel"></section>`;
  const panel = $(root, '#panel');

  $(root, '#back').onclick = () => (state.user ? go('home') : void exitAdmin());
  $(root, '#exit').onclick = () => void exitAdmin();
  for (const b of root.querySelectorAll<HTMLButtonElement>('.tabs button')) {
    b.onclick = () => {
      tab = b.dataset.tab as Tab;
      root.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      void load();
    };
  }

  async function exitAdmin(): Promise<void> {
    try {
      await api('POST', '/admin/logout');
    } catch {
      /* ignore */
    }
    update({ isAdmin: false });
    if (state.user) go('home');
    else signOut();
  }

  const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401 || err.status === 403) {
        toast('Admin session ended', 'error');
        await exitAdmin();
        return undefined;
      }
      toast(errorText(err.code), 'error');
      return undefined;
    }
  };

  async function load(): Promise<void> {
    panel.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    if (tab === 'users') return renderUsers('');
    if (tab === 'devices') return renderDevices();
    if (tab === 'sessions') return renderSessions();
    return renderCode();
  }

  async function renderUsers(q: string): Promise<void> {
    const users = await guard(() => api<AdminUser[]>('GET', `/admin/users?q=${encodeURIComponent(q)}`));
    if (!users) return;
    panel.innerHTML = `
      <input class="input search" placeholder="Search users" value="${esc(q)}" />
      <p class="muted small">${users.length} user${users.length === 1 ? '' : 's'}</p>
      <ul class="admin-list">${users
        .map(
          (u) => `
        <li data-id="${u.id}">
          <div class="row-main"><b>${esc(u.username)}</b><span class="muted small">#${u.id} · seen ${timeAgo(u.last_seen)} · ${u.wins}/${u.games_played} wins</span></div>
          <div class="row-actions"><button class="chip" data-act="rename">Rename</button><button class="chip chip-danger" data-act="delete">Delete</button></div>
        </li>`,
        )
        .join('')}</ul>`;
    const search = $<HTMLInputElement>(panel, '.search');
    let t: ReturnType<typeof setTimeout>;
    search.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => void renderUsers(search.value).then(() => $<HTMLInputElement>(panel, '.search')?.focus()), 300);
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      const id = Number(b.closest('li')!.dataset.id);
      const user = users.find((u) => u.id === id)!;
      b.onclick = async () => {
        if (b.dataset.act === 'delete') {
          if (!(await confirmDialog(`Delete ${user.username}?`, 'Their sessions end and they leave any lobby. This cannot be undone.', 'Delete', true))) return;
          if (await guard(() => api('DELETE', `/admin/users/${id}`))) toast('User deleted', 'success');
          return void renderUsers(search.value);
        }
        const body = el(`<form class="form"><input class="input" value="${esc(user.username)}" maxlength="16" /><p class="form-error"></p></form>`);
        modal({
          title: `Rename ${user.username}`,
          body,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Save',
              kind: 'primary',
              onClick: async () => {
                try {
                  await api('PATCH', `/admin/users/${id}`, { username: $<HTMLInputElement>(body, 'input').value.trim() });
                  void renderUsers(search.value);
                  return true;
                } catch (e) {
                  $(body, '.form-error').textContent = errorText((e as ApiError).code);
                  return false;
                }
              },
            },
          ],
        });
      };
    });
  }

  async function renderDevices(): Promise<void> {
    const devices = await guard(() => api<AdminDevice[]>('GET', '/admin/devices'));
    if (!devices) return;
    panel.innerHTML = `
      <p class="muted small">Devices that entered the access code. Revoking one makes it enter the code again.</p>
      <ul class="admin-list">${devices
        .map(
          (d) => `
        <li data-id="${d.id}">
          <div class="row-main"><b>${esc(deviceLabel(d.user_agent))}</b><span class="muted small">#${d.id} · ${esc(d.ip_first_seen)} · seen ${timeAgo(d.last_seen)}</span></div>
          <div class="row-actions"><button class="chip chip-danger">Revoke device</button></div>
        </li>`,
        )
        .join('')}</ul>`;
    panel.querySelectorAll<HTMLButtonElement>('.chip-danger').forEach((b) => {
      const id = Number(b.closest('li')!.dataset.id);
      b.onclick = async () => {
        if (!(await confirmDialog('Revoke device?', 'It will be signed out and must enter the access code again.', 'Revoke', true))) return;
        if (await guard(() => api('DELETE', `/admin/devices/${id}`))) toast('Device revoked', 'success');
        void renderDevices();
      };
    });
  }

  async function renderSessions(): Promise<void> {
    const sessions = await guard(() => api<AdminSession[]>('GET', '/admin/sessions'));
    if (!sessions) return;
    panel.innerHTML = `
      <p class="muted small">Signed-in phones. Revoking a session signs that phone out (it keeps its device access).</p>
      <ul class="admin-list">${sessions
        .map(
          (s) => `
        <li data-id="${s.id}">
          <div class="row-main"><b>${s.username ? esc(s.username) : '(admin only)'}${s.is_admin ? ' 🛡️' : ''}</b><span class="muted small">${esc(deviceLabel(s.user_agent))} · device #${s.device_id} · seen ${timeAgo(s.last_seen)}</span></div>
          <div class="row-actions"><button class="chip chip-danger">Revoke</button></div>
        </li>`,
        )
        .join('')}</ul>`;
    panel.querySelectorAll<HTMLButtonElement>('.chip-danger').forEach((b) => {
      const id = Number(b.closest('li')!.dataset.id);
      b.onclick = async () => {
        if (await guard(() => api('DELETE', `/admin/sessions/${id}`))) toast('Session revoked', 'success');
        void renderSessions();
      };
    });
  }

  async function renderCode(): Promise<void> {
    const r = await guard(() => api<{ code: string }>('GET', '/admin/code'));
    if (!r) return;
    const paint = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
    panel.innerHTML = `
      <div class="code-card">
        <p class="muted">Current access code</p>
        <div class="code-big" id="code">${paint(r.code)}</div>
        <p class="muted small">New devices need this once. Devices that already entered a code stay verified when it changes.</p>
        <button class="btn btn-primary" id="rotate">Regenerate code</button>
      </div>`;
    $(panel, '#rotate').onclick = async () => {
      const n = await guard(() => api<{ code: string }>('POST', '/admin/code/rotate'));
      if (n) {
        $(panel, '#code').textContent = paint(n.code);
        toast('New code generated', 'success');
      }
    };
  }

  void load();
}
