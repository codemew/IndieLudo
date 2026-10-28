import { VOICE_BITRATES } from '../shared/types.js';
import { play } from './sound.js';
import { state, subscribe } from './store.js';
import { ICONS, confirmDialog, el, errorText, esc, setHtml, toast } from './ui.js';
import { voice, type LinkReport } from './voice.js';

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
  const details = linkDetails();
  root.appendChild(details.el);
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
      const viaServer = voice.relayedCount ? ` (${voice.relayedCount} through the game server)` : '';
      status.textContent =
        total === 0
          ? 'In voice chat. Nobody else is here yet.'
          : connected === total
            ? `Talking with ${total === 1 ? '1 player' : total === 2 ? 'both players' : `all ${total} players`}${viaServer}.`
            : `Connected to ${connected} of ${total}${viaServer}… fixing the rest.`;
    }
    status.classList.toggle('warn', voice.enabled && voice.joined && voice.linked.connected < voice.linked.total);

    // Rebuild the buttons only when they change, so a button isn't swapped out mid-tap.
    const key = `${voice.enabled}|${host}|${lobbyId}`;
    if (key !== shownKey) {
      shownKey = key;
      buildActions(host, lobbyId);
    }
    quality.el.hidden = !voice.enabled;
    quality.refresh();
  };

  let shownKey = '';
  const buildActions = (host: boolean, lobbyId: string | undefined) => {
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
    details.stop();
  };
  refresh();
  return { el: root, destroy };
}

/** The lobby-wide voice quality picker (6–48 kbps); only the host can change it. */
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

const nameOf = (userId: number) => state.lobby?.members.find((m) => m.userId === userId)?.username ?? `player ${userId}`;
const routeText = (r: LinkReport['mine']) => {
  const kinds = [r.host && `${r.host} local${r.mdns ? ` (${r.mdns} hidden)` : ''}`, r.srflx && `${r.srflx} internet`, r.relay && `${r.relay} relay`].filter(Boolean).join(', ');
  const fam = [r.v4 && `IPv4 ${r.v4}`, r.v6 && `IPv6 ${r.v6}`].filter(Boolean).join(' · ');
  return kinds ? `${kinds}${fam ? ` [${fam}]` : ''}` : 'none';
};

/** What a link's state most likely means, in plain words. */
function explain(l: LinkReport): string {
  if (l.relay.heard || l.relay.sending) {
    return `Going through the game server${l.relay.heard ? '' : ' (waiting for their audio)'}: a direct link isn't possible between these two phones, so voice takes the same route as the game, with a little extra delay.`;
  }
  if (l.status === 'connected') {
    const how = l.via?.includes('relay') ? 'through a relay' : l.via?.includes('srflx') ? 'over the internet' : 'on the local network';
    return `Connected ${how}.`;
  }
  const theirs = l.theirs.host + l.theirs.srflx + l.theirs.relay;
  const mine = l.mine.host + l.mine.srflx + l.mine.relay;
  if (!l.gotReply) return l.role === 'dial' ? "Their phone hasn't answered our call yet." : 'Waiting for their phone to call us.';
  if (theirs === 0) return 'Their phone replied but listed no way to reach it: something on that phone (a VPN, data saver, or a very strict network) is blocking voice chat.';
  if (mine === 0) return 'This phone found no way to be reached: something here (a VPN, data saver, or a very strict network) is blocking voice chat.';
  // One side reachable only over IPv6, the other only over IPv4 (typical: Jio cellular vs. an IPv4-only Wi-Fi).
  const onlyV6 = (r: LinkReport['mine']) => r.v6 > 0 && r.v4 === 0;
  const onlyV4 = (r: LinkReport['mine']) => r.v4 > 0 && r.v6 === 0;
  if (!l.mine.relay && !l.theirs.relay && ((onlyV6(l.mine) && onlyV4(l.theirs)) || (onlyV4(l.mine) && onlyV6(l.theirs))))
    return `No common route: ${onlyV6(l.mine) ? 'this phone' : 'their phone'} can only be reached over IPv6 (typical on mobile data like Jio) and the other only over IPv4. A direct link is impossible; only a relay can carry this audio.`;
  if (!l.mine.srflx && !l.theirs.srflx && !l.mine.relay && !l.theirs.relay)
    return 'Only local-network routes on both sides. This only works on the same Wi-Fi, and not if the Wi-Fi blocks phones from reaching each other (guest networks, "client isolation").';
  return 'Both phones offered routes but none got through: the network is blocking a direct link between these two phones. A relay (TURN server) would carry this audio.';
}

/** The "Details" toggle: each voice link's state, routes and a likely explanation, plus a copyable report. */
function linkDetails(): { el: HTMLElement; stop: () => void } {
  const root = el(`
    <div class="voice-details">
      <div class="menu-row"><button class="btn btn-small btn-ghost" data-act="toggle">Details</button><button class="btn btn-small btn-ghost" data-act="copy" hidden>Copy report</button></div>
      <div class="vd-body" hidden></div>
    </div>`);
  const body = root.querySelector<HTMLElement>('.vd-body')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-act=toggle]')!;
  const copy = root.querySelector<HTMLButtonElement>('[data-act=copy]')!;
  let timer: ReturnType<typeof setInterval> | null = null;
  const paint = async () => {
    if (!root.isConnected) return stop();
    const r = await voice.report();
    const rows = r.links
      .map(
        (l) => `
        <li class="vd-link vd-${l.relay.heard ? 'connected' : l.status}">
          <div><b>${esc(nameOf(l.userId))}</b> · ${l.relay.heard ? 'via the game server' : `${l.status}${l.status === 'connected' ? '' : ` for ${l.forSec}s`}`} · ${l.role === 'dial' ? 'we call them' : 'they call us'}</div>
          <span>You: ${routeText(l.mine)} · Them: ${routeText(l.theirs)}${l.via ? ` · via ${l.via}` : ''} · ICE ${esc(l.ice)}${l.late.sent || l.late.got ? ` · late routes ↑${l.late.sent} ↓${l.late.got}` : ''}${l.relay.sending || l.relay.framesIn ? ` · via server ↑${l.relay.sending ? 'on' : 'off'} ↓${l.relay.framesIn} frames` : ''}</span>
          <em>${explain(l)}</em>
        </li>`,
      )
      .join('');
    setHtml(
      body,
      `<p class="muted small">Microphone: ${r.mic ? 'on' : 'blocked'} · STUN/TURN servers: ${r.iceServers}${r.signalError ? ` · last signalling error: ${esc(r.signalError)}` : ''}</p>` +
        (rows ? `<ul class="vd-links">${rows}</ul>` : '<p class="muted small">Nobody else is in voice chat.</p>'),
    );
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  toggle.onclick = () => {
    const open = body.hidden;
    body.hidden = !open;
    copy.hidden = !open;
    toggle.textContent = open ? 'Hide details' : 'Details';
    stop();
    if (open) {
      void paint();
      timer = setInterval(() => void paint(), 2000);
    }
  };
  copy.onclick = async () => {
    const r = await voice.report();
    const text = JSON.stringify({ app: __APP_VERSION__, ua: navigator.userAgent, ...r, names: Object.fromEntries(r.links.map((l) => [l.userId, nameOf(l.userId)])) }, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      toast('Voice report copied', 'success');
    } catch {
      toast("Couldn't copy here. Take a screenshot of the details instead.", 'error');
    }
  };
  return { el: root, stop };
}
