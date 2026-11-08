// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE as B, HOME as H } from '../../../src/shared/board.js';
import { applyMove, applyRespawn, applyRoll, applySurrender, createGameState, legalMoves } from '../../../src/shared/rules.js';
import type { RollUpdate } from '../../../src/shared/protocol.js';
import type { Color, GameEvent, GameState, PublicGameState } from '../../../src/shared/types.js';
import { click, flush, modalButton, setupDom, toasts, topModal } from './harness.js';
import { replies, resetNet, sentOf } from './fakeNet.js';

vi.mock('../../../src/client/net.js', () => import('./fakeNet.js'));
const app = vi.hoisted(() => ({
  handler: null as null | ((u: { state: PublicGameState; events?: GameEvent[] }) => void),
  roll: null as null | ((u: RollUpdate) => void),
  errors: [] as string[],
  resyncs: 0,
}));
vi.mock('../../../src/client/app.js', () => ({
  setGameHandler: (fn: typeof app.handler) => (app.handler = fn),
  setRollHandler: (fn: typeof app.roll) => (app.roll = fn),
  showError: (code: string) => app.errors.push(code),
  resyncGame: () => void app.resyncs++,
}));
const sounds = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/client/sound.js', () => ({ play: (s: string) => sounds.push(s), isMuted: () => false, setMuted: vi.fn(), unlock: vi.fn(), installUnlockListeners: vi.fn(), audioContext: () => null }));

let go: typeof import('../../../src/client/router.js').go;
let store: typeof import('../../../src/client/store.js');
const shown: string[] = [];

beforeAll(async () => {
  setupDom();
  const router = await import('../../../src/client/router.js');
  go = router.go;
  store = await import('../../../src/client/store.js');
  const { gameScreen } = await import('../../../src/client/screens/game.js');
  router.register('game', gameScreen);
  for (const name of ['home', 'results', 'lobby']) router.register(name, () => void shown.push(name));
});

const seat = (color: Color, userId: number | null, name: string, controller: 'human' | 'bot' | 'takeover' = 'human') => ({ color, userId, username: name, controller, connected: true });
const pub = (s: GameState): PublicGameState => ({ ...structuredClone(s), legalMoves: legalMoves(s), serverNow: Date.now() });

/** A game on the board: alice (red, user 1) against bob (green, user 2), or Team-up with two bots. */
function newGame(opts: { teams?: boolean; share?: boolean; me?: number; aliceController?: 'human' | 'takeover' } = {}): GameState {
  const seats = opts.teams
    ? [seat('red', 1, 'alice', opts.aliceController), seat('green', null, 'Bot Green', 'bot'), seat('yellow', 2, 'bob'), seat('blue', null, 'Bot Blue', 'bot')]
    : [seat('red', 1, 'alice', opts.aliceController), seat('green', 2, 'bob')];
  return createGameState({ id: `g${Math.random()}`, lobbyId: 'L', seats, firstSeat: 0, now: 0, teams: opts.teams, share: opts.share });
}

let current: GameState;
function mount(s: GameState, me = 1): void {
  current = s;
  store.update({ user: { id: me, username: me === 1 ? 'alice' : 'someone' }, game: pub(s), lobby: { id: 'L', name: 'Fam', hostId: 1, status: 'playing', members: [], spectators: [], gameId: s.id, teams: Boolean(s.teams), size: s.board ?? 4 } });
  go('home');
  document.getElementById('app')!.innerHTML = ''; // the screen that left would linger 220 ms
  go('game');
}

/** Applies a rules change to the current game and sends it to the screen, as the server would. */
async function step(change: (s: GameState) => GameEvent[], wait = 600): Promise<GameEvent[]> {
  const next = structuredClone(current);
  const events = change(next);
  next.version++;
  current = next;
  app.handler!({ state: pub(next), events });
  await flush(wait);
  return events;
}
/** Sends the game as it is now, without events (a resync). */
function resync(s: GameState): void {
  current = s;
  app.handler!({ state: pub(s) });
}
// The label can go on with the token's power or golden crown: "red token 1 (Shield)".
const token = (color: Color, id: number) => document.querySelector<HTMLButtonElement>(`.token.t-${color}[aria-label^="${color} token ${id + 1}"]`)!;
const hint = () => document.querySelector('#hint')!.textContent;

