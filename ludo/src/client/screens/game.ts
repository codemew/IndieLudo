import { BASE, HOME, absoluteSquare, isSafeSquare, pathCells, tokenCell } from '../../shared/board.js';
import type { GameUpdate } from '../../shared/protocol.js';
import { distinctChoices, isTeammate, respawnable, winnersOf } from '../../shared/rules.js';
import {
  FIRST_BLOOD_MS,
  MAX_MISSED_TURNS,
  SURRENDER_MS,
  TEAMMATE,
  WILDCARD_MS,
  WILDCARD_STAGGER_MS,
  type Color,
  type GameEvent,
  type GameState,
  type LegalMove,
  type PublicGameState,
  type Seat,
  tempoOf,
} from '../../shared/types.js';
import { setGameHandler, showError } from '../app.js';
import { atTempo, fly, hop, reducedMotion, setTempo, sleep, slide } from '../board/animate.js';
import { moustacheLevel } from '../../shared/heft.js';
import { installMoustacheDefs, moustacheSvg } from '../moustache.js';
import { TokenLayer, boardSvg, placements } from '../board/render.js';
import { Dice, dieChip } from '../dice.js';
import { bindFullscreenButton, canFullscreen, enterFullscreen, isFullscreen } from '../fullscreen.js';
import { vibrate } from '../haptics.js';
import { emit } from '../net.js';
import { go } from '../router.js';
import { isMuted, play, setMuted } from '../sound.js';
import { state, subscribe, update } from '../store.js';
import { KEYS, storage, uuid } from '../storage.js';
import { $, COLOR_NAME, ICONS, confirmDialog, el, esc, modal, setHtml, toast } from '../ui.js';
import { voice } from '../voice.js';
import { pingText, signalBars } from '../netUi.js';
import { freshDice } from '../queueDiff.js';
import { REACTION_MS, pickReaction, type ReactionKind } from '../reactions.js';
import { threatenedTokens } from '../../shared/threats.js';
import { bindMuteButton, voiceBadge, voicePanel } from '../voiceUi.js';

/** Corner order around the board, matching each colour's base. */
const TOP: Color[] = ['red', 'green'];
const BOTTOM: Color[] = ['blue', 'yellow'];
const MEDALS = ['🥇', '🥈', '🥉', '4th'];
const SILENT_ERRORS = new Set(['STALE_VERSION', 'NOT_YOUR_TURN', 'WRONG_PHASE']);
/** How long to hold your home tokens to open the wildcard entry. */
const HOLD_MS = 450;
/** Games whose Team-up line-up was already announced on this phone. */
const announced = new Set<string>();

