import { openBubbleAt, type BubbleOption, type OpenBubble } from './bubble.js';
import { VOLUME_STEPS, nearestStep, setVolume, volumeOf, volumeText } from './listenVolume.js';
import { play } from './sound.js';
import { state } from './store.js';
import { ICONS, el, esc } from './ui.js';
import { voice } from './voice.js';

/** The speaker for each step: loud, medium, quiet, off. */
const ICON = new Map<number, string>([
  [1, ICONS.speakerHigh],
  [0.6, ICONS.speakerMid],
  [0.3, ICONS.speakerLow],
  [0, ICONS.speakerOff],
]);

/** The person whose card was held can be turned down for us: another member, while voice chat is on. */
export function canAdjust(userId: number | null): userId is number {
  return userId !== null && userId !== state.user?.id && voice.enabled;
}

let open: OpenBubble | null = null;

/**
 * The volume bubble for one player (bubble.ts again, as for the tokens): four round choices from full
 * volume to muted. It only changes how loud they are on this phone; nobody else's volume changes,
 * and nothing is sent. The choice is remembered for the next game too.
 */
export function openVolumeBubble(card: HTMLElement, userId: number, name: string, opts: { topLimit?: () => number } = {}): void {
  play('tap');
  open?.close();
  const now = nearestStep(volumeOf(userId));
  const layer = el('<div class="bubble-layer bubble-screen"></div>');
  document.body.appendChild(layer);
  const options: BubbleOption[] = VOLUME_STEPS.map((step) => {
    const label = step === 0 ? `Mute ${name} for me` : `Hear ${name} at ${volumeText(step)}`;
    return {
      cls: `vol-opt${step === now ? ' on' : ''}${step === 0 ? ' off' : ''}`,
      attrs: `data-vol="${step}" aria-pressed="${step === now}"`,
      html: `<span class="bubble-ico vol"><span class="vol-sp">${ICON.get(step)}</span><small>${step === 0 ? 'off' : volumeText(step)}</small></span>`,
      label: esc(label),
      pick: () => {
        setVolume(userId, step);
        play('tap');
      },
    };
  });
  const bubble = openBubbleAt({
    layer,
    label: esc(`Volume of ${name}, only for you`),
    caption: `<span class="cap-name">${esc(name)}</span><span class="cap-rest"> · only for you</span>`,
    options,
    focus: Math.max(0, VOLUME_STEPS.indexOf(now as (typeof VOLUME_STEPS)[number])),
    anchor: () => card.getBoundingClientRect(),
    topLimit: opts.topLimit,
    refocus: () => card,
    onClose: () => {
      layer.remove();
      if (open === bubble) open = null;
    },
  });
  open = bubble;
}

/** Closes the volume bubble if one is open (the screen is going away). */
export function closeVolumeBubble(): void {
  open?.close();
}
