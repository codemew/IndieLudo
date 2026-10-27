import { VOICE_BITRATES } from '../shared/types.js';
import { play } from './sound.js';
import { state, subscribe } from './store.js';
import { ICONS, confirmDialog, el, errorText, toast } from './ui.js';
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
    btn.classList.toggle('vb-blocked', (voice.joined && !voice.micAvailable) || (!voice.joined && !voice.joining && voice.enabled && Boolean(voice.error)));
    btn.classList.toggle('vb-off', !voice.enabled);
    btn.disabled = voice.joining;
    let label: string;
    if (!voice.enabled) {
      btn.innerHTML = ICONS.headsetOff;
      label = 'The host turned voice chat off';
    } else if (voice.joining) {
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
    if (!voice.enabled) return toast(errorText('VOICE_DISABLED'));
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

const isHost = () => Boolean(state.lobby && state.user && state.lobby.hostId === state.user.id);

/**
 * The lobby's voice controls, used on the lobby screen and in the game menu:
 * - a status line
 * - Rejoin, for anyone whose audio got stuck
 * - for the host only: Restart for everyone, turn voice chat on or off, and the quality picker
 */
export function voicePanel(): { el: HTMLElement; destroy: () => void } {
  const root = el(`
    <div class="voice-panel">
      <p class="voice-status small" aria-live="polite"></p>
      <div class="menu-row voice-actions"></div>
    </div>`);
  const quality = qualityPicker();
  root.appendChild(quality.el);
  const status = root.querySelector<HTMLElement>('.voice-status')!;
  const actions = root.querySelector<HTMLElement>('.voice-actions')!;

  const button = (html: string, cls: string, fn: () => Promise<void>) => {
    const b = el<HTMLButtonElement>(`<button class="btn btn-small ${cls}">${html}</button>`);
    b.onclick = async () => {
      b.disabled = true;
      play('tap');
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    };
    actions.appendChild(b);
  };

  const refresh = () => {
    const host = isHost();
    const lobbyId = state.lobby?.id;
    if (!voice.enabled) {
      status.textContent = host ? 'Voice chat is off for everyone.' : 'The host turned voice chat off.';
    } else if (voice.joining) {
      status.textContent = 'Connecting to voice chat…';
    } else if (!voice.joined) {
      status.textContent = voice.error ? `Not in voice chat: ${errorText(voice.error)}` : 'Not in voice chat.';
    } else {
      const { connected, total } = voice.linked;
      status.textContent =
        total === 0 ? 'In voice chat. Nobody else is here yet.' : connected === total ? `Talking with ${total === 1 ? '1 player' : `all ${total} players`}.` : `Connected to ${connected} of ${total}… fixing the rest.`;
    }
    status.classList.toggle('warn', voice.enabled && voice.joined && voice.linked.connected < voice.linked.total);

    actions.innerHTML = '';
    if (voice.enabled) {
      button(`${ICONS.rejoin} Rejoin voice`, 'btn-ghost', async () => {
        const err = await voice.rejoin();
        if (err) toast(errorText(err), 'error');
        else toast('Rejoined voice chat');
      });
    }
    if (host && lobbyId) {
      if (voice.enabled) {
        button(`${ICONS.rejoin} Restart for everyone`, 'btn-ghost', async () => {
          if (!(await confirmDialog('Restart voice chat?', "Everyone's voice connection is rebuilt from scratch. Use this when some players can't hear others.", 'Restart'))) return;
          const err = await voice.reboot(lobbyId);
          if (err) toast(errorText(err), 'error');
        });
      }
      button(voice.enabled ? `${ICONS.headsetOff} Turn off` : `${ICONS.headset} Turn on`, voice.enabled ? 'btn-ghost danger-text' : 'btn-primary', async () => {
        const err = await voice.setEnabled(lobbyId, !voice.enabled);
        if (err) toast(errorText(err), 'error');
      });
    }
    actions.hidden = actions.childElementCount === 0;
    quality.el.hidden = !voice.enabled;
    quality.refresh();
  };
  // Keeps itself up to date while on screen; unhooks once its screen or menu is gone.
  let shown = false;
  const tick = () => {
    if (!root.isConnected) return shown && destroy();
    shown = true;
    refresh();
  };
  const offVoice = voice.onChange(tick);
  const offStore = subscribe((changed) => (changed.includes('voice') || changed.includes('lobby')) && tick());
  const destroy = () => {
    offVoice();
    offStore();
  };
  refresh();
  return { el: root, destroy };
}

/** The lobby-wide voice quality picker (16–64 kbps); only the host can change it. */
export function qualityPicker(): { el: HTMLElement; refresh: () => void } {
  const root = el(`
    <div class="voice-quality">
      <div class="menu-heading small">Voice quality <span class="muted">· applies to everyone</span></div>
      <div class="segmented" role="radiogroup" aria-label="Voice quality">
        ${VOICE_BITRATES.map((k) => `<button role="radio" data-kbps="${k}">${k}<small>kbps</small></button>`).join('')}
      </div>
      <p class="muted small"></p>
    </div>`);
  const note = root.querySelector<HTMLElement>('p')!;
  const refresh = () => {
    const current = state.voice?.bitrateKbps ?? voice.bitrateKbps;
    const host = isHost();
    note.textContent = host ? 'Lower uses less mobile data; higher sounds clearer.' : 'Only the host can change this.';
    root.classList.toggle('locked', !host);
    root.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
      const on = Number(b.dataset.kbps) === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !host;
    });
  };
  root.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => {
    b.onclick = async () => {
      if (!state.lobby || !isHost()) return;
      const kbps = Number(b.dataset.kbps);
      const err = await voice.setBitrate(state.lobby.id, kbps);
      if (err) return toast(errorText(err), 'error');
      toast(`Voice quality: ${kbps} kbps`);
    };
  });
  refresh();
  return { el: root, refresh };
}
