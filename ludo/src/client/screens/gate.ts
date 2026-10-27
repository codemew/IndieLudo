import { enterApp } from '../app.js';
import { ApiError, api } from '../api.js';
import { vibrate } from '../haptics.js';
import { play } from '../sound.js';
import { KEYS, storage } from '../storage.js';
import { $ } from '../ui.js';

/** Access-code entry: one real input behind six visual boxes, so paste and autofill just work. */
export function gateScreen(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="center-stack gate">
      <div class="big-emoji">🔐</div>
      <h2>Enter access code</h2>
      <p class="muted">Ask the host for the 6-digit code shown on the server.</p>
      <label class="otp" for="otp-input">
        <input id="otp-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" aria-label="Access code" />
        <div class="otp-boxes">${'<span class="otp-box"></span>'.repeat(6)}</div>
      </label>
      <p class="form-error" id="gate-error"></p>
    </div>`;
  const input = $<HTMLInputElement>(root, '#otp-input');
  const boxes = [...root.querySelectorAll<HTMLElement>('.otp-box')];
  const errorEl = $(root, '#gate-error');
  const otp = $(root, '.otp');
  let busy = false;
  let lockTimer: ReturnType<typeof setInterval> | undefined;

  const paint = () => {
    const v = input.value;
    boxes.forEach((b, i) => {
      b.textContent = v[i] ?? '';
      b.classList.toggle('filled', i < v.length);
      b.classList.toggle('caret', i === Math.min(v.length, 5) && document.activeElement === input);
    });
  };

  const lockFor = (sec: number) => {
    input.disabled = true;
    let left = sec;
    const tick = () => {
      errorEl.textContent = `Too many attempts. Try again in ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left}s`}.`;
      if (left-- <= 0) {
        clearInterval(lockTimer);
        input.disabled = false;
        errorEl.textContent = '';
        input.focus();
      }
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  };

  const submit = async () => {
    if (busy) return;
    busy = true;
    otp.classList.add('checking');
    try {
      const r = await api<{ deviceToken: string }>('POST', '/gate/verify', { code: input.value });
      storage.set(KEYS.device, r.deviceToken);
      otp.classList.add('ok');
      play('home');
      vibrate(30);
      setTimeout(() => void enterApp(), 450);
    } catch (e) {
      const err = e as ApiError;
      otp.classList.remove('shake');
      void otp.offsetWidth;
      otp.classList.add('shake');
      play('error');
      vibrate([40, 40, 40]);
      input.value = '';
      paint();
      if (err.status === 429) lockFor(err.retryAfterSec ?? 60);
      else errorEl.textContent = err.code === 'NETWORK' ? 'No connection.' : 'That code is not right.';
    } finally {
      busy = false;
      otp.classList.remove('checking');
    }
  };

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    errorEl.textContent = '';
    paint();
    if (input.value.length === 6) void submit();
  });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', paint);
  setTimeout(() => input.focus(), 250);
  paint();
  return () => clearInterval(lockTimer);
}
