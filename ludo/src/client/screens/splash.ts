import { boot } from '../app.js';
import { canFullscreen, enterFullscreen, isIos, isStandalone } from '../fullscreen.js';
import { canInstall, onInstallChange, promptInstall } from '../install.js';
import { play, unlock } from '../sound.js';
import { KEYS, storage } from '../storage.js';
import { $ } from '../ui.js';
import { keepScreenOn } from '../wakelock.js';

export function splashScreen(root: HTMLElement): () => void {
  const fs = canFullscreen() && !isStandalone();
  const showIosHint = isIos() && !isStandalone() && storage.get(KEYS.a2hsDismissed) !== '1';
  root.innerHTML = `
    <div class="splash">
      <div class="splash-logo" aria-hidden="true">
        <span class="sq c-red"></span><span class="sq c-green"></span>
        <span class="sq c-blue"></span><span class="sq c-yellow"></span>
        <span class="splash-die"><i></i><i></i><i></i></span>
      </div>
      <h1 class="title">Ludo</h1>
      <p class="tagline">Roll · Race · Capture</p>
      <footer class="splash-foot">
        <p class="app-version">v${__APP_VERSION__}</p>
        <p class="made-with">Made with <span aria-label="love" role="img">❤️</span>, by Somnath</p>
      </footer>
      <button class="btn btn-primary btn-xl" id="play">${fs ? 'Tap to play fullscreen' : 'Tap to play'}</button>
      <button class="btn btn-ghost" id="install" hidden>📲 Install app <small class="muted">· fullscreen, no browser bars</small></button>
      ${
        showIosHint
          ? `<div class="hint-card" id="ios-hint">
              <b>Tip:</b> for fullscreen on iPhone, tap <span class="share-icon">⎋</span> Share → <b>Add to Home Screen</b>.
              <button class="link" id="ios-dismiss">Got it</button>
            </div>`
          : ''
      }
    </div>`;
  const btn = $<HTMLButtonElement>(root, '#play');
  btn.onclick = () => {
    // These must start synchronously inside the tap for iOS/Android to allow them.
    unlock();
    void enterFullscreen();
    void keepScreenOn();
    play('tap');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    void boot();
  };
  root.querySelector<HTMLButtonElement>('#ios-dismiss')?.addEventListener('click', () => {
    storage.set(KEYS.a2hsDismissed, '1');
    root.querySelector('#ios-hint')?.remove();
  });
  const install = $<HTMLButtonElement>(root, '#install');
  const paintInstall = () => (install.hidden = !canInstall());
  install.onclick = () => void promptInstall();
  paintInstall();
  return onInstallChange(paintInstall);
}
