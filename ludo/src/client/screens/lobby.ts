import type { Color, LobbyMember } from '../../shared/types.js';
import { showError } from '../app.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { play } from '../sound.js';
import { state, subscribe } from '../store.js';
import { $, COLOR_NAME, confirmDialog, el, esc } from '../ui.js';
import { voice } from '../voice.js';
import { pingText, signalBars } from '../netUi.js';
import { bindMuteButton, voiceBadge, voicePanel } from '../voiceUi.js';

/** Seats laid out like the board: red top-left, green top-right, blue bottom-left, yellow bottom-right. */
const SEAT_ORDER: Color[] = ['red', 'green', 'blue', 'yellow'];

export function lobbyScreen(root: HTMLElement): () => void {
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Leave lobby">‹</button>
      <div class="topbar-title">
        <div class="eyebrow">Lobby</div>
        <div class="lobby-name" id="lobby-name"></div>
      </div>
      <button class="icon-btn" id="mute" aria-label="Mute myself"></button>
    </header>
    <section class="lobby-body">
      <p class="muted center" id="lobby-hint"></p>
      <div class="seat-grid" id="seats"></div>
      <div class="lobby-voice" id="lobby-voice">
        <div class="menu-heading">🎙 Voice chat</div>
        <p class="muted small">Everyone in the lobby is in it, during matches too. Use the mic button to mute yourself. Can't hear someone? Tap Rejoin.</p>
      </div>
    </section>
    <footer class="bottom-bar" id="actions"></footer>`;

  $(root, '#back').onclick = async () => {
    if (await confirmDialog('Leave lobby?', 'You can join again if there is a free seat.', 'Leave', true)) {
      go('home');
      const r = await emit('lobby:leave', {});
      if (!r.ok) showError(r.error);
    }
  };

  const act = async (event: Parameters<typeof emit>[0], payload: object = {}) => {
    play('tap');
    const r = await emit(event, payload);
    if (!r.ok) showError(r.error);
  };

  const render = () => {
    const lobby = state.lobby;
    if (!lobby) return;
    if (lobby.status === 'playing') {
      // game:state follows right after and opens the board; only jump now if we already have it.
      if (state.game?.id === lobby.gameId) go('game');
      return;
    }
    const me = state.user!.id;
    const isHost = lobby.hostId === me;
    const mine = lobby.members.find((m) => m.userId === me);
    $(root, '#lobby-name').textContent = lobby.name;
    $(root, '#lobby-hint').textContent = isHost ? 'Tap an open seat to switch colour or add a bot.' : 'Tap an open seat to switch colour.';

    const seats = $(root, '#seats');
    seats.innerHTML = '';
    for (const color of SEAT_ORDER) {
      const m = lobby.members.find((x) => x.color === color);
      seats.appendChild(seatCard(color, m, { me, isHost, hostId: lobby.hostId, act }));
    }
    paintLive();
    // Cards animate in on the first paint only, not every time the lobby changes.
    requestAnimationFrame(() => root.classList.add('settled'));

    const actions = $(root, '#actions');
    actions.innerHTML = '';
    if (isHost) {
      const notReady = lobby.members.filter((m) => !m.isBot && m.userId !== me && !m.ready).length;
      const enough = lobby.members.length >= 2;
      const btn = el<HTMLButtonElement>(`<button class="btn btn-primary btn-xl">Start game</button>`);
      btn.disabled = !enough || notReady > 0;
      btn.onclick = () => act('lobby:start');
      actions.appendChild(el(`<p class="action-hint">${!enough ? 'Need at least 2 players — add a bot?' : notReady ? `Waiting for ${notReady} player${notReady > 1 ? 's' : ''} to get ready` : 'Everyone is ready!'}</p>`));
      actions.appendChild(btn);
    } else if (mine) {
      const btn = el<HTMLButtonElement>(`<button class="btn btn-xl ${mine.ready ? 'btn-ghost' : 'btn-primary'}">${mine.ready ? 'Not ready' : "I'm ready"}</button>`);
      btn.onclick = () => act('lobby:ready', { ready: !mine.ready });
      actions.appendChild(el(`<p class="action-hint">${mine.ready ? 'Waiting for the host to start…' : 'Tap ready when you are set'}</p>`));
      actions.appendChild(btn);
    }
  };

  /**
   * Ping, signal bars and mic badges change every few seconds. Update just those spans in place:
   * rebuilding the cards would replay their entrance animation (a visible flicker) and could
   * swallow a tap on a button that gets replaced mid-press.
   */
  const paintLive = () => {
    root.querySelectorAll<HTMLElement>('.seat[data-user]').forEach((card) => {
      const userId = Number(card.dataset.user);
      const vc = card.querySelector('.seat-vc');
      const net = card.querySelector('.seat-net');
      const vcHtml = voiceBadge(userId);
      const netHtml = `${signalBars(userId)}${pingText(userId)}`;
      if (vc && vc.innerHTML !== vcHtml) vc.innerHTML = vcHtml;
      if (net && net.innerHTML !== netHtml) net.innerHTML = netHtml;
    });
  };

  render();
  const offMute = bindMuteButton($<HTMLButtonElement>(root, '#mute'));
  const panel = voicePanel();
  $(root, '#lobby-voice').appendChild(panel.el);
  const offStore = subscribe((changed) => {
    if (changed.includes('lobby')) render();
    else if (changed.includes('voice') || changed.includes('net')) paintLive();
  });
  // Peer connection changes only affect the "connecting" pulse on the badges.
  const offVoice = voice.onChange(paintLive);
  return () => {
    offMute();
    offStore();
    offVoice();
    panel.destroy();
  };
}

function seatCard(
  color: Color,
  m: LobbyMember | undefined,
  ctx: { me: number; isHost: boolean; hostId: number; act: (e: any, p?: object) => Promise<void> },
): HTMLElement {
  if (!m) {
    const card = el(`
      <div class="seat seat-open s-${color}">
        <div class="seat-token"></div>
        <div class="seat-name">${COLOR_NAME[color]} · open</div>
        <div class="seat-actions"></div>
      </div>`);
    const actions = $(card, '.seat-actions');
    const sit = el<HTMLButtonElement>(`<button class="chip">Sit here</button>`);
    sit.onclick = () => ctx.act('lobby:color', { color });
    actions.appendChild(sit);
    if (ctx.isHost) {
      const bot = el<HTMLButtonElement>(`<button class="chip">＋ Bot</button>`);
      bot.onclick = () => ctx.act('lobby:addBot');
      actions.appendChild(bot);
    }
    return card;
  }
  const isMe = m.userId === ctx.me;
  const card = el(`
    <div class="seat s-${color} ${isMe ? 'seat-me' : ''} ${m.connected ? '' : 'seat-offline'}"${m.isBot || m.userId === null ? '' : ` data-user="${m.userId}"`}>
      <div class="seat-token">${m.isBot ? '🤖' : esc(m.username[0]?.toUpperCase() ?? '')}</div>
      <div class="seat-name">${esc(m.username)}${isMe ? ' <span class="you">you</span>' : ''}${m.isBot ? '' : ` <span class="seat-wins" title="${m.wins ?? 0} win${m.wins === 1 ? '' : 's'}">🏆 ${m.wins ?? 0}</span>`}<span class="seat-vc"></span></div>
      ${m.isBot ? '' : `<div class="seat-net"></div>`}
      <div class="seat-tags">
        ${m.userId === ctx.hostId ? '<span class="tag">👑 host</span>' : ''}
        ${m.isBot ? '<span class="tag">bot</span>' : m.userId === ctx.hostId ? '' : m.ready ? '<span class="tag tag-ok">✓ ready</span>' : '<span class="tag">not ready</span>'}
        ${!m.isBot && !m.connected ? '<span class="tag tag-warn">offline</span>' : ''}
      </div>
      <div class="seat-actions"></div>
    </div>`);
  if (ctx.isHost && !isMe) {
    const b = el<HTMLButtonElement>(`<button class="chip chip-danger">${m.isBot ? 'Remove' : 'Kick'}</button>`);
    b.onclick = async () => {
      if (m.isBot) return ctx.act('lobby:removeBot', { color });
      if (await confirmDialog(`Kick ${m.username}?`, 'They can rejoin with the password.', 'Kick', true)) await ctx.act('lobby:kick', { userId: m.userId });
    };
    $(card, '.seat-actions').appendChild(b);
  }
  return card;
}

