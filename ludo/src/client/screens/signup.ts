import { enterApp } from '../app.js';
import { ApiError, api } from '../api.js';
import { play } from '../sound.js';
import { KEYS, storage } from '../storage.js';
import { $, errorText } from '../ui.js';
import { adminLoginDialog } from './admin.js';

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function signupScreen(root: HTMLElement): void {
  root.innerHTML = `
    <div class="center-stack signup">
      <div class="big-emoji">🎲</div>
      <h2>Pick a player name</h2>
      <p class="muted">No password needed. This phone will remember you.</p>
      <form id="signup-form" class="form" autocomplete="off">
        <input id="username" class="input input-lg" placeholder="Your name" maxlength="16" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
        <p class="form-help" id="name-help">3–16 letters, numbers or _</p>
        <button class="btn btn-primary btn-xl" id="go" disabled>Let's play</button>
      </form>
      <button class="link admin-link" id="admin">Admin login</button>
    </div>`;
  const input = $<HTMLInputElement>(root, '#username');
  const help = $(root, '#name-help');
  const go = $<HTMLButtonElement>(root, '#go');

  input.addEventListener('input', () => {
    const ok = NAME_RE.test(input.value.trim());
    go.disabled = !ok;
    help.textContent = '3–16 letters, numbers or _';
    help.classList.toggle('bad', input.value.length > 0 && !ok);
  });

  $<HTMLFormElement>(root, '#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    go.disabled = true;
    try {
      const r = await api<{ token: string }>('POST', '/users', { username: input.value.trim() });
      storage.set(KEYS.session, r.token);
      play('turn');
      input.blur();
      await enterApp();
    } catch (err) {
      const e = err as ApiError;
      help.textContent = errorText(e.code);
      help.classList.add('bad');
      play('error');
      if (e.code === 'DEVICE_NOT_VERIFIED') location.reload();
    } finally {
      go.disabled = !NAME_RE.test(input.value.trim());
    }
  });

  $(root, '#admin').onclick = () => adminLoginDialog();
}
