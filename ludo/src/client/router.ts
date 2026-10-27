export type ScreenFn = (root: HTMLElement, params?: Record<string, unknown>) => (() => void) | void;

const screens = new Map<string, ScreenFn>();
let current: { name: string; cleanup?: () => void } | null = null;

export function register(name: string, fn: ScreenFn): void {
  screens.set(name, fn);
}

export function currentScreen(): string | null {
  return current?.name ?? null;
}

/**
 * Swaps the screen with a short slide/fade; the previous screen's cleanup runs first.
 * Going to the screen that is already showing is a no-op (screens re-render from the store).
 */
export function go(name: string, params?: Record<string, unknown>): void {
  const fn = screens.get(name);
  if (!fn) throw new Error(`unknown screen ${name}`);
  if (current?.name === name) return;
  current?.cleanup?.();
  const app = document.getElementById('app')!;
  // Every screen still on the page leaves, including ones mid-transition from a quick earlier go().
  for (const old of [...app.children]) {
    if (old.classList.contains('screen-out')) continue;
    old.classList.add('screen-out');
    setTimeout(() => old.remove(), 220);
  }
  const root = document.createElement('main');
  root.className = `screen screen-${name}`;
  app.appendChild(root);
  current = { name, cleanup: undefined };
  const cleanup = fn(root, params);
  if (current.name === name) current.cleanup = cleanup ?? undefined;
}