beforeEach(() => {
  resetNet();
  sounds.length = 0;
  app.errors.length = 0;
  document.getElementById('toasts')!.innerHTML = '';
  document.getElementById('modal-root')!.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

describe('the board and the dock', () => {
  it('keeps the name in its own ellipsis span, apart from the "you" tag', () => {
    const g = newGame();
    g.seats[0]!.username = 'a-very-long-player-name-that-will-not-fit-in-the-chip';
    mount(g);
    const pn = document.querySelector('.pchip[data-color=red] .pn')!;
    expect(pn.querySelector('.pn-name')!.textContent).toBe('a-very-long-player-name-that-will-not-fit-in-the-chip');
    expect(pn.querySelector('.pn-name em')).toBeNull();
    expect(pn.querySelector(':scope > em')!.textContent).toBe('you');
  });

  it('shows each player\'s animal on their chip, updates when it changes, and keeps the initial without one', async () => {
    const g = newGame();
    g.seats[0]!.avatar = 'fox';
    mount(g);
    const dot = (c: string) => document.querySelector(`.pchip[data-color=${c}] .pchip-dot`)!;
    expect(dot('red').textContent).toBe('🦊');
    expect(dot('red').classList.contains('has-avatar')).toBe(true);
    expect(dot('green').textContent).toBe(g.seats[1]!.username[0]!.toUpperCase());
    expect(dot('green').classList.contains('has-avatar')).toBe(false);
    await step((next) => {
      next.seats[0]!.avatar = 'owl';
      return [];
    }, 50);
    expect(dot('red').textContent).toBe('🦉');
  });

  it('shows every player, whose turn it is, and rolls with a tap on the dice', async () => {
    mount(newGame());
    expect(document.querySelectorAll('.pchip:not(.pchip-empty)')).toHaveLength(2);
    expect(document.querySelector('.pchip[data-color=red] .pn')!.textContent).toContain('alice');
    expect(document.querySelector('#banner')!.textContent).toBe('Your turn');
    expect(hint()).toBe('Tap the dice to roll');
    click('#dice-slot .dice');
    await flush();
    expect(sentOf('game:roll')).toEqual([{ gameId: current.id, version: current.version, actionId: expect.any(String) }]);
    expect(document.querySelectorAll('.token')).toHaveLength(8);
  });

  it('plays a roll, a move out of base and the next turn as they arrive', async () => {
    mount(newGame());
    current.tokens.red = [B, B, B, B];
    await step((s) => applyRoll(s, 6));
    expect(sounds).toContain('dice');
    expect(document.querySelector('#floor-fire')).not.toBeNull();
    await step((s) => applyRoll(s, 2));
    expect(hint()).toBe('Moving with the highlighted die · tap another die to switch');
    expect(document.querySelectorAll('#queue .qchip')).toHaveLength(2);
    // Two dice, but from base only the 6 can move anything: the 2 is greyed out and can't be picked.
    const chips = document.querySelectorAll<HTMLButtonElement>('#queue .qchip');
    expect([chips[0].classList.contains('selected'), chips[1].disabled, chips[1].classList.contains('dim')]).toEqual([true, true, true]);
    token('red', 0).click();
    await flush();
    expect(sentOf('game:move')).toEqual([{ gameId: current.id, version: current.version, actionId: expect.any(String), dieIndex: 0, tokenId: 0 }]);
    await step((s) => applyMove(s, 0, 0));
    await step((s) => applyMove(s, 0, 0));
    expect(sounds).toContain('step');
    expect(document.querySelector('#banner')!.textContent).toBe("bob's turn");
    expect(hint()).toBe('Waiting for bob…');
  });

  it('three sixes: the turn is lost; a useless roll says so', async () => {
    mount(newGame());
    current.tokens.red = [10, B, B, B];
    await step((s) => applyRoll(s, 6), 100);
    await step((s) => applyRoll(s, 6), 100);
    await step((s) => applyRoll(s, 6), 400);
    expect(sounds).toContain('penalty');
    expect(document.querySelector('.callout')?.textContent).toContain('3 sixes!');
    resync(newGame()); // a fresh game (another id) snaps straight to it
    await flush();
  });

  it('a capture (first blood) and a token reaching home', async () => {
    const g = newGame();
    g.tokens.red = [27, 54, B, B];
    g.tokens.green = [18, B, B, B]; // green's 18 is absolute 31
    mount(g);
    await step((s) => applyRoll(s, 4), 100);
    await step((s) => applyMove(s, 0, 0), 900);
    expect(sounds).toEqual(expect.arrayContaining(['capture', 'firstBlood']));
    expect(current.tokens.green[0]).toBe(B);
    expect(document.querySelector(`.token.t-red[aria-label="red token 1"]`)!.getAttribute('data-want')).toBe('1');
    await step((s) => applyRoll(s, 2), 100);
    await step((s) => applyMove(s, 0, 1), 400);
    expect(sounds).toContain('home');
    expect(toasts().some((t) => t!.includes('hold your tokens at home'))).toBe(true);
  });

  it('a finish, the game over, then the results', async () => {
    const g = newGame();
    g.tokens.red = [H, H, H, 55];
    mount(g);
    await step((s) => applyRoll(s, 1), 100);
    await step((s) => applyMove(s, 0, 3), 800);
    expect(toasts()).toContain('alice finished 🥇');
    expect(sounds).toContain('win');
    expect(shown.at(-1)).toBe('results');
  });

  it('a surrender raises a white flag over that base', async () => {
    const g = createGameState({ id: 'gs', lobbyId: 'L', seats: [seat('red', 1, 'alice'), seat('green', 2, 'bob'), seat('blue', 3, 'carol')], firstSeat: 0, now: 0 });
    g.tokens.green = [12, B, B, B];
    mount(g);
    await step((s) => applySurrender(s, 'green'), 900);
    expect(toasts()).toContain('bob surrendered 🏳️');
    expect(document.querySelectorAll('#flags .surrender-flag.f-green')).toHaveLength(1);
    expect(document.querySelector('.pchip[data-color=green] .pchip-sub')!.textContent).toBe('🏳️ surrendered');
  });

  it('a timer that ran out, and a takeover bot you can send away', async () => {
    const g = newGame({ aliceController: 'takeover' });
    mount(g);
    expect(document.querySelector<HTMLElement>('#takeback')!.hidden).toBe(false);
    click('#takeback');
    await flush();
    expect(sentOf('game:takeback')).toEqual([{ gameId: g.id }]);
    const t = newGame();
    t.turn.auto = true;
    t.seats[0].timeouts = 2;
    resync(t);
    await flush(50);
    expect(hint()).toContain("Time's up");
    expect(document.querySelector('.pchip[data-color=red] .pchip-sub')!.textContent).toBe('missed 2/5');
  });

  it('watching from the side: nothing to tap, and the menu offers to stop watching', async () => {
    mount(newGame(), 9);
    expect(hint()).toContain('👀 Watching');
    click('#menu');
    const items = [...document.querySelectorAll('.menu-item')].map((b) => b.textContent);
    expect(items).toContain('🚪 Stop watching (leave the lobby)');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Stop watching'))!.click();
    await flush();
    expect(sentOf('lobby:leave')).toHaveLength(1);
  });

  it('the menu: surrender (asked first) and leaving for good', async () => {
    mount(newGame());
    click('#menu');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Surrender'))!.click();
    await flush(10);
    expect(topModal().querySelector('p')!.textContent).toBe('The match ends now and the others win.');
    modalButton('🏳️ Surrender');
    await flush(10);
    expect(sentOf('game:surrender')).toHaveLength(1);
    click('#menu');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Leave game'))!.click();
    await flush(10);
    modalButton('Leave');
    await flush(10);
    expect(sentOf('lobby:leave')).toHaveLength(1);
    click('#sound');
  });
});

/** A finger lifting, then the time after which a click is no longer the tap's own. */
async function lift(): Promise<void> {
  document.dispatchEvent(new Event('pointerup'));
  await new Promise((r) => setTimeout(r, 450));
}

describe('choosing a token', () => {
  it('turn sharing: my token and my teammate\'s on the same safe square: one bubble to choose which to move', async () => {
    const g = newGame({ teams: true, share: true });
    g.tokens.red = [34, B, B, B]; // red's square 34 is yellow's 8: the same star
    g.tokens.yellow = [8, 20, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    // Whichever of the two is tapped, the bubble has both, mine first, in their own colours.
    token('yellow', 0).click();
    await flush();
    const bubble = document.querySelector<HTMLElement>('#bubbles .stack-bubble')!;
    expect(bubble).not.toBeNull();
    const opts = [...bubble.querySelectorAll<HTMLElement>('.stack-opt')];
    expect(opts.map((o) => [o.dataset.color, o.dataset.token, o.classList.contains('mate')])).toEqual([
      ['red', '0', false],
      ['yellow', '0', true],
    ]);
    expect(opts[1].getAttribute('aria-label')).toMatch(/bob's Clean-shaven \(your teammate\)$/);
    expect(opts[1].querySelector('.mini-token')!.classList.contains('t-yellow')).toBe(true);
    // Choosing the teammate's moves it, with its colour; the other yellow token (elsewhere) is not in the bubble.
    click('.stack-opt[data-color="yellow"]');
    await flush();
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 0, color: 'yellow' });
    // And the same bubble from the other side: tapping mine.
    token('red', 0).click();
    await flush();
    expect(document.querySelectorAll('#bubbles .stack-opt')).toHaveLength(2);
    click('.stack-opt[data-color="red"]');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 0 });
    expect(sentOf('game:move').at(-1)).not.toHaveProperty('color');
  });

  it('without turn sharing a teammate on my square is nothing to choose: my token just moves', async () => {
    const g = newGame({ teams: true });
    g.tokens.red = [34, B, B, B];
    g.tokens.yellow = [8, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 0).click();
    await flush();
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0 });
  });

  it('stacked tokens with different moustaches: a small bubble on the square with both, and no words', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, B, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 1).click();
    await flush();
    // A bubble over the board, not a sheet: no dialog, no title, no captions.
    expect(document.querySelector('.modal')).toBeNull();
    const bubble = document.querySelector<HTMLElement>('#bubbles .stack-bubble')!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent!.trim()).toBe('');
    const cards = [...bubble.querySelectorAll<HTMLElement>('.stack-opt')].map((c) => [c.dataset.token, c.getAttribute('aria-label')]);
    expect(cards).toEqual([
      ['0', '3 captures'],
      ['1', 'Clean-shaven'],
    ]);
    click('.stack-opt[data-token="1"]');
    await flush();
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 1 });
    // The game moving on (a newer version, e.g. the timer played the turn) closes a bubble that is still open.
    token('red', 0).click();
    await flush();
    expect(document.querySelector('.stack-bubble')).not.toBeNull();
    const next = structuredClone(current);
    next.version++;
    resync(next);
    expect(document.querySelector('.stack-bubble')).toBeNull();
  });

  it('the token bubble closes on Escape and on a tap outside it, and a tap inside does not close it early', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, B, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    const open = async () => {
      token('red', 1).click();
      await flush();
      expect(document.querySelector('.stack-bubble')).not.toBeNull();
    };
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(sentOf('game:move')).toHaveLength(0);
    await open();
    document.querySelector('.stack-bubble')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.stack-bubble')).not.toBeNull();
    document.querySelector('#board')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(sentOf('game:move')).toHaveLength(0);
    await lift(); // (the click swallowed after a tap outside ends here)
  });

  it('a tap outside closes the bubble and does not also press what is under it', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, 20, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 1).click();
    await flush();
    expect(document.querySelector('.stack-bubble')).not.toBeNull();
    // A real tap on another token that could move: pointerdown, pointerup, click.
    const other = token('red', 2);
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    other.dispatchEvent(new Event('pointerup', { bubbles: true }));
    other.click();
    await flush();
    expect(sentOf('game:move')).toHaveLength(0);
    // Only that one click is swallowed: the next tap works.
    await lift();
    other.click();
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 2 });
  });

  it('tapping the stacked token again closes its bubble instead of reopening it', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, B, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 1).click();
    await flush();
    const again = token('red', 1);
    again.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    again.dispatchEvent(new Event('pointerup', { bubbles: true }));
    again.click();
    await flush();
    expect(document.querySelector('.stack-bubble')).toBeNull();
    await lift();
  });

  it('the bubble stays through a resize (address bar, rotation), takes focus, and Escape gives it back', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, B, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 1).click();
    await flush();
    window.dispatchEvent(new Event('resize'));
    expect(document.querySelector('.stack-bubble')).not.toBeNull();
    expect((document.activeElement as HTMLElement).classList.contains('stack-opt')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    expect(document.activeElement).toBe(token('red', 1));
  });

  it('at its home turn: a small bubble with head home or go round again, or the board markers', async () => {
    const g = newGame();
    g.tokens.red = [48, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 5), 200);
    token('red', 0).click();
    await flush();
    // A bubble on the square, not a sheet: two pictures (gold house, blue arrow) and no words.
    expect(document.querySelector('.modal')).toBeNull();
    const bubble = document.querySelector<HTMLElement>('#bubbles .stack-bubble')!;
    expect(bubble).not.toBeNull();
    // No words on screen, so the labels carry what each way means: the distance, and the price of another lap.
    const labels = [...bubble.querySelectorAll('.lap-opt')].map((b) => b.getAttribute('aria-label'));
    expect(labels[0]).toMatch(/^Head home, \d+ squares? to finish$/);
    expect(labels[1]).toBe("Go round again, uses this token's extra lap so it can't make a wildcard entry later");
    expect([...bubble.querySelectorAll('.lap-opt')].map((b) => b.getAttribute('title'))).toEqual(labels);
    expect(bubble.textContent!.replace(/\s/g, '')).toBe('🏠↻');
    click('.lap-opt.round');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: true });
    expect(document.querySelector('.stack-bubble')).toBeNull();
    click('#targets .target.home[data-token]');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: false });
  });

  it('the home / round bubble: head home from it, close it with a tap outside (moving nothing), and a gold marker closes it', async () => {
    const g = newGame();
    g.tokens.red = [48, 20, B, B];
    mount(g);
    await step((s) => applyRoll(s, 5), 200);
    token('red', 0).click();
    await flush();
    click('.lap-opt.home');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: false });
    const moves = sentOf('game:move').length;
    // A tap outside (on another token that could move) only closes the bubble.
    token('red', 0).click();
    await flush();
    expect(document.querySelector('.stack-bubble')).not.toBeNull();
    const other = token('red', 1);
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    other.dispatchEvent(new Event('pointerup', { bubbles: true }));
    other.click();
    await flush();
    expect(sentOf('game:move')).toHaveLength(moves);
    await lift();
    // Tapping a marker on the board closes an open bubble and chooses that way, with a real tap
    // (pointerdown, pointerup, click): the dismissing tap must not swallow the marker's click.
    token('red', 0).click();
    await flush();
    const marker = document.querySelector<HTMLElement>('#targets .target.round[data-token="0"]')!;
    marker.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.stack-bubble')).toBeNull();
    marker.dispatchEvent(new Event('pointerup', { bubbles: true }));
    marker.click();
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: true });
    expect(sentOf('game:move')).toHaveLength(moves + 1);
  });

  it('two dice that can both move: the one picked is used', async () => {
    const g = newGame();
    g.tokens.red = [10, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 6), 100);
    await step((s) => applyRoll(s, 3), 200);
    const chips = document.querySelectorAll<HTMLButtonElement>('#queue .qchip');
    chips[1].click();
    expect(document.querySelectorAll('#queue .qchip')[1].classList.contains('selected')).toBe(true);
    token('red', 0).click();
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 1, tokenId: 0 });
  });
});

