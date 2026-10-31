// @vitest-environment happy-dom
/** The lobby and results screens, colour swaps, and the small browser helpers. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameState } from '../../../src/shared/rules.js';
import type { LobbyMember, PublicGameState, PublicLobby } from '../../../src/shared/types.js';
import { click, flush, modalButton, setupDom, toasts, topModal } from './harness.js';
import { replies, resetNet, sentOf } from './fakeNet.js';

vi.mock('../../../src/client/net.js', () => import('./fakeNet.js'));
vi.mock('../../../src/client/app.js', () => ({ showError: vi.fn(), logout: vi.fn(), enterApp: vi.fn(), signOut: vi.fn(), boot: vi.fn() }));

let router: typeof import('../../../src/client/router.js');
let store: typeof import('../../../src/client/store.js');
const shown: string[] = [];
beforeAll(async () => {
  setupDom();
  router = await import('../../../src/client/router.js');
  store = await import('../../../src/client/store.js');
  router.register('lobby', (await import('../../../src/client/screens/lobby.js')).lobbyScreen);
  router.register('results', (await import('../../../src/client/screens/results.js')).resultsScreen);
  for (const n of ['home', 'game', 'blank']) router.register(n, () => void shown.push(n));
});
beforeEach(() => {
  resetNet();
  document.getElementById('toasts')!.innerHTML = '';
  document.getElementById('modal-root')!.innerHTML = '';
});
const show = (name: string) => {
  router.go('blank');
  document.getElementById('app')!.innerHTML = '';
  router.go(name);
};
const member = (color: LobbyMember['color'], userId: number | null, username: string, over: Partial<LobbyMember> = {}): LobbyMember => ({ color, userId, username, isBot: userId === null, ready: userId === null, connected: true, ...over });
const lobby = (over: Partial<PublicLobby> = {}): PublicLobby => ({
  id: 'L',
  name: 'Fam',
  hostId: 1,
  status: 'waiting',
  members: [member('red', 1, 'alice'), member('green', 2, 'bob', { wins: 3 })],
  spectators: [{ userId: 3, username: 'zed', connected: true }],
  gameId: null,
  teams: false,
  size: 4,
  ...over,
});
const seatOf = (color: string) => document.querySelector(`.seat.s-${color}`)!;
const chip = (color: string, label: string) => [...seatOf(color).querySelectorAll<HTMLButtonElement>('.chip')].find((c) => c.textContent!.includes(label))!;

describe('the lobby screen', () => {
  it('the host picks 4, 5 or 6 seats: the seats follow, and Team-up is only for 4', async () => {
    store.update({ user: { id: 1, username: 'alice' }, lobby: lobby() });
    show('lobby');
    expect(document.querySelector('.size-opt.on')!.textContent).toBe('4 players');
    expect(document.querySelectorAll('.seat')).toHaveLength(4);
    click('.size-opt[data-size="6"]');
    await flush();
    expect(sentOf('lobby:size')).toEqual([{ size: 6 }]);
    store.update({ lobby: lobby({ size: 6 }) });
    expect(document.querySelectorAll('.seat')).toHaveLength(6);
    expect(document.querySelector('.seat.s-orange')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.mode-opt[data-teams="1"]')!.disabled).toBe(true);
    expect(document.querySelector('#mode-note')!.textContent).toContain('Team-up is for 4 players');
    // Too many seated for a smaller board: that choice is greyed out.
    const six = ['red', 'green', 'yellow', 'blue', 'orange', 'purple'] as const;
    store.update({ lobby: lobby({ size: 6, members: six.map((c, i) => member(c, i === 0 ? 1 : null, `p${i}`)) }) });
    expect(document.querySelector<HTMLButtonElement>('.size-opt[data-size="5"]')!.disabled).toBe(true);
    expect(document.querySelector('#fill-bots')).toBeNull();
  });

  it('the host: seats, bots, kicking, the mode switch and starting', async () => {
    store.update({ user: { id: 1, username: 'alice' }, lobby: lobby() });
    show('lobby');
    expect(document.querySelector('#lobby-name')!.textContent).toBe('Fam');
    expect(document.querySelector('#lobby-hint')!.textContent).toContain('add a bot');
    expect(document.querySelector('.mode-opt.on')!.textContent).toContain('Classic');
    expect(document.querySelector('#mode-note')!.textContent).toBe('Classic: everyone for themselves.');
    expect(document.querySelector('.action-hint')!.textContent).toBe('Waiting for 1 player to get ready');
    chip('yellow', 'Bot').click();
    await flush();
    expect(sentOf('lobby:addBot')).toEqual([{ color: 'yellow' }]);
    chip('blue', 'Sit here').click();
    await flush();
    expect(sentOf('lobby:color')).toEqual([{ color: 'blue' }]);
    click('.mode-opt[data-teams="1"]');
    await flush();
    expect(sentOf('lobby:mode')).toEqual([{ teams: true }]);
    chip('green', 'Kick').click();
    await flush(10);
    modalButton('Kick');
    await flush(10);
    expect(sentOf('lobby:kick')).toEqual([{ userId: 2 }]);
    // Watchers can be kicked too.
    click('.watcher .chip-danger');
    await flush(10);
    modalButton('Kick');
    await flush(10);
    expect(sentOf('lobby:kick').at(-1)).toEqual({ userId: 3 });
    click('#fill-bots');
    await flush();
    expect(sentOf('lobby:fillBots')).toHaveLength(1);
    // Team-up with everyone seated and ready.
    store.update({ lobby: lobby({ teams: true, spectators: [], members: [member('red', 1, 'alice'), member('green', null, 'Bot Green'), member('yellow', 2, 'bob', { ready: true }), member('blue', null, 'Bot Blue')] }) });
    expect(document.querySelectorAll('.team-tag')).toHaveLength(4);
    expect(document.querySelector('#mode-note')!.textContent).toContain('Diagonal partners');
    expect(document.querySelector('.action-hint')!.textContent).toBe('Everyone is ready!');
    chip('green', 'Remove').click();
    await flush();
    expect(sentOf('lobby:removeBot')).toEqual([{ color: 'green' }]);
    click('#start');
    await flush();
    expect(sentOf('lobby:start')).toHaveLength(1);
    // Only bots: a bot battle.
    store.update({ lobby: lobby({ members: [member('red', null, 'Bot Red'), member('green', null, 'Bot Green')], spectators: [{ userId: 1, username: 'alice', connected: true }] }) });
    expect(document.querySelector('#start')!.textContent).toBe('🤖 Start bot battle');
    expect(document.querySelector('#lobby-hint')!.textContent).toBe('You are watching. Tap Sit here on an open seat to play.');
    chip('yellow', 'Sit here').click();
    await flush();
    expect(sentOf('lobby:sit')).toEqual([{ color: 'yellow' }]);
    // Team-up, host seated: open seats say teammate or opponent.
    store.update({ lobby: lobby({ teams: true, spectators: [], members: [member('red', 1, 'alice')] }) });
    expect(chip('yellow', 'Bot').textContent).toBe('＋ Bot teammate');
    expect(chip('green', 'Bot').textContent).toBe('＋ Bot opponent');
    expect(document.querySelector('.action-hint')!.textContent).toBe('Team-up needs all 4 seats: fill the open ones with bots?');
  });

  it('a guest: ready up, swap colours, watch instead, leave', async () => {
    store.update({ user: { id: 2, username: 'bob' }, lobby: lobby() });
    show('lobby');
    expect(document.querySelectorAll<HTMLButtonElement>('.mode-opt:disabled')).toHaveLength(5); // mode and seats: the host's to pick
    click('.bottom-bar .btn-xl');
    await flush();
    expect(sentOf('lobby:ready')).toEqual([{ ready: true }]);
    replies['lobby:swapAsk'] = () => ({ ok: true, data: { swapped: false } });
    chip('red', 'Swap').click();
    await flush(10);
    expect(store.state.swapOut).toEqual({ to: 1, color: 'red' });
    expect(chip('red', 'Cancel').textContent).toBe('Asked · Cancel');
    chip('red', 'Cancel').click();
    await flush(10);
    expect(sentOf('lobby:swapCancel')).toHaveLength(1);
    click('#spectate');
    await flush();
    expect(sentOf('lobby:spectate')).toHaveLength(1);
    store.update({ lobby: lobby({ members: [member('red', 1, 'alice'), member('green', 2, 'bob', { connected: false })] }) });
    expect(seatOf('green').classList.contains('seat-offline')).toBe(true);
    // A game starting while here opens it once its state is in.
    store.update({ game: { id: 'G' } as PublicGameState, lobby: lobby({ status: 'playing', gameId: 'G' }) });
    expect(shown.at(-1)).toBe('game');
    show('lobby');
    store.update({ game: null, lobby: lobby() });
    click('#back');
    await flush(10);
    modalButton('Leave');
    await flush(10);
    expect(sentOf('lobby:leave')).toHaveLength(1);
    expect(router.currentScreen()).toBe('home');
  });
});

describe('avatars', () => {
  it('lobby seats and watchers show the animal; those without one show their initial; bots keep the robot', () => {
    store.update({
      user: { id: 1, username: 'alice' },
      lobby: lobby({
        members: [member('red', 1, 'alice', { avatar: 'fox' }), member('green', 2, 'bob'), member('yellow', null, 'Bot Yellow')],
        spectators: [{ userId: 3, username: 'zed', avatar: 'owl', connected: true }, { userId: 4, username: 'yan', connected: true }],
      }),
    });
    show('lobby');
    const face = (sel: string) => document.querySelector(sel)!;
    expect(face('.seat.s-red .seat-token').textContent).toBe('🦊');
    expect(face('.seat.s-red .seat-token').classList.contains('has-avatar')).toBe(true);
    expect(face('.seat.s-green .seat-token').textContent).toBe('B');
    expect(face('.seat.s-green .seat-token').classList.contains('has-avatar')).toBe(false);
    expect(face('.seat.s-yellow .seat-token').textContent).toBe('🤖');
    expect(face('.watcher[data-user="3"] .watcher-dot').textContent).toBe('🦉');
    expect(face('.watcher[data-user="4"] .watcher-dot').textContent).toBe('Y');
    // A change made elsewhere (the server resends the lobby) is painted at once.
    store.update({ lobby: lobby({ members: [member('red', 1, 'alice', { avatar: 'panda' }), member('green', 2, 'bob')] }) });
    expect(face('.seat.s-red .seat-token').textContent).toBe('🐼');
  });

  it('the podium shows the animal of each player', () => {
    const seats = (['red', 'green', 'yellow', 'blue'] as const).map((color, i) => ({
      color,
      userId: i + 1,
      username: ['alice', 'bob', 'carol', 'dan'][i],
      ...(i === 0 ? { avatar: 'dog' } : {}),
      controller: 'human' as const,
      connected: true,
    }));
    const g = createGameState({ id: 'R', lobbyId: 'L', seats, now: 0 });
    g.finished = true;
    g.ranks = ['red', 'green', 'yellow', 'blue'];
    store.update({ user: { id: 1, username: 'alice' }, game: { ...g, legalMoves: [], serverNow: 0 }, lobby: lobby() });
    show('results');
    const dots = [...document.querySelectorAll('.podium-row .pchip-dot')].map((d) => d.textContent);
    expect(dots).toEqual(['🐶', 'B', 'C', 'D']);
  });

  it('the podium shows a seat a bot took over as the player it was, and a bot seat as 🤖', () => {
    const seats = (['red', 'green', 'yellow', 'blue'] as const).map((color, i) => ({
      color,
      userId: i === 3 ? null : i + 1,
      username: ['alice', 'bob', 'carol', 'Bot Blue'][i],
      ...(i === 1 ? { avatar: 'owl' } : {}),
      controller: (['human', 'takeover', 'human', 'bot'] as const)[i],
      connected: true,
    }));
    const g = createGameState({ id: 'R', lobbyId: 'L', seats, now: 0 });
    g.finished = true;
    g.ranks = ['red', 'green', 'yellow', 'blue'];
    store.update({ user: { id: 1, username: 'alice' }, game: { ...g, legalMoves: [], serverNow: 0 }, lobby: lobby() });
    show('results');
    expect([...document.querySelectorAll('.podium-row .pchip-dot')].map((d) => d.textContent)).toEqual(['A', '🦉', 'C', '🤖']);
  });
});

describe('colour swaps', () => {
  it('being asked: a prompt, answered; ended by the asker; asking a bot swaps at once', async () => {
    const swap = await import('../../../src/client/swapUi.js');
    store.update({ user: { id: 1, username: 'alice' }, lobby: lobby() });
    swap.onSwapRequest({ lobbyId: 'other', from: 2, fromName: 'bob', to: 1, fromColor: 'green', toColor: 'red', expiresAt: Date.now() + 5000 });
    expect(document.querySelector('#modal-root .modal')).toBeNull();
    swap.onSwapRequest({ lobbyId: 'L', from: 2, fromName: 'bob', to: 1, fromColor: 'green', toColor: 'red', expiresAt: Date.now() + 5000 });
    expect(topModal().textContent).toContain('bob wants to swap colours.');
    modalButton('Swap');
    await flush(10);
    expect(sentOf('lobby:swapAnswer')).toEqual([{ from: 2, accept: true }]);
    expect(toasts()).toContain("You're Green now");
    swap.onSwapRequest({ lobbyId: 'L', from: 3, fromName: 'zed', to: 1, fromColor: 'blue', toColor: 'red', expiresAt: Date.now() + 5000 });
    swap.onSwapEnded({ from: 3, to: 1, how: 'expired' });
    expect(toasts().at(-1)).toBe("They's swap request ended");
    // Our own request's outcomes.
    for (const [how, msg] of [
      ['accepted', 'Swapped colours with bob'],
      ['declined', 'bob said no to swapping'],
      ['expired', "bob didn't answer the swap"],
    ] as const) {
      swap.onSwapEnded({ from: 1, to: 2, how });
      expect(toasts().at(-1)).toBe(msg);
    }
    replies['lobby:swapAsk'] = () => ({ ok: true, data: { swapped: true } });
    await swap.askSwap('blue', null);
    expect(toasts().at(-1)).toBe("You're Blue now");
    replies['lobby:swapAsk'] = () => ({ ok: false, error: 'SWAP_EXPIRED' });
    await swap.askSwap('blue', 4);
    expect(toasts().at(-1)).toBe('That swap request is no longer valid.');
  });
});

describe('the results screen', () => {
  const finished = (opts: { teams?: boolean; bots?: boolean; me?: number }) => {
    const seats = (['red', 'green', 'yellow', 'blue'] as const).map((color, i) => ({ color, userId: opts.bots ? null : i + 1, username: opts.bots ? `Bot ${color}` : ['alice', 'bob', 'carol', 'dan'][i], controller: (opts.bots ? 'bot' : 'human') as 'bot' | 'human', connected: true }));
    const g = createGameState({ id: 'R', lobbyId: 'L', seats, now: 0, teams: opts.teams });
    g.finished = true;
    g.ranks = opts.teams ? ['blue', 'green', 'red', 'yellow'] : ['red', 'green', 'yellow', 'blue'];
    g.botBattle = opts.bots;
    g.surrendered = ['yellow'];
    g.stats = {
      red: { cells: 50, captures: 2, sixes: 3, revenges: 1, machoHome: 1, staches: 2, homeRuns: 5, risks: 2, friendlyFire: 0, firstBlood: true, owed: {} },
      green: { cells: 40, captures: 0, sixes: 1, revenges: 0, staches: 0, homeRuns: 4, risks: 0, friendlyFire: 1, firstBlood: false, owed: {} },
    };
    store.update({ user: { id: opts.me ?? 1, username: 'x' }, game: { ...g, legalMoves: [], serverNow: 0 }, lobby: lobby() });
    show('results');
  };

  it('classic: the podium, the awards (with the steel ball) and the stats', () => {
    finished({});
    expect(document.querySelector('.results h2')!.textContent).toBe('You won!');
    expect(document.querySelectorAll('.confetti i').length).toBeGreaterThan(0);
    expect([...document.querySelectorAll('.place')].map((p) => p.textContent)).toEqual(['1st', '2nd', '3rd', '4th']);
    expect(document.querySelector('.podium-row.p-yellow')!.textContent).toContain('🏳️');
    const awards = [...document.querySelectorAll('.award b')].map((b) => b.textContent);
    expect(awards).toEqual(expect.arrayContaining(['Balls of steel', 'Backstabber', 'Most macho', 'Baby face', 'First blood']));
    expect(document.querySelector('.award .aw-icon .steel-ball')).not.toBeNull();
    expect(document.querySelector('.p-red td.best')!.textContent).toBe('5'); // 🏠 Home
    click('#home');
    expect(store.state.game).toBeNull();
  });

  it('Team-up: the winning pair, for a loser too; a bot battle', () => {
    finished({ teams: true });
    expect(document.querySelector('.results h2')!.textContent).toBe('dan & bob win!');
    expect([...document.querySelectorAll('.place')].map((p) => p.textContent)).toEqual(['1st', '1st', '2nd', '2nd']);
    expect(document.querySelectorAll('.crown')).toHaveLength(2);
    finished({ teams: true, me: 4 });
    expect(document.querySelector('.results h2')!.textContent).toBe('Your team won!');
    finished({ bots: true, me: 9 });
    expect(document.querySelector('.results h2')!.textContent).toBe('Bot red wins the bot battle');
    expect(document.querySelector('.big-emoji')!.textContent).toBe('🤖');
    click('#lobby');
    expect(router.currentScreen()).toBe('lobby');
  });

  describe('dice luck', () => {
    const withRolls = (rolls: Record<string, number[] | undefined>) => {
      finished({});
      const g = store.state.game!;
      const base = { cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {} };
      g.stats = Object.fromEntries(Object.entries(rolls).map(([c, r]) => [c, { ...base, ...(r ? { rolls: r } : {}) }]));
      store.update({ game: { ...g } });
      show('results');
    };
    const tab = (id: string) => document.querySelector<HTMLButtonElement>(`#tab-${id}`)!;
    const panel = (id: string) => document.querySelector<HTMLElement>(`#panel-${id}`)!;

    it('a second tab under the awards: each player\'s rolls as percent per number, rows adding up to 100', () => {
      withRolls({ red: [5, 5, 0, 0, 0, 0], green: [1, 1, 1, 1, 1, 1], yellow: [0, 0, 0, 0, 0, 3] });
      expect(tab('stats').getAttribute('aria-selected')).toBe('true');
      expect(panel('stats').hidden).toBe(false);
      expect(panel('odds').hidden).toBe(true);
      click('#tab-odds');
      expect(tab('odds').getAttribute('aria-selected')).toBe('true');
      expect(panel('stats').hidden).toBe(true);
      expect(panel('odds').hidden).toBe(false);
      expect([...panel('odds').querySelectorAll('thead th')].map((h) => h.textContent)).toEqual(['', '1s', '2s', '3s', '4s', '5s', '6s']);
      const row = (c: string) => [...panel('odds').querySelectorAll(`tbody .p-${c} td .pct`)].map((d) => d.textContent);
      const counts = (c: string) => [...panel('odds').querySelectorAll(`tbody .p-${c} td .cnt`)].map((d) => d.firstChild!.textContent);
      expect(row('red')).toEqual(['50%', '50%', '0%', '0%', '0%', '0%']);
      expect(row('green')).toEqual(['17%', '17%', '17%', '17%', '16%', '16%']);
      expect(row('yellow')).toEqual(['0%', '0%', '0%', '0%', '0%', '100%']);
      // No rolls at all for a player: dashes, not a made-up 0%.
      expect(row('blue')).toEqual(['–', '–', '–', '–', '–', '–']);
      // Each name carries how many rolls the shares are of.
      expect([...panel('odds').querySelectorAll('tbody .rolls-n')].map((n) => n.textContent)).toEqual(['10 rolls', '6 rolls', '3 rolls', '0 rolls']);
      // The exact counts are on the page (a tooltip would not show on a phone), and read out in full.
      expect(counts('red')).toEqual(['5', '5', '0', '0', '0', '0']);
      expect(counts('yellow')).toEqual(['0', '0', '0', '0', '0', '3']);
      expect(panel('odds').querySelector('.p-yellow td:nth-child(7) .sr-only')!.textContent).toBe(' of 3 rolls');
      expect(panel('odds').querySelector('[title]')).toBeNull();
      // A handful of rolls says nothing about the dice: no cell is marked.
      expect(panel('odds').querySelectorAll('td.high, td.low')).toHaveLength(0);
      click('#tab-stats');
      expect(panel('stats').hidden).toBe(false);
      expect(panel('odds').hidden).toBe(true);
    });

    it('only shares a fair die rarely produces are marked, and only with enough rolls to tell', () => {
      // 100 rolls: a fair die stays within about 17% ± 7 points. 30 sixes is far above, 4 ones far below.
      withRolls({ red: [4, 17, 17, 16, 16, 30], green: [17, 17, 17, 17, 16, 16], yellow: [0, 0, 1, 0, 0, 8], blue: [3, 3, 3, 3, 3, 4] });
      click('#tab-odds');
      const marked = (c: string) => [...panel('odds').querySelectorAll(`tbody .p-${c} td`)].map((d) => (d.classList.contains('high') ? 'high' : d.classList.contains('low') ? 'low' : ''));
      expect(marked('red')).toEqual(['low', '', '', '', '', 'high']);
      expect(marked('green')).toEqual(['', '', '', '', '', '']); // an even row is not special
      expect(marked('yellow')).toEqual(['', '', '', '', '', '']); // 9 rolls: too few to say
      expect(marked('blue')).toEqual(['', '', '', '', '', '']); // 19 rolls: still too few
      expect(panel('odds').querySelector('.p-red td.high .sr-only')!.textContent).toBe(' of 100 rolls, more often than a fair die almost ever does');
      expect(panel('odds').querySelector('.p-red td.low .sr-only')!.textContent).toBe(' of 100 rolls, less often than a fair die almost ever does');
      // The note says why: a few dozen rolls make lopsided rows normal, with the range for 40 rolls.
      expect(panel('odds').querySelector('.odds-note')!.textContent).toMatch(/lopsided row is normal \(about 0–36% for 40 rolls\)/);
      expect(panel('odds').querySelector('.odds-note')!.textContent).toContain('under 20 rolls nothing is marked');
    });

    it('the tabs are one keyboard group: one Tab stop, arrows and Home/End move', () => {
      withRolls({ red: [1, 1, 1, 1, 1, 1] });
      expect([tab('stats').tabIndex, tab('odds').tabIndex]).toEqual([0, -1]);
      tab('stats').focus();
      tab('stats').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      expect(tab('odds').getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab('odds'));
      expect([tab('stats').tabIndex, tab('odds').tabIndex]).toEqual([-1, 0]);
      tab('odds').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); // wraps
      expect(tab('stats').getAttribute('aria-selected')).toBe('true');
      tab('stats').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      expect(tab('odds').getAttribute('aria-selected')).toBe('true');
    });

    it('a game saved before rolls were counted has no such tab, just the match stats', () => {
      withRolls({ red: undefined, green: undefined });
      expect(document.querySelector('.stat-tabs')).toBeNull();
      expect(document.querySelector('.stats-table')).not.toBeNull();
      expect(document.querySelector('.odds-table')).toBeNull();
    });
  });

  it('without a game it goes home', async () => {
    store.update({ game: null });
    show('results');
    await flush();
    expect(router.currentScreen()).toBe('home');
  });
});

describe('browser helpers', () => {
  it('install prompt: offered once the browser allows, then used', async () => {
    const install = await import('../../../src/client/install.js');
    install.installInstallPrompt();
    const seen: boolean[] = [];
    const off = install.onInstallChange(() => seen.push(install.canInstall()));
    expect(install.canInstall()).toBe(false);
    expect(await install.promptInstall()).toBe(false);
    const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'accepted' }) });
    window.dispatchEvent(e);
    expect(install.canInstall()).toBe(true);
    expect(await install.promptInstall()).toBe(true);
    window.dispatchEvent(new Event('appinstalled'));
    off();
    expect(seen).toEqual([true, false, false]);
  });

  it('updates: available when the server runs another version; the result is reported after reloading', async () => {
    const upd = await import('../../../src/client/update.js');
    store.update({ serverVersion: '0.0.0-test' });
    expect(upd.updateAvailable()).toBe(false);
    sessionStorage.setItem('ludo.updatingFrom', '0.0.0-test');
    upd.reportUpdate();
    expect(toasts().at(-1)).toBe("You're on the latest version (v0.0.0-test)");
    sessionStorage.setItem('ludo.updatingFrom', '0.0.0-old');
    upd.reportUpdate();
    expect(toasts().at(-1)).toBe('Updated to v0.0.0-test');
    store.update({ serverVersion: '9.9.9' });
    expect(upd.updateAvailable()).toBe(true);
    sessionStorage.setItem('ludo.updatingFrom', '0.0.0-test');
    upd.reportUpdate();
    expect(toasts().at(-1)).toContain('Still on v0.0.0-test');
    upd.reportUpdate(); // nothing pending: quiet
    history.replaceState(null, '', '/?fresh=1#x');
    upd.tidyUpdateUrl();
    expect(location.search).toBe('');
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});
    await upd.updateApp();
    expect(replace.mock.calls[0][0]).toMatch(/^\/refresh\?t=\d+$/);
  });

  it('keyboard, rotate hint, wake lock, fullscreen and vibration', async () => {
    const kb = await import('../../../src/client/keyboard.js');
    kb.installKeyboardAvoidance();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    window.dispatchEvent(new Event('resize'));
    await flush(30);
    const rot = await import('../../../src/client/rotateHint.js');
    rot.installRotateHint();
    expect(rot.isSideways({ orientationType: 'landscape-primary', screenW: 800, screenH: 390, typing: false })).toBe(true);
    expect(rot.isSideways({ screenW: 1280, screenH: 800, typing: false })).toBe(false);
    expect(rot.isSideways({ screenW: 800, screenH: 390, typing: true })).toBe(false);
    const wl = await import('../../../src/client/wakelock.js');
    const release = new EventTarget();
    Object.defineProperty(navigator, 'wakeLock', { value: { request: vi.fn(async () => Object.assign(release, { released: false })) }, configurable: true });
    wl.installWakeLock();
    await wl.keepScreenOn();
    expect((navigator as any).wakeLock.request).toHaveBeenCalledWith('screen');
    const fs = await import('../../../src/client/fullscreen.js');
    const btn = document.createElement('button');
    const off = fs.bindFullscreenButton(btn);
    expect(btn.hidden).toBe(true); // happy-dom can't go fullscreen
    await fs.enterFullscreen();
    await fs.exitFullscreen();
    expect(fs.isIos()).toBe(false);
    off();
    const { vibrate } = await import('../../../src/client/haptics.js');
    const v = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: v, configurable: true });
    vibrate([10, 20]);
    expect(v).toHaveBeenCalledWith([10, 20]);
  });

  it('ui helpers: escaping, dialogs that stay open, time ago', async () => {
    const ui = await import('../../../src/client/ui.js');
    expect(ui.esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(ui.timeAgo(Date.now())).toBe('just now');
    expect(ui.timeAgo(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(ui.timeAgo(Date.now() - 3 * 3_600_000)).toBe('3h ago');
    expect(ui.timeAgo(Date.now() - 2 * 86_400_000)).toBe('2d ago');
    expect(ui.errorText('NOPE')).toBe('Something went wrong (NOPE).');
    let tries = 0;
    ui.modal({ title: 'T', body: '<input>', actions: [{ label: 'Try', onClick: () => (++tries < 2 ? false : undefined) }] });
    modalButton('Try');
    await flush();
    expect(topModal()).not.toBeNull();
    modalButton('Try');
    await flush();
    expect(tries).toBe(2);
    const answer = ui.confirmDialog('Sure?', 'Really', 'Yes');
    [...document.querySelectorAll('#modal-root .modal-backdrop:not(.out)')].at(-1)!.dispatchEvent(new Event('pointerdown'));
    expect(await answer).toBe(false);
    ui.toast('bad', 'error', 10);
    await flush(400);
  });
});

describe('tap and hold on a lobby card: their volume, for you only', () => {
  const press = (el: Element) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  const bubble = () => document.querySelector<HTMLElement>('.bubble-screen .stack-bubble');

  beforeEach(async () => {
    const volume = await import('../../../src/client/listenVolume.js');
    volume.resetListenVolume();
    localStorage.clear();
    const { voice } = await import('../../../src/client/voice.js');
    voice.enabled = true;
    store.update({ user: { id: 1, username: 'alice' }, lobby: lobby() });
    show('lobby');
  });

  it('a seat and a watcher open the bubble; your own card and a bot\'s do not', async () => {
    store.update({ lobby: lobby({ members: [member('red', 1, 'alice'), member('green', 2, 'bob'), member('yellow', null, 'Bot Yellow')] }) });
    expect(seatOf('red').classList.contains('holdable')).toBe(false);
    expect(seatOf('yellow').classList.contains('holdable')).toBe(false);
    press(seatOf('red'));
    await flush(520);
    expect(bubble()).toBeNull();

    press(seatOf('green').querySelector('.seat-token')!);
    await flush(520);
    expect(bubble()!.querySelector('.bubble-cap')!.textContent).toBe('bob · only for you');
    bubble()!.querySelector<HTMLButtonElement>('[data-vol="0.6"]')!.click();
    const { volumeOf } = await import('../../../src/client/listenVolume.js');
    expect(volumeOf(2)).toBe(0.6);
    expect(seatOf('green').getAttribute('aria-label')).toContain('voice volume 60%');

    const watcher = document.querySelector('.watcher[data-user="3"]')!;
    press(watcher);
    await flush(520);
    expect(bubble()!.querySelector('.bubble-cap')!.textContent).toBe('zed · only for you');
  });

  it('a press on a button inside the card (Kick, Swap) is the button\'s, not a hold', async () => {
    press(chip('green', 'Kick'));
    await flush(520);
    expect(bubble()).toBeNull();
  });

  it('leaving the lobby closes the bubble', async () => {
    press(seatOf('green'));
    await flush(520);
    expect(bubble()).not.toBeNull();
    router.go('blank');
    await flush(300);
    expect(bubble()).toBeNull();
  });
});
