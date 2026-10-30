// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE as B, HOME as H } from '../../../src/shared/board.js';
import { applyMove, applyRespawn, applyRoll, applySurrender, createGameState, legalMoves } from '../../../src/shared/rules.js';
import type { Color, GameEvent, GameState, PublicGameState } from '../../../src/shared/types.js';
import { click, flush, modalButton, setupDom, toasts, topModal } from './harness.js';
import { resetNet, sentOf } from './fakeNet.js';

vi.mock('../../../src/client/net.js', () => import('./fakeNet.js'));
const app = vi.hoisted(() => ({ handler: null as null | ((u: { state: PublicGameState; events?: GameEvent[] }) => void), errors: [] as string[] }));
vi.mock('../../../src/client/app.js', () => ({
  setGameHandler: (fn: typeof app.handler) => (app.handler = fn),
  showError: (code: string) => app.errors.push(code),
  resyncGame: vi.fn(),
}));
const sounds = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/client/sound.js', () => ({ play: (s: string) => sounds.push(s), isMuted: () => false, setMuted: vi.fn(), unlock: vi.fn(), installUnlockListeners: vi.fn() }));

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
function newGame(opts: { teams?: boolean; me?: number; aliceController?: 'human' | 'takeover' } = {}): GameState {
  const seats = opts.teams
    ? [seat('red', 1, 'alice', opts.aliceController), seat('green', null, 'Bot Green', 'bot'), seat('yellow', 2, 'bob'), seat('blue', null, 'Bot Blue', 'bot')]
    : [seat('red', 1, 'alice', opts.aliceController), seat('green', 2, 'bob')];
  return createGameState({ id: `g${Math.random()}`, lobbyId: 'L', seats, firstSeat: 0, now: 0, teams: opts.teams });
}

let current: GameState;
function mount(s: GameState, me = 1): void {
  current = s;
  store.update({ user: { id: me, username: me === 1 ? 'alice' : 'someone' }, game: pub(s), lobby: { id: 'L', name: 'Fam', hostId: 1, status: 'playing', members: [], spectators: [], gameId: s.id, teams: Boolean(s.teams) } });
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
const token = (color: Color, id: number) => document.querySelector<HTMLButtonElement>(`.token.t-${color}[aria-label="${color} token ${id + 1}"]`)!;
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
  it('shows every player, whose turn it is, and rolls with a tap on the dice', async () => {
    mount(newGame());
    expect(document.querySelectorAll('.pchip:not(.pchip-empty)')).toHaveLength(2);
    expect(document.querySelector('.pchip[data-color=red] .pn')!.textContent).toContain('alice');
    expect(document.querySelector('#banner')!.textContent).toBe('Your turn');
    expect(hint()).toBe('Tap the dice to roll');
    click('.dice');
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

describe('choosing a token', () => {
  it('stacked tokens with different moustaches: a picker with both, large', async () => {
    const g = newGame();
    g.tokens.red = [8, 8, B, B];
    g.kills = { red: [3, 0, 0, 0] };
    mount(g);
    await step((s) => applyRoll(s, 3), 200);
    token('red', 1).click();
    await flush();
    const cards = [...document.querySelectorAll<HTMLElement>('.stack-opt')].map((c) => [c.dataset.token, c.querySelector('b')!.textContent]);
    expect(cards).toEqual([
      ['0', '3 captures'],
      ['1', 'Clean-shaven'],
    ]);
    click('.stack-opt[data-token="1"]');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ dieIndex: 0, tokenId: 1 });
    // A resync closes a picker that is still open.
    token('red', 0).click();
    resync(structuredClone(current));
  });

  it('at its home turn: head home or go round again, from the sheet or the board markers', async () => {
    const g = newGame();
    g.tokens.red = [48, B, B, B];
    mount(g);
    await step((s) => applyRoll(s, 5), 200);
    token('red', 0).click();
    await flush();
    expect([...document.querySelectorAll('.lap-opt b')].map((b) => b.textContent)).toEqual(['Head home', 'Go round again']);
    expect(document.querySelector('.lap-note')!.textContent).toContain("can't make a wildcard entry later");
    click('.lap-opt.round');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: true });
    click('#targets .target.home[data-token]');
    await flush();
    expect(sentOf('game:move').at(-1)).toMatchObject({ tokenId: 0, lap: false });
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
  it('partners get a badge, the line-up is announced, and friendly fire is asked about', async () => {
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
    expect(topModal().querySelector('h2')!.textContent).toBe('Capture your teammate?');
    modalButton('Cancel');
    await flush(10);
    expect(sentOf('game:move')).toEqual([]);
    token('red', 0).click();
    await flush(10);
    modalButton('Capture anyway');
    await flush(10);
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
