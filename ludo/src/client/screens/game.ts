import { BASE, HOME, pathCells, tokenCell } from '../../shared/board.js';
import type { GameUpdate } from '../../shared/protocol.js';
import {
  MAX_MISSED_TURNS,
  VOICE_BITRATES,
  type Color,
  type GameEvent,
  type GameState,
  type LegalMove,
  type PublicGameState,
  type Seat,
  type VoiceState,
} from '../../shared/types.js';
import { setGameHandler, showError } from '../app.js';
import { hop, sleep, slide } from '../board/animate.js';
import { TokenLayer, boardSvg } from '../board/render.js';
import { Dice, dieChip } from '../dice.js';
import { bindFullscreenButton, canFullscreen, enterFullscreen, isFullscreen } from '../fullscreen.js';
import { vibrate } from '../haptics.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { isMuted, play, setMuted } from '../sound.js';
import { state, subscribe, update } from '../store.js';
import { uuid } from '../storage.js';
import { $, COLOR_NAME, ICONS, confirmDialog, el, esc, modal, toast } from '../ui.js';
import { voice } from '../voice.js';

/** Corner order around the board, matching each colour's base. */
const TOP: Color[] = ['red', 'green'];
const BOTTOM: Color[] = ['blue', 'yellow'];
const MEDALS = ['🥇', '🥈', '🥉', '4th'];
const SILENT_ERRORS = new Set(['STALE_VERSION', 'NOT_YOUR_TURN', 'WRONG_PHASE']);

