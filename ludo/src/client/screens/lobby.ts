import { BOARD_SIZES, type BoardSize } from '../../shared/board.js';
import { MAX_SPECTATORS, TEAMMATE, type Color, type LobbyMember, type PublicLobby } from '../../shared/types.js';
import { showError } from '../app.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { play } from '../sound.js';
import { state, subscribe } from '../store.js';
import { $, COLOR_NAME, confirmDialog, el, esc } from '../ui.js';
import { voice } from '../voice.js';
import { pingText, signalBars } from '../netUi.js';
import { askSwap, cancelSwap } from '../swapUi.js';
import { bindMuteButton, voiceBadge, voicePanel } from '../voiceUi.js';

/**
 * Seats laid out like the board. 4 players: red top-left, green top-right, blue bottom-left,
 * yellow bottom-right. 5 and 6: clockwise round the board, two to a row.
 */
const SEAT_ORDER: Record<BoardSize, Color[]> = {
  4: ['red', 'green', 'blue', 'yellow'],
  5: ['red', 'green', 'yellow', 'blue', 'purple'],
  6: ['red', 'green', 'yellow', 'blue', 'orange', 'purple'],
};

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
      <div class="mode-switch" id="mode" role="radiogroup" aria-label="Game mode">
        <button class="mode-opt" data-teams="0" role="radio">🎲 Classic</button>
        <button class="mode-opt" data-teams="1" role="radio">🤝 Team-up</button>
      </div>
      <div class="mode-switch size-switch" id="size" role="radiogroup" aria-label="Players">
        ${BOARD_SIZES.map((n) => `<button class="mode-opt size-opt" data-size="${n}" role="radio">${n} players</button>`).join('')}
      </div>
      <p class="muted small center mode-note" id="mode-note"></p>
      <div class="seat-grid" id="seats"></div>
      <div class="watchers" id="watchers"></div>
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

  root.querySelectorAll<HTMLButtonElement>('#mode .mode-opt').forEach((b) => (b.onclick = () => void act('lobby:mode', { teams: b.dataset.teams === '1' })));
  root.querySelectorAll<HTMLButtonElement>('.size-opt').forEach((b) => (b.onclick = () => void act('lobby:size', { size: Number(b.dataset.size) })));

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
    const watching = !mine;
    $(root, '#lobby-name').textContent = lobby.name;
    $(root, '#lobby-hint').textContent = watching
      ? 'You are watching. Tap Sit here on an open seat to play.'
      : isHost
        ? 'Tap an open seat to move or add a bot, or ⇄ to swap colours with a player.'
        : 'Tap an open seat to move, or ⇄ to swap colours with a player.';

    // Classic or Team-up, and 4, 5 or 6 players: the host picks; everyone sees which.
    const size = lobby.size ?? 4;
    root.querySelectorAll<HTMLButtonElement>('#mode .mode-opt').forEach((b) => {
      const on = (b.dataset.teams === '1') === lobby.teams;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      // Team-up is 2 vs 2, so only on the 4-player board.
      b.disabled = !isHost || (b.dataset.teams === '1' && size !== 4);
    });
    root.querySelectorAll<HTMLButtonElement>('.size-opt').forEach((b) => {
      const n = Number(b.dataset.size);
      const on = n === size;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !isHost || (!on && lobby.members.length > n);
    });
    $(root, '#mode-note').textContent = lobby.teams
      ? 'Team-up: 2 vs 2. Diagonal partners (Red + Yellow vs Green + Blue) win together when both are home. Needs all 4 seats.'
      : size === 4
        ? 'Classic: everyone for themselves.'
        : `Classic on the ${size}-player board: everyone for themselves. Team-up is for 4 players.`;

    const seats = $(root, '#seats');
    seats.innerHTML = '';
    seats.classList.toggle('seats-many', size > 4);
    for (const color of SEAT_ORDER[size]) {
      const m = lobby.members.find((x) => x.color === color);
      seats.appendChild(seatCard(color, m, { me, isHost, watching, hostId: lobby.hostId, act, teams: lobby.teams, myColor: mine?.color }));
    }
    renderWatchers($(root, '#watchers'), lobby, { me, isHost, act });
    paintLive();
    // Cards animate in on the first paint only, not every time the lobby changes.
    requestAnimationFrame(() => root.classList.add('settled'));

    const actions = $(root, '#actions');
    actions.innerHTML = '';
    const free = size - lobby.members.length;
    const extras = el(`<div class="lobby-extras"></div>`);
    if (mine && lobby.spectators.length < MAX_SPECTATORS) {
      const b = el<HTMLButtonElement>(`<button class="chip" id="spectate">👀 Watch instead</button>`);
      b.onclick = () => act('lobby:spectate');
      extras.appendChild(b);
    }
    if (isHost && free > 0) {
      const b = el<HTMLButtonElement>(`<button class="chip" id="fill-bots">🤖 Fill open seats with bots</button>`);
      b.onclick = () => act('lobby:fillBots');
      extras.appendChild(b);
    }
    if (extras.childElementCount) actions.appendChild(extras);
    if (isHost) {
      const notReady = lobby.members.filter((m) => !m.isBot && m.userId !== me && !m.ready).length;
      const enough = lobby.teams ? lobby.members.length === 4 : lobby.members.length >= 2;
      const botBattle = enough && lobby.members.every((m) => m.isBot);
      const btn = el<HTMLButtonElement>(`<button class="btn btn-primary btn-xl" id="start">${botBattle ? '🤖 Start bot battle' : 'Start game'}</button>`);
      btn.disabled = !enough || notReady > 0;
      btn.onclick = () => act('lobby:start');
      const hint = !enough
        ? lobby.teams
          ? 'Team-up needs all 4 seats: fill the open ones with bots?'
          : `Need at least 2 ${watching ? 'bots or players' : 'players'} — add a bot?`
        : notReady
          ? `Waiting for ${notReady} player${notReady > 1 ? 's' : ''} to get ready`
          : botBattle
            ? 'Only bots playing: they battle at full speed while you watch.'
            : 'Everyone is ready!';
      actions.appendChild(el(`<p class="action-hint">${hint}</p>`));
      actions.appendChild(btn);
    } else if (watching) {
      actions.appendChild(el(`<p class="action-hint">👀 Watching · the next game starts when the host is ready</p>`));
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
    root.querySelectorAll<HTMLElement>('.seat[data-user], .watcher[data-user]').forEach((card) => {
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
    if (changed.includes('lobby') || changed.includes('swapOut')) render();
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
  ctx: { me: number; isHost: boolean; watching: boolean; hostId: number; act: (e: any, p?: object) => Promise<void>; teams: boolean; myColor?: Color },
): HTMLElement {
  if (!m) {
    const card = el(`
      <div class="seat seat-open s-${color}">
        <div class="seat-token"></div>
        <div class="seat-name">${COLOR_NAME[color]} · open</div>
        ${ctx.teams ? `<div class="seat-tags">${teamTag(color)}</div>` : ''}
        <div class="seat-actions"></div>
      </div>`);
    const actions = $(card, '.seat-actions');
    const sit = el<HTMLButtonElement>(`<button class="chip">Sit here</button>`);
    // From a seat that's a move; from the side it's sitting down.
    sit.onclick = () => ctx.act(ctx.watching ? 'lobby:sit' : 'lobby:color', { color });
    actions.appendChild(sit);
    if (ctx.isHost) {
      // In Team-up the host sees whether a bot here plays with them or against them.
      const label = ctx.teams && ctx.myColor ? (TEAMMATE[ctx.myColor] === color ? '＋ Bot teammate' : '＋ Bot opponent') : '＋ Bot';
      const bot = el<HTMLButtonElement>(`<button class="chip">${label}</button>`);
      bot.onclick = () => ctx.act('lobby:addBot', { color });
      actions.appendChild(bot);
    }
    return card;
  }
  const isMe = m.userId === ctx.me;
  const card = el(`
    <div class="seat s-${color} ${isMe ? 'seat-me' : ''} ${m.connected ? '' : 'seat-offline'}"${m.isBot || m.userId === null ? '' : ` data-user="${m.userId}"`}>
      <div class="seat-token"${m.isBot || m.userId === null ? '' : ` data-talk="${m.userId}"`}>${m.isBot ? '🤖' : esc(m.username[0]?.toUpperCase() ?? '')}</div>
      <div class="seat-name">${esc(m.username)}${isMe ? ' <span class="you">you</span>' : ''}${m.isBot ? '' : ` <span class="seat-wins" title="${m.wins ?? 0} win${m.wins === 1 ? '' : 's'}">🏆 ${m.wins ?? 0}</span>`}<span class="seat-vc"></span></div>
      ${m.isBot ? '' : `<div class="seat-net"></div>`}
      <div class="seat-tags">
        ${ctx.teams ? teamTag(color) : ''}
        ${m.userId === ctx.hostId ? '<span class="tag">👑 host</span>' : ''}
        ${m.isBot ? '<span class="tag">bot</span>' : m.userId === ctx.hostId ? '' : m.ready ? '<span class="tag tag-ok">✓ ready</span>' : '<span class="tag">not ready</span>'}
        ${!m.isBot && !m.connected ? '<span class="tag tag-warn">offline</span>' : ''}
      </div>
      <div class="seat-actions"></div>
    </div>`);
  if (!isMe && !ctx.watching) {
    // Swap colours: a bot swaps at once; a player is asked.
    const asked = state.swapOut?.to === m.userId && m.userId !== null;
    const swap = el<HTMLButtonElement>(`<button class="chip${asked ? ' chip-wait' : ''}">${asked ? 'Asked · Cancel' : '⇄ Swap'}</button>`);
    swap.onclick = () => void (asked ? cancelSwap() : askSwap(color, m.userId));
    $(card, '.seat-actions').appendChild(swap);
  }
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

/** Team-up: which pair this seat plays in, with both colours. */
function teamTag(color: Color): string {
  const [a, b] = color === 'red' || color === 'yellow' ? (['red', 'yellow'] as const) : (['green', 'blue'] as const);
  return `<span class="tag team-tag"><i class="team-dot d-${a}"></i><i class="team-dot d-${b}"></i>${COLOR_NAME[a]} + ${COLOR_NAME[b]}</span>`;
}

/** The people watching without a seat, with their mic badge and signal like the seats have. */
function renderWatchers(box: HTMLElement, lobby: PublicLobby, ctx: { me: number; isHost: boolean; act: (e: any, p?: object) => Promise<void> }): void {
  box.innerHTML = '';
  if (!lobby.spectators.length) return;
  box.appendChild(el(`<div class="menu-heading">👀 Watching (${lobby.spectators.length}/${MAX_SPECTATORS})</div>`));
  for (const s of lobby.spectators) {
    const isMe = s.userId === ctx.me;
    const row = el(`
      <div class="watcher ${isMe ? 'watcher-me' : ''} ${s.connected ? '' : 'seat-offline'}" data-user="${s.userId}">
        <span class="watcher-dot" data-talk="${s.userId}">${esc(s.username[0]?.toUpperCase() ?? '')}</span>
        <span class="watcher-name">${esc(s.username)}${isMe ? ' <span class="you">you</span>' : ''}${s.userId === lobby.hostId ? ' <span class="tag">👑 host</span>' : ''}<span class="seat-vc"></span></span>
        <span class="seat-net"></span>
      </div>`);
    if (ctx.isHost && !isMe) {
      const b = el<HTMLButtonElement>(`<button class="chip chip-danger">Kick</button>`);
      b.onclick = async () => {
        if (await confirmDialog(`Kick ${s.username}?`, 'They can rejoin with the password.', 'Kick', true)) await ctx.act('lobby:kick', { userId: s.userId });
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}