describe('Team-up on the board', () => {
  it('partners get a badge, the line-up is announced, and friendly fire is played without a question (the banner still shows)', async () => {
    const g = newGame({ teams: true });
    g.tokens.red = [13, 30, B, B];
    g.tokens.yellow = [41, B, B, B];
    mount(g);
    expect(toasts()).toContain('Team-up: you & bob vs Bot Green & Bot Blue');
    const mate = document.querySelector<HTMLElement>('.pchip[data-color=red] .pchip-mate')!;
    expect([mate.hidden, mate.className, mate.title]).toEqual([false, 'pchip-mate m-yellow', 'Teammate: bob']);
    await step((s) => applyRoll(s, 2), 200);
    token('red', 0).click();
    await flush(10);
    // Players know the rule: no "Capture your teammate?" question, the move goes straight out.
    expect(document.querySelector('.modal')).toBeNull();
    expect(sentOf('game:move')).toEqual([expect.objectContaining({ tokenId: 0, dieIndex: 0 })]);
    await step((s) => applyMove(s, 0, 0), 900);
    expect(sounds).toContain('friendlyFire');
    expect([...document.querySelectorAll('.callout b')].map((b) => b.textContent)).toContain('Friendly fire!');
  });

  it('a partner home says so; surrendering concedes for the team', async () => {
    const g = newGame({ teams: true });
    g.tokens.red = [H, H, H, 55];
    mount(g);
    await step((s) => applyRoll(s, 1), 100);
    await step((s) => applyMove(s, 0, 3), 300);
    expect(toasts()).toContain('alice has all 4 home 🏠');
    expect(document.querySelector('.pchip[data-color=red] .pchip-sub')!.textContent).toBe('✓ all home');
    const t = newGame({ teams: true });
    mount(t);
    click('#menu');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Surrender'))!.click();
    await flush(10);
    expect(topModal().querySelector('p')!.textContent).toBe('Your team concedes: the match ends now and Bot Green & Bot Blue win.');
  });
});