export function gameScreen(root: HTMLElement): () => void {
  let gs: PublicGameState | null = state.game;
  if (!gs) {
    queueMicrotask(() => go('home'));
    return () => {};
  }
  const myId = state.user?.id;
  let clockOffset = gs.serverNow - Date.now();
  let awaitingAck = false;
  let animating = false;
  let destroyed = false;
  let selectedDie: number | null = null;
  const pending: GameUpdate[] = [];

  root.innerHTML = `
    <header class="game-top">
      <button class="icon-btn" id="menu" aria-label="Menu">☰</button>
      <div class="turn-banner" id="banner"></div>
      <button class="icon-btn voice-btn" id="voice" aria-label="Voice chat"></button>
      <button class="icon-btn" id="fullscreen" aria-label="Fullscreen" hidden></button>
      <button class="icon-btn" id="sound" aria-label="Sound"></button>
    </header>
    <div class="players">${TOP.map((c) => `<div class="pchip" data-color="${c}"></div>`).join('')}</div>
    <div class="board-wrap" id="board-wrap">
      <div class="board" id="board">
        ${boardSvg()}
        <div class="token-layer" id="tokens"></div>
        <div class="fx-layer" id="fx"></div>
      </div>
    </div>
    <div class="players">${BOTTOM.map((c) => `<div class="pchip" data-color="${c}"></div>`).join('')}</div>
    <footer class="dock">
      <div class="dock-left">
        <div class="queue" id="queue"></div>
        <div class="hint" id="hint"></div>
        <button class="btn btn-small btn-primary" id="takeback" hidden>🤖 A bot is playing for you — take back</button>
      </div>
      <div class="dice-slot" id="dice-slot"></div>
    </footer>`;

  const board = $(root, '#board');
  const wrap = $(root, '#board-wrap');
  const fx = $(root, '#fx');
  const dice = new Dice();
  const diceSlot = $(root, '#dice-slot');
  diceSlot.appendChild(dice.el);
  /** The dice only shows while someone still has to roll; spent rolls live in the queue chips. */
  const showDice = (show: boolean) => diceSlot.classList.toggle('dice-hidden', !show);
  const tokens = new TokenLayer($(root, '#tokens'), (color, id) => onTokenTap(color, id));

  // Size the board from its container's content box (never from vh, which jumps with the
  // keyboard). It must stay exactly square: if flex squeezed one side, the SVG would scale to
  // the shorter side and the squares would drift away from the tokens.
  const ro = new ResizeObserver(() => {
    const cs = getComputedStyle(wrap);
    const w = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const size = Math.floor(Math.min(w, h));
    board.style.width = board.style.height = `${size}px`;
  });
  ro.observe(wrap);

  const paintSound = () => ($(root, '#sound').textContent = isMuted() ? '🔇' : '🔊');
  paintSound();
  $(root, '#sound').onclick = () => {
    setMuted(!isMuted());
    paintSound();
  };
  $(root, '#menu').onclick = () => openMenu();
  $(root, '#voice').onclick = () => void onVoiceButton();
  const offFs = bindFullscreenButton($<HTMLButtonElement>(root, '#fullscreen'));
  $(root, '#takeback').onclick = async () => {
    const r = await emit('game:takeback', { gameId: gs!.id });
    if (!r.ok) showError(r.error);
  };
  dice.el.onclick = () => {
    if (canRoll()) void send('game:roll', {});
  };

  // ---------- derived state ----------

  const mySeat = (): Seat | undefined => gs?.seats.find((s) => s.userId === myId);
  const current = (): Seat => gs!.seats[gs!.turn.seat];
  const isMyTurn = () => Boolean(gs && !gs.finished && current().userId === myId && current().controller !== 'bot');
  const canRoll = () => isMyTurn() && gs!.turn.phase === 'rolling' && !awaitingAck && !animating;
  const canMove = () => isMyTurn() && gs!.turn.phase === 'moving' && !awaitingAck && !animating;

  function validSelection(moves: LegalMove[]): number | null {
    if (selectedDie !== null && moves.some((m) => m.dieIndex === selectedDie)) return selectedDie;
    return moves[0]?.dieIndex ?? null;
  }

  // ---------- intents (the only thing the client ever sends) ----------

  async function send(event: 'game:roll' | 'game:move', extra: object): Promise<void> {
    if (awaitingAck || !gs) return;
    awaitingAck = true;
    renderControls();
    const r = await emit(event, { gameId: gs.id, version: gs.version, actionId: uuid(), ...extra });
    awaitingAck = false;
    if (!r.ok && !SILENT_ERRORS.has(r.error)) showError(r.error);
    renderControls();
  }

  function onTokenTap(color: Color, tokenId: number): void {
    if (!canMove() || color !== mySeat()?.color) return;
    const candidates = gs!.legalMoves.filter((m) => m.tokenId === tokenId);
    if (candidates.length === 0) {
      play('error');
      return;
    }
    const sel = validSelection(gs!.legalMoves);
    const values = new Set(candidates.map((m) => m.die));
    const pick = candidates.find((m) => m.dieIndex === sel) ?? (values.size === 1 ? candidates[0] : undefined);
    if (!pick) {
      toast('Pick which die to use first');
      $(root, '#queue').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 300 });
      return;
    }
    play('tap');
    void send('game:move', { dieIndex: pick.dieIndex, tokenId: pick.tokenId });
  }

  // ---------- updates from the server ----------

  function onUpdate(u: GameUpdate): void {
    if (!gs || u.state.id !== gs.id) {
      gs = u.state;
      update({ game: gs });
      renderAll();
      return;
    }
    const newest = pending.at(-1)?.state.version ?? gs.version;
    if (u.state.version < newest) return;
    pending.push(u);
    if (!animating) void drain();
  }

  async function drain(): Promise<void> {
    animating = true;
    renderControls();
    while (pending.length && !destroyed) {
      const u = pending.shift()!;
      const prev = gs!;
      clockOffset = u.state.serverNow - Date.now();
      // Animate only a direct successor; after a gap (reconnect) or a backlog, snap.
      if (u.events?.length && u.state.version === prev.version + 1 && pending.length < 3) {
        await playEvents(structuredClone(prev), u.events);
      }
      gs = u.state;
      update({ game: gs });
      renderAll();
      if (gs.finished) {
        await sleep(1400);
        if (!destroyed) go('results');
        return;
      }
    }
    animating = false;
    renderControls();
  }

  async function playEvents(work: GameState, events: GameEvent[]): Promise<void> {
    const me = mySeat()?.color;
    for (const e of events) {
      if (destroyed) return;
      switch (e.type) {
        case 'roll':
          setDiceColor(e.color);
          showDice(true);
          play('dice');
          if (e.color === me) vibrate(12);
          work.turn.queue = e.queue;
          await dice.roll(e.value);
          renderQueue(work, false);
          // Let the result sit for a moment before the dice steps aside (or resets for a re-roll).
          await sleep(450);
          if (e.value !== 6) showDice(false);
          break;
        case 'penalty':
          dice.shake();
          play('penalty');
          vibrate([60, 40, 60]);
          callout('3 sixes!', 'Turn lost');
          work.turn.queue = [];
          renderQueue(work, false);
          await sleep(1000);
          break;
        case 'move': {
          const el = tokens.get(e.color, e.tokenId);
          if (!el) break;
          const start = tokenCell(e.color, e.from, e.tokenId);
          const path = pathCells(e.color, e.from, e.to, e.tokenId);
          const idx = work.turn.queue.indexOf(e.die);
          if (idx >= 0) work.turn.queue.splice(idx, 1);
          renderQueue(work, false);
          await hop(el, start, path, e.from === BASE ? 260 : 150, () => play('step'));
          work.tokens[e.color][e.tokenId] = e.to;
          tokens.sync(work, new Set(), null);
          break;
        }
        case 'capture': {
          const el = tokens.get(e.victim, e.tokenId);
          if (!el) break;
          const from = tokenCell(e.victim, e.from, e.tokenId);
          play('capture');
          vibrate([30, 50, 30]);
          burst(from, e.color);
          await slide(el, from, tokenCell(e.victim, BASE, e.tokenId), 560);
          work.tokens[e.victim][e.tokenId] = BASE;
          tokens.sync(work, new Set(), null);
          break;
        }
        case 'home':
          play('home');
          burst(tokenCell(e.color, HOME, e.tokenId), e.color);
          break;
        case 'rank':
          toast(`${seatName(e.color)} finished ${MEDALS[e.rank - 1]}`, 'success');
          break;
        case 'noMoves':
          if (e.color === me) toast('No moves possible');
          await sleep(650);
          break;
        case 'bonus':
          play('bonus');
          callout('Bonus roll!', 'roll again');
          await sleep(500);
          break;
        case 'turn':
          if (e.color === me) {
            play('turn');
            vibrate(35);
          }
          break;
        case 'gameOver':
          play(e.ranks[0] === me ? 'win' : 'home');
          break;
      }
    }
  }

  // ---------- rendering ----------

  function seatName(color: Color): string {
    return gs?.seats.find((s) => s.color === color)?.username ?? COLOR_NAME[color];
  }

  function setDiceColor(color: Color): void {
    dice.el.dataset.color = color;
  }

  function renderAll(): void {
    if (!gs) return;
    renderChips();
    renderControls(true);
    if (gs.turn.phase === 'rolling') dice.idle();
  }

  function renderChips(): void {
    for (const chip of root.querySelectorAll<HTMLElement>('.pchip')) {
      const color = chip.dataset.color as Color;
      const seat = gs!.seats.find((s) => s.color === color);
      if (!seat) {
        chip.className = 'pchip pchip-empty';
        chip.innerHTML = '';
        continue;
      }
      const rank = gs!.ranks.indexOf(color);
      const active = !gs!.finished && current().color === color;
      const homeCount = gs!.tokens[color].filter((p) => p === HOME).length;
      const timed = active && gs!.turn.deadline > 0;
      chip.className = `pchip p-${color}${active ? ' active' : ''}${timed ? ' timed' : ''}${seat.connected ? '' : ' offline'}`;
      chip.innerHTML = `
        <span class="pchip-dot">${seat.controller !== 'human' ? '🤖' : esc(seat.username[0]?.toUpperCase() ?? '')}</span>
        <span class="pchip-text">
          <span class="pchip-name">${esc(seat.username)}${seat.userId === myId ? ' <em>you</em>' : ''}${voiceBadge(seat)}</span>
          <span class="pchip-sub">${chipStatus(seat, rank, homeCount)}</span>
        </span>
        <span class="pchip-timer"><i></i></span>`;
      if (timed) {
        const total = Math.max(1, (gs!.turn.deadline - gs!.serverNow) || 1);
        const remaining = Math.max(0, gs!.turn.deadline - (Date.now() + clockOffset));
        const bar = chip.querySelector<HTMLElement>('.pchip-timer i')!;
        bar.animate([{ transform: `scaleX(${Math.min(1, remaining / total)})` }, { transform: 'scaleX(0)' }], { duration: remaining, fill: 'forwards' });
      }
    }
  }

  // ---------- voice chat ----------

  /** Mic badge beside a player's name: in voice (on / muted), and still connecting to us. */
  function voiceBadge(seat: Seat): string {
    const p = seat.userId === null ? undefined : state.voice?.participants.find((x) => x.userId === seat.userId);
    if (!p) return '';
    const connecting = voice.joined && seat.userId !== myId && voice.peerStatus(seat.userId!) !== 'connected';
    const label = `${p.muted ? 'muted' : 'in voice chat'}${connecting ? ', connecting' : ''}`;
    return ` <span class="vc ${p.muted ? 'vc-muted' : 'vc-on'}${connecting ? ' vc-connecting' : ''}" title="${label}" aria-label="${label}">${p.muted ? ICONS.micOff : ICONS.mic}</span>`;
  }

  function paintVoiceButton(): void {
    const b = $<HTMLButtonElement>(root, '#voice');
    b.hidden = !mySeat() || gs!.finished;
    b.classList.toggle('vb-on', voice.joined && !voice.muted);
    b.classList.toggle('vb-muted', voice.joined && voice.muted);
    b.disabled = voice.joining;
    if (voice.joining) b.innerHTML = '<span class="spinner"></span>';
    else b.innerHTML = !voice.joined ? ICONS.headset : voice.muted ? ICONS.micOff : ICONS.mic;
    b.setAttribute('aria-label', !voice.joined ? 'Join voice chat' : voice.muted ? 'Unmute microphone' : 'Mute microphone');
  }

  /** Top-bar button: join the channel, then toggles your own mute. */
  async function onVoiceButton(): Promise<void> {
    if (!voice.joined) return joinVoice();
    await voice.setMuted(!voice.muted);
    play('tap');
  }

  async function joinVoice(): Promise<void> {
    const err = await voice.join(gs!.id, myId!);
    if (err) showError(err);
    else toast(voice.muted ? 'Joined voice chat (muted)' : 'Joined voice chat', 'success');
  }

  function voiceMenu(body: HTMLElement, close: () => void): void {
    const v: VoiceState | null = state.voice;
    const section = el(`
      <div class="menu-section">
        <div class="menu-heading">Voice chat</div>
        <div class="menu-row" id="vm-actions"></div>
        <div class="menu-heading small">Voice quality <span class="muted">· applies to everyone</span></div>
        <div class="segmented" role="radiogroup" aria-label="Voice quality">
          ${VOICE_BITRATES.map((k) => `<button role="radio" data-kbps="${k}" class="${k === (v?.bitrateKbps ?? voice.bitrateKbps) ? 'on' : ''}" aria-checked="${k === v?.bitrateKbps}">${k}<small>kbps</small></button>`).join('')}
        </div>
        <p class="muted small">Lower uses less mobile data; higher sounds clearer.</p>
      </div>`);
    const actions = $(section, '#vm-actions');
    const button = (label: string, kind: string, fn: () => void) => {
      const b = el<HTMLButtonElement>(`<button class="btn btn-small ${kind}">${label}</button>`);
      b.onclick = () => {
        close();
        fn();
      };
      actions.appendChild(b);
    };
    if (!voice.joined) button(`${ICONS.headset} Join voice chat`, 'btn-primary', () => void joinVoice());
    else {
      button(voice.muted ? `${ICONS.mic} Unmute` : `${ICONS.micOff} Mute me`, 'btn-ghost', () => void voice.setMuted(!voice.muted));
      button('Leave voice chat', 'btn-ghost', () => void voice.leave());
    }
    for (const b of section.querySelectorAll<HTMLButtonElement>('.segmented button')) {
      b.onclick = async () => {
        const kbps = Number(b.dataset.kbps);
        const err = await voice.setBitrate(gs!.id, kbps);
        if (err) return showError(err);
        section.querySelectorAll('.segmented button').forEach((x) => x.classList.toggle('on', x === b));
        toast(`Voice quality: ${kbps} kbps`);
      };
    }
    body.appendChild(section);
  }

  function chipStatus(seat: Seat, rank: number, homeCount: number): string {
    if (rank >= 0) return MEDALS[rank];
    if (!seat.connected) return 'offline';
    if (seat.controller === 'human' && seat.timeouts > 0) return `<b class="warn">missed ${seat.timeouts}/${MAX_MISSED_TURNS}</b>`;
    return `${homeCount}/4 home`;
  }

  function renderQueue(s: GameState, interactive: boolean): void {
    const q = $(root, '#queue');
    q.innerHTML = '';
    const mine = interactive && canMove();
    const legal = mine ? gs!.legalMoves : [];
    const sel = mine ? validSelection(legal) : null;
    s.turn.queue.forEach((v, i) => {
      const usable = legal.some((m) => m.dieIndex === i);
      const chip = el<HTMLButtonElement>(`<button class="qchip${sel === i ? ' selected' : ''}${mine && !usable ? ' dim' : ''}">${dieChip(v)}</button>`);
      chip.disabled = !mine || !usable;
      chip.onclick = () => {
        selectedDie = i;
        play('tap');
        renderControls();
      };
      q.appendChild(chip);
    });
  }

  /** Token positions are only touched between animations (force) or when nothing is animating. */
  function renderControls(force = false): void {
    if (!gs) return;
    const seat = current();
    const me = mySeat();
    setDiceColor(seat.color);
    dice.el.classList.toggle('can-roll', canRoll());
    dice.el.disabled = !canRoll();
    if (!animating || force) showDice(!gs.finished && gs.turn.phase === 'rolling');

    let tappable = new Set<string>();
    if (canMove()) {
      selectedDie = validSelection(gs.legalMoves);
      const values = new Set(gs.turn.queue);
      const moves = values.size > 1 ? gs.legalMoves.filter((m) => m.dieIndex === selectedDie) : gs.legalMoves;
      tappable = new Set(moves.map((m) => `${me!.color}:${m.tokenId}`));
    }
    if (!animating || force) {
      tokens.sync(gs, tappable, seat.color);
      renderQueue(gs, true);
    }

    const banner = $(root, '#banner');
    banner.className = `turn-banner b-${seat.color}`;
    banner.innerHTML = gs.finished ? 'Game over' : `<span class="dot"></span><span class="tb-text">${isMyTurn() ? 'Your turn' : `${esc(seat.username)}'s turn`}</span>`;

    let hint = '';
    if (gs.finished) hint = 'Game over';
    else if (awaitingAck) hint = '…';
    else if (gs.turn.auto && isMyTurn()) hint = "Time's up — playing your turn for you. Tap to take over.";
    else if (gs.turn.auto) hint = `Time's up for ${esc(seat.username)} — auto-playing…`;
    else if (isMyTurn() && gs.turn.phase === 'rolling') hint = gs.turn.sixes > 0 ? `Rolled ${gs.turn.sixes === 1 ? 'a 6' : 'two 6s'}! Roll again` : 'Tap the dice to roll';
    else if (isMyTurn()) hint = new Set(gs.turn.queue).size > 1 ? 'Pick a die, then tap a glowing token' : 'Tap a glowing token';
    else hint = seat.controller === 'human' ? `Waiting for ${esc(seat.username)}…` : `${esc(seat.username)} (bot) is playing…`;
    $(root, '#hint').innerHTML = hint;

    $(root, '#takeback').hidden = !(me && me.controller === 'takeover' && !gs.finished);
  }

  function callout(title: string, sub: string): void {
    const c = el(`<div class="callout"><b>${esc(title)}</b><small>${esc(sub)}</small></div>`);
    fx.appendChild(c);
    setTimeout(() => c.remove(), 1300);
  }

  function burst(cell: readonly [number, number], color: Color): void {
    const b = el(`<div class="burst t-${color}" style="left:${((cell[0] + 0.5) / 15) * 100}%;top:${((cell[1] + 0.5) / 15) * 100}%">${'<i></i>'.repeat(8)}</div>`);
    fx.appendChild(b);
    setTimeout(() => b.remove(), 900);
  }

  function openMenu(): void {
    const body = el(`<div class="menu-list"></div>`);
    const m = modal({ title: 'Game menu', body, actions: [{ label: 'Close' }] });
    const item = (label: string, fn: () => void) => {
      const b = el<HTMLButtonElement>(`<button class="menu-item">${label}</button>`);
      b.onclick = () => {
        m.close();
        fn();
      };
      body.appendChild(b);
    };
    if (mySeat() && !gs!.finished) voiceMenu(body, m.close);
    if (canFullscreen() && !isFullscreen()) item('⛶ Fullscreen', () => void enterFullscreen());
    item('🏠 Back to home (game keeps running)', () => go('home'));
    if (mySeat() && !gs!.finished) {
      item('🚪 Leave game for good', async () => {
        if (!(await confirmDialog('Leave the game?', 'A bot will play your seat until the end. You cannot come back to this game.', 'Leave', true))) return;
        const r = await emit('lobby:leave', {});
        if (!r.ok) showError(r.error);
        update({ game: null });
        go('home');
      });
    }
  }

  setGameHandler(onUpdate);
  renderAll();
  if (gs.finished) queueMicrotask(() => go('results'));

  // Voice: load who is in the channel, and repaint badges/button when it or our peers change.
  if (state.voice?.gameId !== gs.id) update({ voice: null });
  void emit<VoiceState>('voice:get', { gameId: gs.id }).then((r) => r.ok && r.data && r.data.gameId === gs?.id && update({ voice: r.data }));
  const repaintVoice = () => {
    if (!gs || destroyed) return;
    renderChips();
    paintVoiceButton();
  };
  paintVoiceButton();
  const offVoice = voice.onChange(repaintVoice);
  const offStore = subscribe((changed) => changed.includes('voice') && repaintVoice());

  return () => {
    destroyed = true;
    setGameHandler(null);
    ro.disconnect();
    offVoice();
    offStore();
    offFs();
    // Voice belongs to the board screen; leaving it (results, home) leaves the channel.
    void voice.leave();
  };
}
