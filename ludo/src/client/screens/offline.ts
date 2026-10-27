import { boot } from '../app.js';
import { $ } from '../ui.js';

export function offlineScreen(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="center-stack">
      <div class="big-emoji">📡</div>
      <h2>Can't reach the game server</h2>
      <p class="muted">Check your Wi-Fi or mobile data, then try again.</p>
      <button class="btn btn-primary" id="retry">Try again</button>
    </div>`;
  const retry = () => void boot();
  $(root, '#retry').onclick = retry;
  window.addEventListener('online', retry);
  return () => window.removeEventListener('online', retry);
}