describe('the wildcard entry', () => {
  const pointer = (type: string) => document.querySelector('#holds .home-hold')!.dispatchEvent(new Event(type, { bubbles: true }));

  it('a short tap says to hold; holding opens the sheet; sending asks the server', async () => {
    const g = newGame();
    g.tokens.red = [H, H, 10, B];
    g.kills = { red: [2, 0, 0, 0] };
    mount(g);
    expect(document.querySelector('#holds .home-hold.h-red')).not.toBeNull();
    pointer('pointerdown');
    pointer('pointerup');
    expect(toasts()).toContain('Hold your home tokens to send one back: a wildcard entry 🃏');
    pointer('pointerdown');
    await flush(550);
    expect(document.querySelector('.wildcard-sheet')).not.toBeNull();
    expect([...document.querySelectorAll('.wc-card small')].map((s) => s.textContent)).toEqual(['2 captures 🥸', 'Clean-shaven']);
    const send = document.querySelector<HTMLButtonElement>('.wc-send')!;
    expect(send.disabled).toBe(true);
    click('.wc-card[data-token="0"]');
    click('.wc-card[data-token="1"]');
    click('.wc-card[data-token="1"]'); // and back off
    expect(document.querySelector('.wc-send')!.textContent).toBe('🃏 Send back (1)');
    click('.wc-send');
    await flush();
    expect(sentOf('game:respawn')).toEqual([{ gameId: g.id, actionId: expect.any(String), tokens: 0b1 }]);
  });

  it('everyone sees it: the banner, the flight back to base, and a finished player giving up their place', async () => {
    const g = createGameState({ id: 'gw', lobbyId: 'L', seats: [seat('red', 1, 'alice'), seat('green', 2, 'bob'), seat('blue', 3, 'carol')], firstSeat: 1, now: 0 });
    g.tokens.green = [H, H, H, H];
    g.ranks = ['green'];
    mount(g);
    await step((s) => applyRespawn(s, 'green', [0]), 50);
    const banner = document.querySelector('.wildcard-banner')!;
    expect(banner.textContent!.replace(/\s+/g, ' ').trim()).toBe('Wildcard entry bob is back for more · beware!');
    expect(sounds).toContain('wildcard');
    await flush(900);
    expect(toasts()).toContain('bob gave up 🥇 for a wildcard entry!');
    expect(sounds).toContain('land');
    expect(token('green', 0).classList.contains('lap2')).toBe(true); // on its last lap now
    expect(document.querySelector('.pchip[data-color=green] .pchip-sub')!.textContent).toBe('3/4 home');
  });

  it('the menu has it too, and the sheet updates or closes as the game goes on', async () => {
    const g = newGame();
    g.tokens.red = [H, H, H, H];
    g.extraLaps = { red: [1, 0, 1, 1] };
    g.ranks = [];
    mount(g);
    click('#menu');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent === '🃏 Wildcard entry (1 at home)')!.click();
    await flush(10);
    expect([...document.querySelectorAll<HTMLElement>('.wc-card')].map((c) => c.dataset.token)).toEqual(['1']);
    // The token is no longer home (used elsewhere): nothing left to pick, the sheet closes.
    const next = structuredClone(current);
    next.tokens.red[1] = B;
    next.extraLaps = { red: [1, 1, 1, 1] };
    resync(next);
    await flush(300);
    expect(document.querySelector('#holds .home-hold')).toBeNull();
  });
});

