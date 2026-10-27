/**
 * "Install app": browsers show their own "<site> is now full screen, swipe to exit" bubble
 * every time a page goes fullscreen, and no page can hide it. Launched from the home screen
 * as an installed app (manifest display: fullscreen) the game opens fullscreen with no bubble.
 * Chrome offers installing only over trusted HTTPS (a mkcert or real certificate).
 */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

export function installInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((fn) => fn());
  });
}

export function canInstall(): boolean {
  return deferred !== null;
}

/** Must run inside a tap. Resolves true when the player installed the app. */
export async function promptInstall(): Promise<boolean> {
  const p = deferred;
  if (!p) return false;
  deferred = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  listeners.forEach((fn) => fn());
  return outcome === 'accepted';
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