export function gameScreen(root: HTMLElement): () => void {
  let gs: PublicGameState | null = state.game;
  if (!gs) {
    queueMicrotask(() => go('home'));
    return () => {};
  }
  const myId = state.user?.id;
  // A bot battle plays at full speed; everything else at the normal pace.
  setTempo(tempoOf(gs));
  let clockOffset = gs.serverNow - Date.now();
  let awaitingAck = false;
  let animating = false;
  let destroyed = false;
  let selectedDie: number | null = null;
  const pending: GameUpdate[] = [];

  root.innerHTML = `
    <div class="floor-fire" id="floor-fire" aria-hidden="true"><b></b>${fireParticles()}</div>
    <header class="game-top">
      <button class="icon-btn" id="menu" aria-label="Menu">☰</button>
      <div class="turn-banner" id="banner"></div>
      <button class="icon-btn" id="voice" aria-label="Mute myself"></button>
      <button class="icon-btn" id="fullscreen" aria-label="Fullscreen" hidden></button>
      <button class="icon-btn" id="sound" aria-label="Sound"></button>
    </header>
    <div class="players">${TOP.map((c) => `<div class="pchip" data-color="${c}"></div>`).join('')}</div>
    <div class="board-wrap" id="board-wrap">
      <div class="board" id="board">
        ${boardSvg()}
        <div class="hold-layer" id="holds"></div>
        <div class="target-layer" id="targets"></div>
        <div class="token-layer" id="tokens"></div>
        <div class="flag-layer" id="flags"></div>
        <div class="fx-layer" id="fx"></div>
      </div>
    </div>
    <div class="players">${BOTTOM.map((c) => `<div class="pchip" data-color="${c}"></div>`).join('')}</div>
    <footer class="dock">
      <div class="dock-left">
        <div class="queue" id="queue"></div>
        <div class="hint" id="hint"></div>
        <button class="btn btn-small btn-primary" id="takeback" hidden>🤖 Bot playing for you · Take back</button>
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
  // A six streak sets the floor of the screen alight: amber after one six, deep orange after two.
  const setFlame = (sixes: number) => (root.dataset.flame = String(Math.min(sixes, 2)));
  const sadFace = el(`<div class="dice-emoji" aria-hidden="true">😩</div>`);
  diceSlot.appendChild(sadFace);
  const targets = $(root, '#targets');
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
  const offMute = bindMuteButton($<HTMLButtonElement>(root, '#voice'));
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
    // Several of my tokens on this square that aren't alike (moustaches, laps left): which one?
    const from = gs!.tokens[color][tokenId];
    if (from !== BASE) {
      const stacked = distinctChoices(gs!.legalMoves.filter((m) => m.dieIndex === pick.dieIndex && !m.lap && gs!.tokens[color][m.tokenId] === from), gs!);
      if (stacked.length > 1) return chooseStacked(stacked);
    }
    void moveToken(tokenId, pick.dieIndex);
  }

  /** Moves the chosen token with the chosen die: asks which way at its home turn, and before friendly fire. */
  async function moveToken(tokenId: number, dieIndex: number): Promise<void> {
    const options = gs!.legalMoves.filter((m) => m.tokenId === tokenId && m.dieIndex === dieIndex);
    // At its home turn on the first lap the token may go round again: ask which way.
    const lap = options.find((m) => m.lap);
    const home = options.find((m) => !m.lap);
    if (!home) return;
    if (lap) return chooseLap(home, lap);
    if (!(await friendlyFireOk(home))) return;
    play('tap');
    void send('game:move', { dieIndex, tokenId });
  }

  /** Team-up: capturing my teammate is allowed, but asked about first. */
  async function friendlyFireOk(m: LegalMove): Promise<boolean> {
    const me = mySeat()?.color;
    const mates = m.captures.filter((c) => me && isTeammate(gs!, me, c.color));
    if (!mates.length) return true;
    return confirmDialog(
      'Capture your teammate?',
      `That sends ${seatName(mates[0].color)}'s token back to base. You still get a bonus roll, but your moustache shrinks a level.`,
      'Capture anyway',
      true,
    );
  }

  /** The open "which token moves?" picker, closed if the game moves on. */
  let stackChooser: { close: () => void; version: number } | null = null;

  /**
   * Same-colour tokens on one square that aren't alike (different moustaches, or one on its last
   * lap): big cards to pick from, since the stacked tokens on the board are small.
   */
  function chooseStacked(moves: LegalMove[]): void {
    play('tap');
    stackChooser?.close();
    const color = mySeat()!.color;
    const body = el(`<div class="stack-choice">${moves
      .map((m) => {
        const kills = gs!.kills?.[color]?.[m.tokenId] ?? 0;
        const last = Boolean(gs!.extraLaps?.[color]?.[m.tokenId]);
        const victims = m.captures.map((c) => `<b class="lap-victim n-${c.color}">${esc(seatName(c.color))}</b>`).join(' ');
        return `<button class="stack-opt" data-token="${m.tokenId}">
          ${miniToken(color, kills)}
          <b>${kills ? `${kills} capture${kills === 1 ? '' : 's'}` : 'Clean-shaven'}</b>
          ${last ? '<small class="tag">last lap</small>' : ''}
          ${victims ? `<span class="lap-badge">⚔ ${victims}</span>` : ''}
        </button>`;
      })
      .join('')}</div>`);
    const m = modal({ title: 'Which token moves?', body, actions: [{ label: 'Not now' }], onDismiss: () => (stackChooser = null) });
    stackChooser = { close: m.close, version: gs!.version };
    body.querySelectorAll<HTMLButtonElement>('.stack-opt').forEach(
      (b) =>
        (b.onclick = () => {
          const dieIndex = moves[0].dieIndex;
          stackChooser?.close();
          stackChooser = null;
          void moveToken(Number(b.dataset.token), dieIndex);
        }),
    );
  }

  /** The open "home or another lap?" confirm, closed if the game moves on (e.g. the timer plays the turn). */
  let lapChooser: { close: () => void; version: number } | null = null;

  /**
   * The choice for a token at its home turn: two option cards, coloured like the trails on the
   * board (gold home, blue round again), each saying what it means. The board's markers can be
   * tapped instead.
   */
  function chooseLap(home: LegalMove, lap: LegalMove): void {
    play('tap');
    lapChooser?.close();
    const toGo = HOME - home.to;
    const victims = lap.captures.map((c) => `<b class="lap-victim n-${c.color}">${esc(seatName(c.color))}</b>`).join(' ');
    const body = el(`<div class="lap-choice">
      <div class="lap-opts">
        <button class="lap-opt home" data-go="home">
          <span class="lap-ico">🏠</span>
          <b>Head home</b>
          <small>${toGo ? `${toGo} square${toGo === 1 ? '' : 's'} to finish` : 'Finishes now!'}</small>
          <small>Safe from capture</small>
        </button>
        <button class="lap-opt round" data-go="round">
          <span class="lap-ico">↻</span>
          <b>Go round again</b>
          ${victims ? `<span class="lap-badge">⚔ Captures ${victims}</span>` : '<small>Hunt more, but it can be caught</small>'}
        </button>
      </div>
      <p class="lap-note">Each token gets one extra lap: going round again uses it, so this one can't make a wildcard entry later. Tip: tap the gold or blue marker on the board.</p>
    </div>`);
    const answer = async (goRound: boolean) => {
      lapChooser?.close();
      lapChooser = null;
      if (!(await friendlyFireOk(goRound ? lap : home))) return;
      play('tap');
      void send('game:move', { dieIndex: home.dieIndex, tokenId: home.tokenId, lap: goRound });
    };
    body.querySelectorAll<HTMLButtonElement>('.lap-opt').forEach((b) => (b.onclick = () => void answer(b.dataset.go === 'round')));
    const m = modal({ title: 'Which way?', body, actions: [{ label: 'Not now' }], onDismiss: () => (lapChooser = null) });
    lapChooser = { close: m.close, version: gs!.version };
  }

  // Tapping a gold or blue marker on the board chooses that way directly.
  targets.addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.target[data-token]');
    if (!t || !canMove()) return;
    lapChooser?.close();
    lapChooser = null;
    const move = { dieIndex: Number(t.dataset.die), tokenId: Number(t.dataset.token), lap: t.dataset.lap === '1' };
    const m = gs!.legalMoves.find((x) => x.dieIndex === move.dieIndex && x.tokenId === move.tokenId && Boolean(x.lap) === move.lap);
    if (m && !(await friendlyFireOk(m))) return;
    play('tap');
    void send('game:move', move);
  });

  // ---------- wildcard entry: hold your home tokens to send some back to base ----------

  const holds = $(root, '#holds');
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  holds.addEventListener('pointerdown', (e) => {
    const zone = (e.target as HTMLElement).closest<HTMLElement>('.home-hold');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      zone.classList.remove('holding');
      vibrate(15);
      openWildcard();
    }, HOLD_MS);
  });
  const letGo = (e: Event) => {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    holds.querySelector('.home-hold')?.classList.remove('holding');
    if (e.type === 'pointerup') toast('Hold your home tokens to send one back: a wildcard entry 🃏');
  };
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) holds.addEventListener(type, letGo);
  holds.addEventListener('contextmenu', (e) => e.preventDefault());

  /** The hold zone over my home triangle, while I have tokens there that may go again. */
  function renderHolds(): void {
    const me = mySeat()?.color;
    if (!gs || !me || !respawnable(gs, me).length) return setHtml(holds, '');
    const [x, y] = tokenCell(me, HOME, 0);
    setHtml(holds, `<div class="home-hold h-${me}" style="left:${((x + 0.5) / 15) * 100}%;top:${((y + 0.5) / 15) * 100}%" role="button" aria-label="Hold for a wildcard entry"></div>`);
  }

  /** The open wildcard sheet: kept up to date while the game goes on, closed when nothing is left to pick. */
  let wildcard: { close: () => void; refresh: () => void } | null = null;

  /** Pick home tokens to send back to base: toggle cards, then Send back. */
  function openWildcard(): void {
    const me = mySeat()?.color;
    if (!gs || !me) return;
    wildcard?.close();
    const chosen = new Set<number>();
    const body = el(`<div class="wildcard-sheet">
      <p class="wc-note">They go back to base and need a 6 to come out. To win, all 4 must be home again. Each token can do this once, and can't go round again after it.</p>
      <p class="wc-note wc-rank" hidden></p>
      <div class="wc-cards"></div>
      <button class="btn btn-primary btn-xl wc-send" disabled>🃏 Send back</button>
    </div>`);
    const cards = $(body, '.wc-cards');
    const sendBtn = $<HTMLButtonElement>(body, '.wc-send');
    const paint = () => {
      const ids = respawnable(gs!, me);
      if (!ids.length) return wildcard?.close();
      for (const id of [...chosen]) if (!ids.includes(id)) chosen.delete(id);
      setHtml(
        cards,
        ids
          .map((id) => {
            const kills = gs!.kills?.[me]?.[id] ?? 0;
            return `<button class="wc-card${chosen.has(id) ? ' on' : ''}" data-token="${id}" aria-pressed="${chosen.has(id)}">${miniToken(me, kills)}<b>Token ${id + 1}</b><small>${kills ? `${kills} capture${kills === 1 ? '' : 's'} 🥸` : 'Clean-shaven'}</small></button>`;
          })
          .join(''),
      );
      cards.querySelectorAll<HTMLButtonElement>('.wc-card').forEach(
        (b) =>
          (b.onclick = () => {
            const id = Number(b.dataset.token);
            if (chosen.has(id)) chosen.delete(id);
            else chosen.add(id);
            play('tap');
            paint();
          }),
      );
      const place = gs!.ranks.indexOf(me);
      const rank = $(body, '.wc-rank');
      rank.hidden = place < 0;
      rank.textContent = place < 0 ? '' : `You finished ${MEDALS[place]}: you give that place up until all 4 are home again.`;
      sendBtn.disabled = chosen.size === 0;
      sendBtn.textContent = chosen.size ? `🃏 Send back (${chosen.size})` : '🃏 Send back';
    };
    sendBtn.onclick = async () => {
      if (!chosen.size) return;
      const tokens = [...chosen].reduce((mask, id) => mask | (1 << id), 0);
      wildcard?.close();
      const r = await emit('game:respawn', { gameId: gs!.id, actionId: uuid(), tokens });
      if (!r.ok) showError(r.error);
    };
    const m = modal({ title: '🃏 Wildcard entry', body, actions: [{ label: 'Cancel' }], onDismiss: () => (wildcard = null) });
    wildcard = {
      close: () => {
        m.close();
        wildcard = null;
      },
      refresh: paint,
    };
    paint();
  }

  // ---------- updates from the server ----------

  function onUpdate(u: GameUpdate): void {
    // The turn moved on without us (the timer played it, or a resync): that choice is gone.
    if (lapChooser && u.state.version !== lapChooser.version) {
      lapChooser.close();
      lapChooser = null;
    }
    if (stackChooser && u.state.version !== stackChooser.version) {
      stackChooser.close();
      stackChooser = null;
    }
    if (!gs || u.state.id !== gs.id) {
      gs = u.state;
      setTempo(tempoOf(gs));
      update({ game: gs });
      renderAll();
      warnThreatened(false);
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
      const animate = Boolean(u.events?.length && u.state.version === prev.version + 1 && pending.length < 3);
      if (animate) await playEvents(structuredClone(prev), u.events!);
      gs = u.state;
      update({ game: gs });
      renderAll();
      warnThreatened(animate);
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
    let lastMover: HTMLElement | undefined;
    let lastMove: { color: Color; tokenId: number } | undefined;
    for (const [i, e] of events.entries()) {
      if (destroyed) return;
      switch (e.type) {
        case 'roll': {
          setDiceColor(e.color);
          showDice(true);
          renderTargets([]);
          play('dice');
          if (e.color === me) vibrate(12);
          work.turn.queue = e.queue;
          await dice.roll(e.value);
          renderQueue(work, false);
          // A usable six sets the dice on fire (a useless one just ends the turn, a third is the penalty).
          const sixes = e.queue.filter((v) => v === 6).length;
          const next = events[i + 1]?.type;
          if (e.value === 6 && sixes <= 2 && next !== 'noMoves' && next !== 'penalty') {
            setFlame(sixes);
            play(sixes === 1 ? 'six' : 'six2');
            if (e.color === me) vibrate(sixes === 1 ? 30 : [30, 40, 30]);
          }
          // Let the result sit for a moment before the dice steps aside (or resets for a re-roll).
          await sleep(450);
          if (e.value !== 6) {
            setFlame(0);
            showDice(false);
          }
          break;
        }
        case 'penalty':
          setFlame(0);
          sadFace.classList.remove('show');
          void sadFace.offsetWidth;
          sadFace.classList.add('show');
          dice.shake();
          play('penalty');
          vibrate([60, 40, 60]);
          callout('3 sixes!', 'Turn lost');
          $(root, '#hint').textContent = 'Three sixes in a row: turn lost';
          work.turn.queue = [];
          renderQueue(work, false);
          await sleep(1700);
          sadFace.classList.remove('show');
          break;
        case 'move': {
          const el = tokens.get(e.color, e.tokenId);
          if (!el) break;
          lastMover = el;
          lastMove = { color: e.color, tokenId: e.tokenId };
          const start = tokenCell(e.color, e.from, e.tokenId);
          const path = pathCells(e.color, e.from, e.to, e.tokenId);
          const idx = work.turn.queue.indexOf(e.die);
          if (idx >= 0) work.turn.queue.splice(idx, 1);
          renderQueue(work, false);
          renderTargets([]);
          const kills = e.kills ?? 0;
          await hop(el, start, path, {
            kills,
            fromBase: e.from === BASE,
            onStep: (_i, cell) => {
              play('step');
              heavyLanding(cell, kills);
            },
          });
          work.tokens[e.color][e.tokenId] = e.to;
          tokens.sync(work, new Set(), null);
          const abs = absoluteSquare(e.color, e.to);
          if (abs !== null && isSafeSquare(abs)) {
            play('safe');
            burst(tokenCell(e.color, e.to, e.tokenId), 'gold');
            tokenEmoji(el, 'safe');
          }
          break;
        }
        case 'capture': {
          const el = tokens.get(e.victim, e.tokenId);
          if (!el) break;
          const from = tokenCell(e.victim, e.from, e.tokenId);
          play(e.friendly ? 'friendlyFire' : 'capture');
          vibrate([30, 50, 30]);
          burst(from, e.color);
          if (e.friendly) {
            // Team-up: eating your own teammate. Allowed, but nobody is proud of it.
            callout('Friendly fire!', 'Stabbed in the back!');
          } else {
            // The capturer savours its meal while the victim reacts on its way home.
            if (lastMover) tokenEmoji(lastMover, 'yum');
            setTimeout(() => play('slurp'), 260);
          }
          tokenEmoji(el, 'ouch');
          await slide(el, from, tokenCell(e.victim, BASE, e.tokenId), 560);
          work.tokens[e.victim][e.tokenId] = BASE;
          // The capturer's moustache grows a level (shrinks one for friendly fire); the captured
          // token goes home clean-shaven.
          work.kills ??= {};
          (work.kills[e.victim] ??= [0, 0, 0, 0])[e.tokenId] = 0;
          if (lastMove) {
            const k = (work.kills[lastMove.color] ??= [0, 0, 0, 0]);
            k[lastMove.tokenId] = e.friendly ? Math.max(0, moustacheLevel(k[lastMove.tokenId]) - 1) : k[lastMove.tokenId] + 1;
          }
          tokens.sync(work, new Set(), null);
          // The game's first capture: everyone gets the "first blood" banner.
          if (e.firstBlood) await firstBloodBanner(e.color, e.victim);
          break;
        }
        case 'home':
          play('home');
          burst(tokenCell(e.color, HOME, e.tokenId), e.color);
          // The first time one of mine gets home, say it can go again.
          if (e.color === me && !storage.get(KEYS.wildcardTip)) {
            storage.set(KEYS.wildcardTip, '1');
            toast('Tip: hold your tokens at home to send one back for a wildcard entry 🃏', 'info', 4500);
          }
          break;
        case 'rank':
          toast(work.teams ? `${seatName(e.color)} has all 4 home 🏠` : `${seatName(e.color)} finished ${MEDALS[e.rank - 1]}`, 'success');
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
        case 'surrender': {
          // Their tokens head back to base, then a white flag goes up over it.
          toast(e.color === me ? 'You surrendered 🏳️' : `${seatName(e.color)} surrendered 🏳️`);
          renderTargets([]);
          const slides = e.from.map((p, id) => {
            const el = tokens.get(e.color, id);
            if (!el || p === HOME || p === BASE) return undefined;
            return slide(el, tokenCell(e.color, p, id), tokenCell(e.color, BASE, id), 700);
          });
          await Promise.all(slides);
          // Back in base, clean-shaven.
          const shaved = work.kills?.[e.color];
          work.tokens[e.color] = work.tokens[e.color].map((p, i) => {
            if (p === HOME) return p;
            if (shaved) shaved[i] = 0;
            return BASE;
          });
          work.surrendered = [...(work.surrendered ?? []), e.color];
          tokens.sync(work, new Set(), null);
          renderFlags(work);
          await sleep(SURRENDER_MS - 700);
          break;
        }
        case 'respawn':
          await wildcardEntry(work, e.color, e.tokenIds, e.unranked);
          break;
        case 'turn':
          if (e.color === me) {
            play('turn');
            vibrate(35);
          }
          break;
        case 'gameOver':
          play(me && winnersOf({ teams: work.teams, ranks: e.ranks }).includes(me) ? 'win' : 'home');
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

  /**
   * A white flag waving over the base of each player who surrendered; their tokens in base are
   * greyed out. Only touched when the set of flags changes.
   */
  const flagLayer = $(root, '#flags');
  function renderFlags(s: GameState): void {
    const out = s.surrendered ?? [];
    for (const c of ['red', 'green', 'yellow', 'blue'] as const) board.classList.toggle(`out-${c}`, out.includes(c));
    const key = out.join(',');
    if (flagLayer.dataset.key === key) return;
    flagLayer.dataset.key = key;
    flagLayer.innerHTML = out
      .map((c) => {
        const slots = [0, 1, 2, 3].map((i) => tokenCell(c, BASE, i));
        const x = slots.reduce((a, p) => a + p[0], 0) / 4;
        const y = slots.reduce((a, p) => a + p[1], 0) / 4;
        return `<div class="surrender-flag f-${c}" style="left:${((x + 0.5) / 15) * 100}%;top:${((y + 0.5) / 15) * 100}%" role="img" aria-label="${esc(seatName(c))} surrendered">${whiteFlag()}</div>`;
      })
      .join('');
  }

  function renderAll(): void {
    if (!gs) return;
    renderFlags(gs);
    renderChips();
    renderControls(true);
    renderHolds();
    wildcard?.refresh();
    if (gs.turn.phase === 'rolling') dice.idle();
    announceTeams();
  }

  /** Team-up: once per game, who plays with whom. */
  function announceTeams(): void {
    const me = mySeat()?.color;
    if (!gs?.teams || !me || gs.finished || announced.has(gs.id)) return;
    announced.add(gs.id);
    const them = gs.seats.filter((x) => x.color !== me && x.color !== TEAMMATE[me]).map((x) => esc(x.username));
    toast(`Team-up: you & ${seatName(TEAMMATE[me])} vs ${them.join(' & ')}`, 'info', 4000);
  }

  /**
   * A wildcard entry, on every phone: a hazard-striped banner slams across the board, each token
   * rises from home, spins and flies to its base, and lands with a thud that shakes the board.
   */
  async function wildcardEntry(work: GameState, color: Color, ids: number[], unranked?: number): Promise<void> {
    const me = mySeat()?.color;
    renderTargets([]);
    const banner = el(`
      <div class="wildcard-banner w-${color}" role="status" style="--wc-ms:${atTempo(WILDCARD_MS)}ms">
        <b>Wildcard entry</b>
        <small><span class="fb-name n-${color}">${color === me ? 'You' : esc(seatName(color))}</span> ${color === me ? 'are back for more!' : 'is back for more · beware!'}</small>
      </div>`);
    fx.appendChild(banner);
    setTimeout(() => banner.remove(), atTempo(WILDCARD_MS));
    play('wildcard');
    vibrate([40, 60, 40, 60, 160]);
    if (unranked) toast(`${color === me ? 'You' : seatName(color)} gave up ${MEDALS[unranked - 1]} for a wildcard entry!`);
    await sleep(450);
    const at = placements(work);
    await Promise.all(
      ids.map(async (id, i) => {
        await sleep(i * WILDCARD_STAGGER_MS);
        const token = tokens.get(color, id);
        if (!token) return;
        const p = at.get(`${color}:${id}`);
        const base = tokenCell(color, BASE, id);
        token.classList.add('wildcard-glow');
        await fly(token, p ? [p.x, p.y] : tokenCell(color, HOME, id), base, 1500);
        token.classList.remove('wildcard-glow');
        play('land');
        shockwave(base, color);
        if (!reducedMotion()) board.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(5px)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }], { duration: 320 });
      }),
    );
    for (const id of ids) {
      work.tokens[color][id] = BASE;
      (work.extraLaps ??= {})[color] ??= [0, 0, 0, 0];
      work.extraLaps[color]![id] = 1;
    }
    work.ranks = work.ranks.filter((c) => c !== color || !unranked);
    tokens.sync(work, new Set(), null);
    basePulse(color);
    await sleep(450);
  }

  function shockwave(cell: readonly [number, number], color: Color): void {
    const w = el(`<div class="shockwave t-${color}" style="left:${((cell[0] + 0.5) / 15) * 100}%;top:${((cell[1] + 0.5) / 15) * 100}%"></div>`);
    fx.appendChild(w);
    setTimeout(() => w.remove(), 800);
  }

  /** The base the wildcard tokens landed in glows once: here comes trouble. */
  function basePulse(color: Color): void {
    const slots = [0, 1, 2, 3].map((i) => tokenCell(color, BASE, i));
    const x = slots.reduce((a, p) => a + p[0], 0) / 4;
    const y = slots.reduce((a, p) => a + p[1], 0) / 4;
    const p = el(`<div class="base-pulse t-${color}" style="left:${((x + 0.5) / 15) * 100}%;top:${((y + 0.5) / 15) * 100}%"></div>`);
    fx.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }

  function renderChips(): void {
    for (const chip of root.querySelectorAll<HTMLElement>('.pchip')) {
      const color = chip.dataset.color as Color;
      const seat = gs!.seats.find((s) => s.color === color);
      if (!seat) {
        chip.className = 'pchip pchip-empty';
        setHtml(chip, '');
        continue;
      }
      const rank = gs!.ranks.indexOf(color);
      const active = !gs!.finished && current().color === color;
      const homeCount = gs!.tokens[color].filter((p) => p === HOME).length;
      const timed = active && gs!.turn.deadline > 0;
      chip.className = `pchip p-${color}${active ? ' active' : ''}${timed ? ' timed' : ''}${seat.connected ? '' : ' offline'}`;
      // Built once; afterwards only the parts that changed are touched, since pings and voice
      // changes redraw the chips every few seconds.
      setHtml(
        chip,
        '<span class="pchip-icon"><span class="pchip-dot"></span><span class="pchip-mate" hidden></span><span class="pchip-ping"></span></span>' +
          '<span class="pchip-text"><span class="pchip-name"><span class="pn"></span><span class="pchip-sig"></span></span><span class="pchip-sub"></span></span>' +
          '<span class="pchip-timer"><i></i></span>',
      );
      const dot = $(chip, '.pchip-dot');
      setHtml(dot, seat.controller !== 'human' ? '🤖' : esc(seat.username[0]?.toUpperCase() ?? ''));
      // Talking rings (talkUi.ts) for anyone in the voice chat.
      if (seat.userId !== null && seat.controller !== 'bot') dot.dataset.talk = String(seat.userId);
      else delete dot.dataset.talk;
      setHtml($(chip, '.pchip-ping'), pingText(seat.userId));
      // Team-up: a small dot in the partner's colour on the avatar.
      const mate = $(chip, '.pchip-mate');
      mate.hidden = !gs!.teams;
      if (gs!.teams) {
        mate.className = `pchip-mate m-${TEAMMATE[color]}`;
        mate.title = `Teammate: ${seatName(TEAMMATE[color])}`;
      }
      // Name and mic badge apart from the signal bars, which change with every ping.
      setHtml($(chip, '.pn'), `${esc(seat.username)}${seat.userId === myId ? ' <em>you</em>' : ''}${voiceBadge(seat.userId)}`);
      setHtml($(chip, '.pchip-sig'), signalBars(seat.userId));
      setHtml($(chip, '.pchip-sub'), chipStatus(seat, rank, homeCount));
      // The timer bar restarts only for a new deadline, not on every redraw.
      const bar = $(chip, '.pchip-timer i');
      const timerKey = timed ? String(gs!.turn.deadline) : '';
      if (bar.dataset.deadline !== timerKey) {
        bar.dataset.deadline = timerKey;
        bar.getAnimations().forEach((a) => a.cancel());
        if (timed) {
          const total = Math.max(1, (gs!.turn.deadline - gs!.serverNow) || 1);
          const remaining = Math.max(0, gs!.turn.deadline - (Date.now() + clockOffset));
          bar.animate([{ transform: `scaleX(${Math.min(1, remaining / total)})` }, { transform: 'scaleX(0)' }], { duration: remaining, fill: 'forwards' });
        }
      }
    }
  }

  // ---------- voice chat (lobby-wide; see voiceUi.ts) ----------

  function voiceMenu(body: HTMLElement, close: () => void): void {
    const section = el(`
      <div class="menu-section">
        <div class="menu-heading">Voice chat</div>
        <div class="menu-row" id="vm-actions"></div>
      </div>`);
    if (voice.enabled && voice.joined && voice.micAvailable) {
      const b = el<HTMLButtonElement>(`<button class="btn btn-small btn-ghost">${voice.muted ? `${ICONS.mic} Unmute myself` : `${ICONS.micOff} Mute myself`}</button>`);
      b.onclick = () => {
        close();
        void voice.setMuted(!voice.muted);
      };
      $(section, '#vm-actions').appendChild(b);
    } else {
      $(section, '#vm-actions').remove();
    }
    section.appendChild(voicePanel().el);
    body.appendChild(section);
  }

  /**
   * The six-streak fire along the floor of the screen, under the queue (left of the dice): soft
   * glowing particles spread across it that rise, sway, shrink and fade, staggered so the fire
   * flickers continuously.
   */
  function fireParticles(count = 24): string {
    let html = '';
    for (let i = 0; i < count; i++) {
      const x = (i + Math.random()) / count; // evenly spread, a little jittered
      const size = Math.round(54 + Math.random() * 40);
      const dx = Math.round((Math.random() - 0.5) * 24);
      const dur = 1.5 + Math.random() * 0.9;
      const delay = -(Math.random() * dur).toFixed(2);
      const rise = (0.7 + Math.random() * 0.5).toFixed(2); // some tongues reach higher
      html += `<i style="--x:${(x * 100).toFixed(1)}%;--s:${size}px;--dx:${dx}px;--t:${dur.toFixed(2)}s;--d:${delay}s;--r:${rise}"></i>`;
    }
    return html;
  }

  function chipStatus(seat: Seat, rank: number, homeCount: number): string {
    if (gs!.surrendered?.includes(seat.color)) return '🏳️ surrendered';
    if (rank >= 0) return gs!.teams ? '✓ all home' : MEDALS[rank];
    if (!seat.connected) return 'offline';
    if (seat.controller === 'human' && seat.timeouts > 0) return `<b class="warn">missed ${seat.timeouts}/${MAX_MISSED_TURNS}</b>`;
    return `${homeCount}/4 home`;
  }

  /**
   * Queued dice, in the current player's colour. On your move the die the next token tap will
   * use is lifted, outlined, glowing and tagged "USE"; dice that can't move anything are greyed.
   */
  let shownQueue: number[] = [];
  function renderQueue(s: GameState, interactive: boolean): void {
    const q = $(root, '#queue');
    q.innerHTML = '';
    const mine = interactive && canMove();
    q.dataset.color = s.seats[s.turn.seat].color;
    q.classList.toggle('mine', mine);
    const legal = mine ? gs!.legalMoves : [];
    const sel = mine ? validSelection(legal) : null;
    // Dice already in the queue keep still; only newly rolled ones pop in.
    const fresh = freshDice(shownQueue, s.turn.queue);
    shownQueue = [...s.turn.queue];
    s.turn.queue.forEach((v, i) => {
      const usable = legal.some((m) => m.dieIndex === i);
      const chip = el<HTMLButtonElement>(
        `<button class="qchip${fresh[i] ? '' : ' settled'}${sel === i ? ' selected' : ''}${mine && !usable ? ' dim' : ''}" aria-label="Die ${v}${sel === i ? ', selected' : ''}">${dieChip(v)}${sel === i ? '<span class="qtag">USE</span>' : ''}</button>`,
      );
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
      if (!animating || force) renderTargets(moves);
    } else if (!animating || force) {
      renderTargets([]);
    }
    if (!animating || force) {
      tokens.sync(gs, tappable, seat.color);
      renderQueue(gs, true);
      setFlame(gs.turn.phase === 'rolling' ? gs.turn.sixes : 0);
    }

    const banner = $(root, '#banner');
    banner.className = `turn-banner b-${seat.color}`;
    setHtml(banner, gs.finished ? 'Game over' : `<span class="dot"></span><span class="tb-text">${isMyTurn() ? 'Your turn' : `${esc(seat.username)}'s turn`}</span>`);

    let hint = '';
    if (gs.finished) hint = 'Game over';
    else if (awaitingAck) hint = '…';
    else if (gs.turn.auto && isMyTurn()) hint = "Time's up — playing your turn for you. Tap to take over.";
    else if (gs.turn.auto) hint = `Time's up for ${esc(seat.username)} — auto-playing…`;
    else if (isMyTurn() && gs.turn.phase === 'rolling') hint = gs.turn.sixes > 0 ? `Rolled ${gs.turn.sixes === 1 ? 'a 6' : 'two 6s'}! Roll again` : 'Tap the dice to roll';
    else if (isMyTurn()) hint = new Set(gs.turn.queue).size > 1 ? 'Moving with the highlighted die · tap another die to switch' : 'Tap a glowing token';
    else if (gs.botBattle) hint = `🤖 Bot battle at full speed · ${esc(seat.username)} to play`;
    else hint = seat.controller === 'human' ? `Waiting for ${esc(seat.username)}…` : `${esc(seat.username)} (bot) is playing…`;
    // Watching from the side (or after giving up): say so, since nothing on the board is yours to tap.
    if (!me && !gs.finished) hint = `<span class="watch-tag">👀 Watching</span> ${hint}`;
    else if (me && !gs.finished && gs.surrendered?.includes(me.color)) hint = `<span class="watch-tag">🏳️ You surrendered</span> ${hint}`;
    setHtml($(root, '#hint'), hint);

    // The take-back button sits where the hint goes, so the dock never grows a row.
    const takeback = Boolean(me && me.controller === 'takeover' && !gs.finished);
    $(root, '#takeback').hidden = !takeback;
    $(root, '#hint').hidden = takeback;
  }

  /** A red strip slams across the board: FIRST BLOOD, and who captured whom. */
  async function firstBloodBanner(killer: Color, victim: Color): Promise<void> {
    const name = (c: Color) => `<span class="fb-name n-${c}">${c === mySeat()?.color ? 'You' : esc(seatName(c))}</span>`;
    const banner = el(`
      <div class="kill-banner" role="status" style="--fb-ms:${atTempo(FIRST_BLOOD_MS)}ms">
        <b>First blood</b>
        <small>${name(killer)} <span class="fb-arrow">⚔</span> ${name(victim)}</small>
      </div>`);
    fx.appendChild(banner);
    play('firstBlood');
    vibrate([60, 40, 120]);
    await sleep(FIRST_BLOOD_MS);
    banner.remove();
  }

  function callout(title: string, sub: string): void {
    const c = el(`<div class="callout"><b>${esc(title)}</b><small>${esc(sub)}</small></div>`);
    fx.appendChild(c);
    setTimeout(() => c.remove(), 1300);
  }

  /**
   * The token briefly becomes an emoji, then fades back into itself: one of several reactions
   * on a star ('safe'), after a capture ('yum') and while being sent home ('ouch'), picked at
   * random but never the same one twice in a row.
   */
  const lastReaction: Partial<Record<ReactionKind, string>> = {};
  function tokenEmoji(token: HTMLElement, kind: ReactionKind): void {
    const r = pickReaction(kind, lastReaction[kind]);
    lastReaction[kind] = r.anim;
    token.querySelector('.tok-emoji')?.remove();
    const face = el(`<span class="tok-emoji r-${r.anim}" aria-hidden="true">${r.face}</span>`);
    token.appendChild(face);
    token.classList.add('shows-emoji');
    setTimeout(() => {
      face.remove();
      if (!token.querySelector('.tok-emoji')) token.classList.remove('shows-emoji');
    }, REACTION_MS);
  }

  /**
   * A token that an opponent has just got within one roll of (see threats.ts) looks over its
   * shoulder and runs: once, when the danger starts, not for as long as it lasts. After a
   * resync (reconnect, catching up) we only take note, without animating.
   */
  let warned = new Set<string>();
  function warnThreatened(animate: boolean): void {
    const now = threatenedTokens(gs!);
    if (animate) {
      for (const key of now) {
        if (warned.has(key)) continue;
        const [color, id] = key.split(':') as [Color, string];
        const show = () => {
          const token = tokens.get(color, Number(id));
          if (token && !destroyed && threatenedTokens(gs!).has(key)) tokenEmoji(token, 'flee');
        };
        // Let a reaction already playing (star, capture) finish first.
        if (tokens.get(color, Number(id))?.classList.contains('shows-emoji')) setTimeout(show, REACTION_MS);
        else show();
      }
    }
    warned = now;
  }

  /**
   * Where each glowing token would land with the selected die. A token at its home turn gets a
   * branching path: a gold trail into the home stretch and a blue one round the board again.
   */
  function renderTargets(moves: LegalMove[]): void {
    const color = mySeat()?.color;
    let html = '';
    const seen = new Set<string>();
    const at = (c: readonly [number, number]) => `left:${((c[0] + 0.5) / 15) * 100}%;top:${((c[1] + 0.5) / 15) * 100}%`;
    for (const m of color ? moves : []) {
      const branches = moves.some((o) => o.tokenId === m.tokenId && o.dieIndex === m.dieIndex && o.lap);
      if (branches) {
        const trail = pathCells(color!, m.from, m.to, m.tokenId).slice(0, -1);
        html += trail.map((c) => `<div class="trail ${m.lap ? 'round' : 'home'}" style="${at(c)}"></div>`).join('');
      }
      const [x, y] = tokenCell(color!, m.to, m.tokenId);
      const key = m.to === HOME ? 'home' : `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pick = branches ? ` data-die="${m.dieIndex}" data-token="${m.tokenId}" data-lap="${m.lap ? 1 : 0}" role="button" aria-label="${m.lap ? 'Go round again' : 'Head home'}"` : '';
      html += `<div class="target t-${color}${branches ? (m.lap ? ' round' : ' home') : ''}" style="${at([x, y])}"${pick}>${branches && m.lap ? '<span>↻</span>' : ''}</div>`;
    }
    // Unchanged markers keep pulsing instead of restarting on every redraw.
    setHtml(targets, html);
  }

  /** A token with captures lands heavily: the board shakes from 1 kill, and dust flies from 2. */
  function heavyLanding(cell: readonly [number, number], kills: number): void {
    const k = moustacheLevel(kills);
    if (!k || reducedMotion()) return;
    const amp = 1.8 + 0.9 * k;
    board.animate(
      [{ transform: 'translateY(0)' }, { transform: `translateY(${amp}px)` }, { transform: `translateY(${-amp * 0.5}px)` }, { transform: `translateY(${amp * 0.2}px)` }, { transform: 'translateY(0)' }],
      { duration: 200 + 35 * k },
    );
    if (k < 2) return;
    const left = ((cell[0] + 0.5) / 15) * 100;
    const top = ((cell[1] + 0.85) / 15) * 100;
    for (const dir of [-1, 1]) {
      for (let i = 0; i < Math.min(3, k - 1); i++) {
        const p = el(`<span class="fx-dust" style="left:${left}%;top:${top}%"></span>`);
        fx.appendChild(p);
        p.animate(
          [
            { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0.9 },
            { transform: `translate(calc(-50% + ${dir * (6 + 5 * i + 2 * k)}px), calc(-50% - ${3 + 4 * i}px)) scale(${1.4 + 0.2 * k})`, opacity: 0 },
          ],
          { duration: 420 + 60 * k, easing: 'cubic-bezier(.2,.7,.3,1)' },
        ).finished.then(() => p.remove());
      }
    }
  }

  function burst(cell: readonly [number, number], color: Color | 'gold'): void {
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
    if (state.lobby) voiceMenu(body, m.close);
    if (canFullscreen() && !isFullscreen()) item('⛶ Fullscreen', () => void enterFullscreen());
    item('🏠 Back to home (game keeps running)', () => go('home'));
    if (!mySeat()) {
      item('🚪 Stop watching (leave the lobby)', async () => {
        const r = await emit('lobby:leave', {});
        if (!r.ok) showError(r.error);
        update({ game: null });
        go('home');
      });
    } else if (!gs!.finished) {
      const mine = mySeat()!;
      const spare = respawnable(gs!, mine.color).length;
      if (spare) item(`🃏 Wildcard entry (${spare} at home)`, () => openWildcard());
      if (!gs!.surrendered?.includes(mine.color) && !gs!.ranks.includes(mine.color)) {
        item('🏳️ Surrender', async () => {
          const others = gs!.seats.filter((s) => s.color !== mine.color && !gs!.ranks.includes(s.color) && !gs!.surrendered?.includes(s.color)).length;
          const foes = gs!.seats.filter((s) => s.color !== mine.color && s.color !== TEAMMATE[mine.color]).map((s) => s.username);
          const what = gs!.teams
            ? `Your team concedes: the match ends now and ${foes.join(' & ')} win.`
            : others <= 1
              ? 'The match ends now and the others win.'
              : 'You finish below everyone still playing, your tokens go back to base, and you can watch the rest.';
          if (!(await confirmDialog('Surrender?', what, '🏳️ Surrender', true))) return;
          const r = await emit('game:surrender', { gameId: gs!.id, actionId: uuid() });
          if (!r.ok) showError(r.error);
        });
      }
      item('🚪 Leave game for good', async () => {
        if (!(await confirmDialog('Leave the game?', 'A bot will play your seat until the end. You cannot come back to this game.', 'Leave', true))) return;
        const r = await emit('lobby:leave', {});
        if (!r.ok) showError(r.error);
        update({ game: null });
        go('home');
      });
    }
  }

  installMoustacheDefs();
  setGameHandler(onUpdate);
  renderAll();
  warnThreatened(false);
  if (gs.finished) queueMicrotask(() => go('results'));

  // Repaint the mic badges and signal bars when the channel, our peer connections or pings change.
  const repaintVoice = () => {
    if (gs && !destroyed) renderChips();
  };
  const offVoice = voice.onChange(repaintVoice);
  const offStore = subscribe((changed) => (changed.includes('voice') || changed.includes('net')) && repaintVoice());

  return () => {
    destroyed = true;
    setTempo(1);
    setGameHandler(null);
    ro.disconnect();
    offVoice();
    offStore();
    offFs();
    offMute();
  };
}

/** A small token with its moustache, for the pickers (stacked tokens, wildcard entry). */
function miniToken(color: Color, kills: number): string {
  return `<span class="mini-token t-${color}"><span class="tok-body"></span>${moustacheSvg(moustacheLevel(kills))}</span>`;
}

/** A white flag on a pole, its cloth rippling (SVG path morph; still for reduced motion). */
function whiteFlag(): string {
  const a = 'M11 9 C20 3,29 15,40 9 C45 6,49 7,53 9 L53 35 C49 33,45 32,40 35 C29 41,20 29,11 35 Z';
  const b = 'M11 9 C20 15,29 3,40 9 C45 12,49 11,53 8 L53 34 C49 37,45 38,40 35 C29 29,20 41,11 35 Z';
  const wave = reducedMotion() ? '' : `<animate attributeName="d" dur="1.3s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" values="${a};${b};${a}"/>`;
  return `<svg viewBox="0 0 60 72" aria-hidden="true">
    <rect x="7" y="5" width="4" height="65" rx="2" fill="#8b5a2b"/>
    <circle cx="9" cy="5" r="4" fill="#f5b400"/>
    <path d="${a}" fill="#fff" stroke="#cbd5e1" stroke-width="1">${wave}</path>
    <path d="${a}" fill="url(#flag-fold)" opacity=".5">${wave.replace('dur="1.3s"', 'dur="1.3s" begin="-0.2s"')}</path>
    <defs><linearGradient id="flag-fold" x1="0" x2="1"><stop offset="0" stop-color="#94a3b8" stop-opacity="0"/><stop offset=".35" stop-color="#94a3b8" stop-opacity=".7"/><stop offset=".6" stop-color="#94a3b8" stop-opacity="0"/><stop offset=".85" stop-color="#94a3b8" stop-opacity=".6"/><stop offset="1" stop-color="#94a3b8" stop-opacity="0"/></linearGradient></defs>
  </svg>`;
}