describe('whose dice shows where', () => {
  const dockHidden = () => document.querySelector('#dice-slot')!.classList.contains('dice-hidden');
  const base = () => document.querySelector<HTMLElement>('.base-dice')!;

  it('my turn: the dock dice, tappable; nothing on the board', async () => {
    mount(newGame());
    expect(dockHidden()).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#dice-slot .dice')!.disabled).toBe(false);
    expect(base().classList.contains('dice-hidden')).toBe(true);
    current.tokens.red = [0, B, B, B];
    await step((s) => applyRoll(s, 6));
    expect([dockHidden(), base().classList.contains('dice-hidden')]).toEqual([false, true]);
  });

  it('someone else’s turn: no dock dice, theirs rolls over their base; the queue and effects still show', async () => {
    mount(newGame(), 2); // bob watches alice (red) roll
    expect(dockHidden()).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#dice-slot .dice')!.disabled).toBe(true);
    expect(base().classList.contains('dice-hidden')).toBe(false);
    expect(base().querySelector<HTMLElement>('.dice')!.dataset.color).toBe('red');
    // Over red's base: the top left quarter of the board.
    expect(parseFloat(base().style.left)).toBeLessThan(30);
    expect(parseFloat(base().style.top)).toBeLessThan(30);
    current.tokens.red = [0, B, B, B];
    await step((s) => applyRoll(s, 6));
    expect(sounds).toContain('dice');
    expect(sounds).toContain('six');
    expect(dockHidden()).toBe(true);
    expect(document.querySelectorAll('#queue .qchip')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('#queue .qchip')!.disabled).toBe(true);
    await step((s) => applyRoll(s, 6));
    // Three sixes: the sad face pops up on the board dice, not in the dock.
    const sad: string[] = [];
    const watch = new MutationObserver(() => document.querySelectorAll('.dice-emoji.show').forEach((e) => sad.push(e.parentElement!.className)));
    document.querySelectorAll('.dice-emoji').forEach((e) => watch.observe(e, { attributes: true }));
    await step((s) => applyRoll(s, 6), 800);
    watch.disconnect();
    expect(sounds).toContain('penalty');
    expect(sad.length).toBeGreaterThan(0);
    expect(sad.every((c) => c.startsWith('base-dice'))).toBe(true);
  });

  it('a slim roll update plays like a full one; one that doesn’t follow on asks for the whole state', async () => {
    mount(newGame(), 2);
    current.tokens.red = [0, B, B, B];
    const next = structuredClone(current);
    const events = applyRoll(next, 3);
    next.version++;
    app.roll!({ id: next.id, version: next.version, serverNow: Date.now(), turn: next.turn, events });
    await flush(600);
    expect(sounds).toContain('dice');
    expect(document.querySelectorAll('#queue .qchip')).toHaveLength(1);
    current = next;
    app.roll!({ id: next.id, version: next.version + 5, serverNow: Date.now(), turn: next.turn, events });
    expect(app.resyncs).toBe(1);
  });
});

describe('5 and 6 players', () => {
  const big = (n: 5 | 6, me = 1) => {
    const colors = n === 5 ? (['red', 'green', 'yellow', 'blue', 'purple'] as Color[]) : (['red', 'green', 'yellow', 'blue', 'orange', 'purple'] as Color[]);
    const s = createGameState({ id: `g${Math.random()}`, lobbyId: 'L', seats: colors.map((c, i) => seat(c, i + 1, `p${i + 1}`)), firstSeat: 0, now: 0, board: n });
    mount(s, me);
    return s;
  };

  it.each([5, 6] as const)('the %i-player board: its squares, a card per seat, the board’s shape', (n) => {
    big(n);
    expect(document.querySelectorAll('.board-svg polygon.cell')).toHaveLength(13 * n + 5 * n);
    expect(document.querySelectorAll('.pchip:not(.pchip-empty)')).toHaveLength(n);
    expect(document.querySelectorAll('.players-3')).toHaveLength(n === 5 ? 1 : 2);
    expect(document.querySelectorAll('.token')).toHaveLength(4 * n);
    const board = document.querySelector<HTMLElement>('#board')!;
    expect(board.classList.contains(`board-${n}`)).toBe(true);
    expect(Number(board.style.getPropertyValue('--bw'))).toBeGreaterThan(15);
  });

  it('a move, a capture and someone else’s roll on the 6-player board', async () => {
    const s = big(6, 2);
    s.tokens.red = [0, B, B, B];
    s.tokens.purple = [78 - 65 + 3, B, B, B]; // purple starts at 65 of 78: this is square 3, three ahead of red's start
    await step((x) => applyRoll(x, 3));
    expect(document.querySelector<HTMLElement>('.base-dice .dice')!.dataset.color).toBe('red');
    await step((x) => applyMove(x, 0, 0), 1500);
    expect(current.tokens.purple[0]).toBe(B);
    expect(sounds).toContain('capture');
    expect(document.querySelector('#banner')!.textContent).toBe("p1's turn"); // a capture earns a bonus roll
  });
});

