import { state } from './store.js';
import { toast } from './ui.js';

/**
 * "Update app": makes the phone load the newest build from the server instead of a copy the
 * browser saved. Logins, the device's access and any game in progress are kept.
 */
const FLAG = 'ludo.updatingFrom';

/** The server runs a newer build than this page. */
export function updateAvailable(): boolean {
  return Boolean(state.serverVersion && state.serverVersion !== __APP_VERSION__);
}

export async function updateApp(): Promise<void> {
  try {
    sessionStorage.setItem(FLAG, __APP_VERSION__);
  } catch {
    /* private mode: we just won't say how it went */
  }
  try {
    if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
  } catch {
    /* no Cache Storage */
  }
  try {
    for (const reg of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await reg.unregister();
  } catch {
    /* no service workers */
  }
  // /refresh answers with Clear-Site-Data: "cache", which empties the browser's saved copies of
  // this site's files (its logins, cookies and local data stay), then forwards to the game.
  location.replace(`/refresh?t=${Date.now()}`);
}

/** On start: tidy the address after an update reload. */
export function tidyUpdateUrl(): void {
  if (/[?&]fresh=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
}

/** Once signed in after an update reload: say which version is running now. */
export function reportUpdate(): void {
  let from: string | null = null;
  try {
    from = sessionStorage.getItem(FLAG);
    sessionStorage.removeItem(FLAG);
  } catch {
    return;
  }
  if (from === null) return;
  if (updateAvailable()) toast(`Still on v${__APP_VERSION__}. Close the tab and open the game again to finish updating.`, 'error', 5000);
  else if (from !== __APP_VERSION__) toast(`Updated to v${__APP_VERSION__}`, 'success', 3000);
  else toast(`You're on the latest version (v${__APP_VERSION__})`, 'success', 3000);
}
