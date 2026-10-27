import { VOICE_BITRATES } from '../shared/types.js';
import { play } from './sound.js';
import { state, subscribe } from './store.js';
import { ICONS, el, errorText, toast } from './ui.js';
import { voice } from './voice.js';

/** Mic badge beside a member's name: live / muted, pulsing while our connection to them is set up. */
export function voiceBadge(userId: number | null): string {
  if (userId === null) return '';
  const p = state.voice?.participants.find((x) => x.userId === userId);
  if (!p) return '';
  const connecting = userId !== state.user?.id && voice.joined && voice.peerStatus(userId) !== 'connected';
  const label = `${p.muted ? 'muted' : 'talking enabled'}${connecting ? ', connecting' : ''}`;
  return ` <span class="vc ${p.muted ? 'vc-muted' : 'vc-on'}${connecting ? ' vc-connecting' : ''}" title="${label}" aria-label="${label}">${p.muted ? ICONS.micOff : ICONS.mic}</span>`;
}

/**
 * Turns a button into "mute myself". If the microphone is blocked a tap asks for it again,
 * and if joining failed a tap retries. Returns the cleanup function.
 */
export function bindMuteButton(btn: HTMLButtonElement): () => void {
  const paint = () => {
    btn.hidden = !state.lobby;
    btn.classList.add('voice-btn');
    btn.classList.toggle('vb-on', voice.joined && !voice.silent);
    btn.classList.toggle('vb-muted', voice.joined && voice.muted && voice.micAvailable);
    btn.classList.toggle('vb-blocked', (voice.joined && !voice.micAvailable) || (!voice.joined && !voice.joining && Boolean(voice.error)));
    btn.disabled = voice.joining;
    let label: string;
    if (voice.joining) {
      btn.innerHTML = '<span class="spinner"></span>';
      label = 'Connecting voice chat';
    } else if (!voice.joined) {
      btn.innerHTML = ICONS.headset;
      label = 'Voice chat not connected, tap to retry';
    } else if (!voice.micAvailable) {
      btn.innerHTML = ICONS.micOff;
      label = 'Microphone blocked, tap to allow it';
    } else {
      btn.innerHTML = voice.muted ? ICONS.micOff : ICONS.mic;
      label = voice.muted ? 'Unmute myself' : 'Mute myself';
    }
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  btn.onclick = async () => {
    if (voice.joining) return;
    if (!voice.joined) {
      if (!state.lobby || !state.user) return;
      const err = await voice.join(state.lobby.id, state.user.id);
      if (err) toast(errorText(err), 'error');
      return;
    }
    if (!voice.micAvailable) {
      if (!(await voice.retryMic())) toast(errorText('MIC_DENIED'), 'error');
      return;
    }
    await voice.setMuted(!voice.muted);
    play('tap');
  };
  paint();
  const offVoice = voice.onChange(paint);
  const offStore = subscribe((changed) => changed.includes('lobby') && paint());
  return () => {
    offVoice();
    offStore();
  };
}

/** The lobby-wide voice quality picker (16–64 kbps); anyone in the lobby can change it. */
export function qualityPicker(): { el: HTMLElement; refresh: () => void } {
  const root = el(`
    <div class="voice-quality">
      <div class="menu-heading small">Voice quality <span class="muted">· applies to everyone</span></div>
      <div class="segmented" role="radiogroup" aria-label="Voice quality">
        ${VOICE_BITRATES.map((k) => `<button role="radio" data-kbps="${k}">${k}<small>kbps</small></button>`).join('')}
      </div>
      <p class="muted small">Lower uses less mobile data; higher sounds clearer.</p>
    </div>`);
  const refresh = () => {
    const current = state.voice?.bitrateKbps ?? voice.bitrateKbps;
    root.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
      const on = Number(b.dataset.kbps) === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  };
  root.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
    b.onclick = async () => {
      if (!state.lobby) return;
      const kbps = Number(b.dataset.kbps);
      const err = await voice.setBitrate(state.lobby.id, kbps);
      if (err) return toast(errorText(err), 'error');
      toast(`Voice quality: ${kbps} kbps`);
    };
  });
  refresh();
  return { el: root, refresh };
}