describe('tap and hold on a player card: their volume, for you only', () => {
  const chip = (c: Color) => document.querySelector<HTMLElement>(`.pchip[data-color=${c}]`)!;
  const bubble = () => document.querySelector<HTMLElement>('.bubble-screen .stack-bubble');
  const voiceState = (...ids: number[]) =>
    store.update({ voice: { lobbyId: 'L', enabled: true, epoch: 0, bitrateKbps: 6, participants: ids.map((userId) => ({ userId, muted: false })) } });
  const press = (el: Element, x = 10, y = 10) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
  const release = () => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  const hold = async (el: Element) => {
    press(el);
    await flush(520);
  };
  let volume: typeof import('../../../src/client/listenVolume.js');
  let voiceClient: typeof import('../../../src/client/voice.js').voice;

  beforeAll(async () => {
    volume = await import('../../../src/client/listenVolume.js');
    voiceClient = (await import('../../../src/client/voice.js')).voice;
  });
  beforeEach(() => {
    volume.resetListenVolume();
    localStorage.clear();
    voiceClient.enabled = true;
    voiceState(1, 2);
  });
  afterEach(() => {
    document.querySelectorAll('.bubble-screen').forEach((b) => b.remove());
  });

  it('holding another player\'s card opens the comic-book bubble with four volumes and says it is only for you', async () => {
    mount(newGame());
    await hold(chip('green'));
    const b = bubble()!;
    expect(b).not.toBeNull();
    expect(b.querySelector('.bubble-cap')!.textContent).toBe('bob · only for you');
    const opts = [...b.querySelectorAll<HTMLButtonElement>('.bubble-opt')];
    expect(opts.map((o) => o.dataset.vol)).toEqual(['1', '0.6', '0.3', '0']);
    expect(opts.map((o) => o.getAttribute('aria-label'))).toEqual(['Hear bob at 100%', 'Hear bob at 60%', 'Hear bob at 30%', 'Mute bob for me']);
    // Where they are now is marked, and is where the keyboard starts.
    expect(opts.map((o) => o.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    expect(document.activeElement).toBe(opts[0]);
  });

  it('choosing a volume changes it on this phone only, shows a speaker beside their name, and is remembered', async () => {
    mount(newGame());
    await hold(chip('green'));
    bubble()!.querySelector<HTMLButtonElement>('[data-vol="0.3"]')!.click();
    expect(bubble()).toBeNull();
    expect(volume.volumeOf(2)).toBe(0.3);
    expect(volume.volumeOf(1)).toBe(1);
    // Nothing goes to the server: nobody else's volume changes.
    expect(sentOf('voice:mute')).toHaveLength(0);
    expect(chip('green').querySelector('.vc-vol')!.getAttribute('aria-label')).toBe('You hear them at 30%');
    // The card still reads as its own content (name, homes, ping, turn); the volume is only its description.
    expect(chip('green').hasAttribute('aria-label')).toBe(false);
    expect(chip('green').querySelector('.pn-name')!.textContent).toBe('bob');
    expect(document.getElementById(chip('green').getAttribute('aria-describedby')!)!.textContent).toContain('Voice volume 30%');
    expect(document.getElementById('pvh-green')!.getAttribute('aria-hidden')).toBe('true');
    expect(chip('red').querySelector('.vc-vol')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ludo.listenVolume.1')!)).toEqual({ '2': 0.3 });
    // Held again: 30% is the one marked.
    await hold(chip('green'));
    expect(bubble()!.querySelector('[aria-pressed="true"]')!.getAttribute('data-vol')).toBe('0.3');
    bubble()!.querySelector<HTMLButtonElement>('[data-vol="0"]')!.click();
    expect(chip('green').querySelector('.vc-vol')!.classList.contains('vc-vol-off')).toBe(true);
    expect(chip('green').querySelector('.vc-vol')!.getAttribute('aria-label')).toBe('You muted them');
    await hold(chip('green'));
    bubble()!.querySelector<HTMLButtonElement>('[data-vol="1"]')!.click();
    expect(chip('green').querySelector('.vc-vol')).toBeNull();
    expect(localStorage.getItem('ludo.listenVolume.1')).toBeNull();
  });

  it('a short tap, or a finger that moves, does not open it; the lifting finger after a hold does not also tap', async () => {
    mount(newGame());
    press(chip('green'));
    await flush(200);
    release();
    await flush(400);
    expect(bubble()).toBeNull();
    press(chip('green'), 10, 10);
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 10 }));
    await flush(520);
    expect(bubble()).toBeNull();
    release();
    // A real hold: the click that follows the lift is swallowed.
    await hold(chip('green'));
    expect(bubble()).not.toBeNull();
    release();
    const clicks: Element[] = [];
    document.addEventListener('click', (e) => clicks.push(e.target as Element));
    chip('green').click();
    expect(clicks).toHaveLength(0);
    chip('green').click();
    expect(clicks).toHaveLength(1);
  });

  it('when no click follows a hold, the next real tap is not swallowed', async () => {
    mount(newGame());
    await hold(chip('green'));
    release(); // (the finger slid off the card: no click comes)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // (the bubble would take the next tap itself)
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    const clicks: Element[] = [];
    document.addEventListener('click', (e) => clicks.push(e.target as Element));
    document.querySelector<HTMLElement>('#board')!.click();
    expect(clicks).toHaveLength(1);
    // And with no new touch at all, it stops waiting a moment after the lift.
    await hold(chip('green'));
    release();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(450);
    document.querySelector<HTMLElement>('#board')!.click();
    expect(clicks).toHaveLength(2);
  });

  it('is not offered on your own card, on a bot, or while voice chat is off', async () => {
    mount(newGame({ teams: true }));
    expect(chip('red').classList.contains('holdable')).toBe(false);
    expect(chip('green').classList.contains('holdable')).toBe(false);
    expect(chip('yellow').classList.contains('holdable')).toBe(true);
    await hold(chip('red'));
    await hold(chip('green'));
    expect(bubble()).toBeNull();
    voiceClient.enabled = false;
    voiceState(1, 2);
    expect(chip('yellow').classList.contains('holdable')).toBe(false);
    expect(chip('yellow').hasAttribute('tabindex')).toBe(false);
  });

  it('a right-click, Enter on the focused card, Escape and a tap elsewhere work without a touch screen', async () => {
    mount(newGame());
    const green = chip('green');
    expect(green.tabIndex).toBe(0);
    green.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(bubble()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bubble()).toBeNull();
    green.focus();
    green.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(bubble()).not.toBeNull();
    // A tap outside only closes it.
    document.querySelector('#board')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(bubble()).toBeNull();
    expect(volume.volumeOf(2)).toBe(1);
  });

  it('closes when the game screen goes away', async () => {
    mount(newGame());
    await hold(chip('green'));
    expect(bubble()).not.toBeNull();
    go('home');
    await flush(300);
    expect(bubble()).toBeNull();
  });
});

