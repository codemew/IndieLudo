import { voice } from './voice.js';

/** How often the talking rings are updated (20 times a second is smooth enough for rings). */
const TICK_MS = 50;
/** Rings fade out over about this long after someone stops talking. */
const RELEASE_MS = 300;

const shown = new WeakMap<HTMLElement, number>();

/**
 * The talking animation: every avatar marked `data-talk="<userId>"` (lobby seats, the watcher
 * list, game player chips) gets `--vl`, that person's talking level 0..1, and `.talking` while
 * they talk; CSS turns that into rings that radiate out, bigger and brighter the louder they
 * are. The levels come from the voice packets themselves (voice.levelOf), so it costs no data.
 */
export function installTalkUi(): void {
  const tick = () => {
    const avatars = voice.joined ? document.querySelectorAll<HTMLElement>('[data-talk]') : [];
    for (const el of avatars) {
      const target = voice.levelOf(Number(el.dataset.talk));
      const prev = shown.get(el) ?? 0;
      // Up at once, down gently, so rings don't flicker between syllables.
      const level = target >= prev ? target : Math.max(target, prev - TICK_MS / RELEASE_MS);
      if (Math.abs(level - prev) < 0.04 && (level > 0) === (prev > 0)) continue;
      shown.set(el, level);
      el.style.setProperty('--vl', level.toFixed(2));
      el.classList.toggle('talking', level > 0.02);
    }
    // Idle cheaply outside voice chat.
    setTimeout(tick, voice.joined ? TICK_MS : 500);
  };
  tick();
}
