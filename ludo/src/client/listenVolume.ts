import { KEYS, storage } from './storage.js';

/**
 * How loud each other player's voice is for us: 1 = as sent (the default), 0 = muted for us. Kept on
 * this phone only. Nothing is sent to the server, so nobody else hears a change. It is stored per
 * player, so it survives a reload and applies in later games and lobbies too.
 */

/** The choices in the volume bubble, loudest first. */
export const VOLUME_STEPS = [1, 0.6, 0.3, 0] as const;

/** Most players remembered; the oldest change is forgotten first. */
const MAX_REMEMBERED = 64;

const levels = new Map<number, number>();
const listeners = new Set<(userId: number) => void>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(storage.get(KEYS.listenVolume) ?? '{}') as unknown;
    if (!saved || typeof saved !== 'object') return;
    for (const [id, level] of Object.entries(saved)) {
      const userId = Number(id);
      if (Number.isInteger(userId) && userId > 0 && typeof level === 'number' && level >= 0 && level < 1) levels.set(userId, round(level));
    }
  } catch {
    /* unreadable: start from the defaults */
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Their volume for us, 0..1. */
export function volumeOf(userId: number | null): number {
  if (userId === null) return 1;
  load();
  return levels.get(userId) ?? 1;
}

export function setVolume(userId: number, level: number): void {
  load();
  const v = Number.isFinite(level) ? round(Math.min(1, Math.max(0, level))) : 1;
  if (volumeOf(userId) === v) return;
  levels.delete(userId); // (re-added last: the newest change is kept longest)
  if (v < 1) levels.set(userId, v);
  while (levels.size > MAX_REMEMBERED) levels.delete(levels.keys().next().value!);
  if (levels.size) storage.set(KEYS.listenVolume, JSON.stringify(Object.fromEntries(levels)));
  else storage.remove(KEYS.listenVolume);
  for (const fn of listeners) fn(userId);
}

/** Called after a player's volume changed. */
export function onVolumeChange(fn: (userId: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Who has been turned down or muted, for the repaint after a change. */
export function adjusted(): ReadonlyMap<number, number> {
  load();
  return levels;
}

/** The step closest to a stored level (older versions or other builds may have saved another value). */
export function nearestStep(level: number): number {
  return VOLUME_STEPS.reduce((best, s) => (Math.abs(s - level) < Math.abs(best - level) ? s : best));
}

export function volumeText(level: number): string {
  return level === 0 ? 'muted' : `${Math.round(level * 100)}%`;
}

/** Test hook: forget everything held in memory, so the next read loads from storage again. */
export function resetListenVolume(): void {
  levels.clear();
  loaded = false;
}