describe('the admin\'s next-roll test aid', () => {
  beforeEach(() => document.body.click());
  afterEach(() => store.update({ isAdmin: false, forcedRoll: null }));
  const items = () => [...document.querySelectorAll('.menu-item')].map((b) => b.textContent);

  it('is not in the menu of a player who is not an admin (a host included)', async () => {
    const g = newGame();
    mount(g);
    document.querySelector<HTMLButtonElement>('#menu')!.click();
    await flush(10);
    expect(items().some((t) => t!.includes('Next roll'))).toBe(false);
    expect(document.querySelector('#menu')!.classList.contains('armed')).toBe(false);
  });

  it('an admin picks the next roll in the menu; it is sent only for their game, and shown until used', async () => {
    const g = newGame();
    store.update({ isAdmin: true });
    mount(g);
    document.querySelector<HTMLButtonElement>('#menu')!.click();
    await flush(10);
    expect(items()).toContain('🎲 Next roll: normal');
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Next roll'))!.click();
    await flush(10);
    // Normal and 1 to 6, the current choice marked.
    expect([...document.querySelectorAll('.roll-opt')].map((b) => b.getAttribute('aria-label'))).toEqual(['Normal (chance)', 'Roll 1', 'Roll 2', 'Roll 3', 'Roll 4', 'Roll 5', 'Roll 6']);
    expect(document.querySelector('.roll-opt.on')!.getAttribute('aria-label')).toBe('Normal (chance)');
    document.querySelector<HTMLButtonElement>('.roll-opt[aria-label="Roll 6"]')!.click();
    await flush(10);
    expect(sentOf('game:force')).toEqual([{ gameId: g.id, value: 6 }]);
    expect(store.state.forcedRoll).toEqual({ gameId: g.id, value: 6 });
    expect(document.querySelector('#menu')!.classList.contains('armed')).toBe(true);
    // It shows in the menu, and the picker marks it.
    document.querySelector<HTMLButtonElement>('#menu')!.click();
    await flush(10);
    expect(items()).toContain('🎲 Next roll: 6');
    // The server says it was used (to this phone only): back to normal.
    document.getElementById('modal-root')!.innerHTML = '';
    store.update({ forcedRoll: null });
    expect(document.querySelector('#menu')!.classList.contains('armed')).toBe(false);
  });

  it('a roll set for another game does not show in this one', async () => {
    const g = newGame();
    store.update({ isAdmin: true, forcedRoll: { gameId: 'another', value: 3 } });
    mount(g);
    expect(document.querySelector('#menu')!.classList.contains('armed')).toBe(false);
    document.querySelector<HTMLButtonElement>('#menu')!.click();
    await flush(10);
    expect(items()).toContain('🎲 Next roll: normal');
  });

  it('a refused choice (the server says no) changes nothing', async () => {
    const g = newGame();
    store.update({ isAdmin: true });
    mount(g);
    replies['game:force'] = () => ({ ok: false, error: 'FORBIDDEN' });
    document.querySelector<HTMLButtonElement>('#menu')!.click();
    await flush(10);
    [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].find((b) => b.textContent!.includes('Next roll'))!.click();
    await flush(10);
    document.querySelector<HTMLButtonElement>('.roll-opt[aria-label="Roll 4"]')!.click();
    await flush(10);
    expect(store.state.forcedRoll).toBeNull();
    expect(app.errors).toEqual(['FORBIDDEN']);
  });
});

describe('Team-up with turn sharing on the board', () => {
  // (A tap outside an earlier test's bubble leaves its one-click swallow armed for a moment.)
  beforeEach(() => document.body.click());
  const legal = (c: Color, id: number) => token(c, id).classList.contains('legal');

  it('with sharing, a roll can move my teammate\'s tokens too: they glow, and the move names their colour', async () => {
    const g = newGame({ teams: true, share: true });
    g.tokens.red = [13, B, B, B];
    g.tokens.yellow = [20, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    expect([legal('red', 0), legal('yellow', 0)]).toEqual([true, true]);
    expect(document.querySelector('#hint')!.textContent).toBe("Tap a glowing token, yours or your teammate's");
    token('yellow', 0).click();
    await flush(10);
    expect(sentOf('game:move')).toEqual([{ gameId: g.id, version: expect.any(Number), actionId: expect.any(String), dieIndex: 0, tokenId: 0, color: 'yellow' }]);
    // The move that comes back animates bob's token, and the turn passes on.
    await step((s) => applyMove(s, 0, 0, false, 'yellow'), 900);
    expect(current.tokens.yellow[0]).toBe(23);
    expect(current.tokens.red[0]).toBe(13);
    expect(document.querySelector('#banner')!.textContent).toContain("Bot Green's turn");
  });

  it('a teammate\'s glowing token is marked apart from mine, and both "lands home" markers show', async () => {
    const g = newGame({ teams: true, share: true });
    g.tokens.red = [H - 3, B, B, B];
    g.tokens.yellow = [H - 3, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    expect([legal('red', 0), legal('yellow', 0)]).toEqual([true, true]);
    // Mine glows as before; the teammate's carries the `mate` class (a different ring and motion).
    expect([token('red', 0).classList.contains('mate'), token('yellow', 0).classList.contains('mate')]).toEqual([false, true]);
    // Both can reach home with this roll: each has its marker, in its own home. The partner's is not hidden by mine.
    const targets = [...document.querySelectorAll('.target')].map((t) => [...t.classList].filter((c) => c.startsWith('t-') || c === 'mate').join(' '));
    expect(targets.sort()).toEqual(['t-red', 't-yellow mate']);
  });

  it('my own token is sent without a colour, and without sharing the teammate\'s tokens stay dark', async () => {
    const g = newGame({ teams: true });
    g.tokens.red = [13, B, B, B];
    g.tokens.yellow = [20, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    expect([legal('red', 0), legal('yellow', 0)]).toEqual([true, false]);
    expect(document.querySelector('#hint')!.textContent).toBe('Tap a glowing token');
    token('yellow', 0).click();
    await flush(10);
    expect(sentOf('game:move')).toEqual([]);
    token('red', 0).click();
    await flush(10);
    expect(sentOf('game:move')[0]).not.toHaveProperty('color');

    const shared = newGame({ teams: true, share: true });
    shared.tokens.red = [13, B, B, B];
    shared.tokens.yellow = [20, B, B, B];
    resetNet();
    mount(shared);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 0).click();
    await flush(10);
    expect(sentOf('game:move')[0]).not.toHaveProperty('color');
  });

  it('moving my teammate\'s token onto my own is friendly fire: no question, the move with its colour goes straight out', async () => {
    const g = newGame({ teams: true, share: true });
    g.tokens.red = [49, B, B, B];
    g.tokens.yellow = [20, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('yellow', 0).click();
    await flush(10);
    expect(document.querySelector('.modal')).toBeNull();
    expect(sentOf('game:move')).toEqual([expect.objectContaining({ tokenId: 0, dieIndex: 0, color: 'yellow' })]);
  });

  it('at its home turn my teammate\'s token branches like mine: the markers and the bubble name its colour', async () => {
    const g = newGame({ teams: true, share: true });
    g.tokens.red = [B, B, B, B];
    g.tokens.yellow = [49, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 4), 200);
    const home = document.querySelector<HTMLElement>('#targets .target.home[data-token]')!;
    expect(home.dataset.color).toBe('yellow');
    expect(home.classList.contains('t-yellow')).toBe(true);
    home.click();
    await flush(10);
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 0, color: 'yellow', lap: false });
    resetNet();
    token('yellow', 0).click();
    await flush(10);
    click('.lap-opt.round');
    await flush(10);
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 0, color: 'yellow', lap: true });
  });
});

describe('power ups and the golden token', () => {
  /** alice (red) against bob (green) with power ups and golden tokens (red's 1, green's 2), orbs as given. */
  function powerGame(orbs: GameState['orbs'] = []): GameState {
    const g = createGameState({ id: `g${Math.random()}`, lobbyId: 'L', seats: [seat('red', 1, 'alice'), seat('green', 2, 'bob')], firstSeat: 0, now: 0, powerUps: { seed: 5 }, golden: { red: 1, green: 2 } });
    g.orbs = orbs;
    return g;
  }
  /** What a phone gets: the rules' view for that player (opponents' cloaked tokens hidden). */
  const viewOf = async (s: GameState, color: Color | null) => (await import('../../../src/shared/powers.js')).viewFor(pub(s), color);

  it('the orbs on the stars, the crowned golden tokens, and the rules told once at the start', async () => {
    const g = powerGame([{ square: 8, power: 'double' }, { square: 21, power: 'shield' }, { square: 34, power: 'cloak' }, { square: 47, power: 'thief' }]);
    mount(g);
    await flush(10);
    const orbs = [...document.querySelectorAll<HTMLElement>('#orbs .orb')];
    expect(orbs.map((o) => o.className)).toEqual(['orb o-double', 'orb o-shield', 'orb o-cloak', 'orb o-thief']);
    expect(orbs[3].getAttribute('aria-label')).toContain('Thief orb');
    expect([...document.querySelectorAll('.token.golden')].map((t) => t.getAttribute('aria-label'))).toEqual(['red token 2 (Golden token)', 'green token 3 (Golden token)']);
    expect(document.querySelectorAll('.token.golden .tok-crown')).toHaveLength(2);
    expect(toasts().join(' ')).toContain('Power ups: land on an orb');
    expect(toasts().join(' ')).toContain('Your crowned token leaves base on any roll');
  });

  it('a token takes an orb: the orb goes, the badge comes, and everyone is told what it got', async () => {
    const g = powerGame([{ square: 8, power: 'double' }]);
    g.tokens.red = [5, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    await step((s) => applyMove(s, 0, 0), 2500);
    expect(document.querySelectorAll('#orbs .orb')).toHaveLength(0);
    expect(token('red', 0).classList.contains('pw-double')).toBe(true);
    expect(token('red', 0).querySelector('.tok-badge')!.textContent).toBe('2×');
    expect(token('red', 0).getAttribute('aria-label')).toBe('red token 1 (Double move)');
    expect(sounds).toContain('powerUp');
  });

  it("my cloaked token is see-through for me; for my opponent it isn't on the board, and its capture shows it", async () => {
    const g = powerGame();
    g.tokens.green = [20, B, B, B];
    g.powers = { green: ['cloak', null, null, null] };
    g.tokens.red = [17, 30, B, B];
    current = g;
    // Bob (green) sees his own token.
    store.update({ user: { id: 2, username: 'bob' }, game: await viewOf(g, 'green'), lobby: { id: 'L', name: 'Fam', hostId: 1, status: 'playing', members: [], spectators: [], gameId: g.id, teams: false, size: 4 } });
    go('home');
    document.getElementById('app')!.innerHTML = '';
    go('game');
    await flush(10);
    expect(token('green', 0).classList.contains('unseen')).toBe(false);
    expect(token('green', 0).classList.contains('pw-cloak')).toBe(true);
    // Alice (red) doesn't.
    store.update({ user: { id: 1, username: 'alice' }, game: await viewOf(g, 'red') });
    go('home');
    document.getElementById('app')!.innerHTML = '';
    go('game');
    await flush(10);
    expect(token('green', 0).classList.contains('unseen')).toBe(true);
    // Green's token stands on square 33 (its progress 20); red's token on 30 lands on it with a 3.
    const next = structuredClone(g);
    applyRoll(next, 3);
    next.version++;
    app.handler!({ state: await viewOf(next, 'red'), events: [{ type: 'roll', color: 'red', value: 3, queue: [3] }] });
    await flush(300);
    const after = structuredClone(next);
    const events = applyMove(after, 0, 1);
    expect(events.some((e) => e.type === 'capture' && e.victim === 'green')).toBe(true);
    after.version++;
    app.handler!({ state: await viewOf(after, 'red'), events });
    await flush(2500);
    expect(token('green', 0).classList.contains('unseen')).toBe(false);
    expect(token('green', 0).classList.contains('pw-cloak')).toBe(false);
  });

  it("a thief's raid is a way of its own: in the bubble and as a crimson marker, and it is what's sent", async () => {
    const g = powerGame();
    g.tokens.red = [35, B, B, B];
    g.powers = { red: ['thief', null, null, null] };
    g.golden = {};
    mount(g);
    await step((s) => applyRoll(s, 4), 200);
    // Blue isn't seated, so nothing to raid past red's progress 35; two short of green's turn (red's 11) there is.
    expect(document.querySelectorAll('#targets .target.raid')).toHaveLength(0);
    resync(Object.assign(structuredClone(current), { tokens: { ...current.tokens, red: [9, B, B, B] } }));
    await flush(50);
    const marker = document.querySelector<HTMLElement>('#targets .target.raid[data-token]')!;
    expect(marker.dataset.raid).toBe('green');
    expect(marker.getAttribute('aria-label')).toBe("Raid bob's home column");
    expect(document.querySelector('#targets .target.track[data-token]')).not.toBeNull();
    token('red', 0).click();
    await flush();
    const labels = [...document.querySelectorAll('.lap-opt')].map((o) => o.getAttribute('aria-label'));
    expect(labels).toEqual(['Stay on the track', "Raid bob's home column"]);
    click('.lap-opt.raid');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 0, raid: 'green', lap: false });
  });

  it('a shield takes the hit: told, and the badge goes; a golden token caught goes to its start square', async () => {
    const g = powerGame();
    g.tokens.red = [17, B, B, B];
    g.tokens.green = [7, 20, B, B]; // squares 20 and 33
    g.powers = { green: ['shield', null, null, null] };
    g.golden = { green: 1 };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    await step((s) => applyMove(s, 0, 0), 2500);
    expect(sounds).toContain('shieldBreak');
    expect(token('green', 0).classList.contains('pw-shield')).toBe(false);
    expect(current.tokens.green[0]).toBe(7);
    // Red again, onto the golden token on square 33.
    current.turn.seat = 0;
    current.tokens.red[1] = 30;
    resync(current);
    await flush(50);
    const events = await step((s) => applyRoll(s, 3), 200);
    expect(events[0].type).toBe('roll');
    await step((s) => applyMove(s, 0, 1), 2500);
    expect(current.tokens.green[1]).toBe(0);
    // On green's start square (8, 1), not in its base.
    expect(token('green', 1).style.transform).toBe('translate(800%, 100%) scale(1)');
  });
});
