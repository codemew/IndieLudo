// @vitest-environment happy-dom
/**
 * The whole client from the first tap: splash → access code → name → home → lobby → game →
 * results, with the real app, socket wrapper (net.ts), API helper and screens. Only the network
 * is faked: a stand-in socket.io socket and a scripted fetch.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AVATARS } from '../../../src/shared/avatars.js';
import { createGameState, legalMoves } from '../../../src/shared/rules.js';
import type { PublicGameState, PublicLobby } from '../../../src/shared/types.js';
import { click, flush, modalButton, setupDom, toasts, topModal } from './harness.js';

const sock = vi.hoisted(() => {
  const handlers = new Map<string, ((...a: any[]) => void)[]>();
  const replies: Record<string, (p: any) => any> = {};
  const emitted: [string, any][] = [];
  const s: any = {
    connected: false,
    io: { engine: { close: () => s.fire('disconnect', 'transport close'), transport: { name: 'websocket' } } },
    on(ev: string, fn: (...a: any[]) => void) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev)!.push(fn);
      return s;
    },
    removeAllListeners() {
      handlers.clear();
    },
    disconnect() {
      s.connected = false;
    },
    connect: () => {},
    timeout: () => ({
      emit: (ev: string, payload: any, cb: (err: Error | null, r: any) => void) => {
        emitted.push([ev, payload]);
        const r = replies[ev]?.(payload) ?? { ok: true };
        setTimeout(() => cb(null, r), 0);
      },
    }),
    emit(ev: string, payload: any) {
      emitted.push([ev, payload]);
    },
    fire(ev: string, ...args: any[]) {
      for (const fn of handlers.get(ev) ?? []) fn(...args);
    },
  };
  return { s, replies, emitted, opts: null as any, made: 0 };
});
vi.mock('socket.io-client', () => ({
  io: (opts: unknown) => {
    sock.opts = opts;
    sock.made++;
    sock.s.connected = false;
    return sock.s;
  },
}));

/** Scripted HTTP API: "METHOD /api/path" → [status, body]. */
const http: Record<string, (body: any) => [number, unknown]> = {};
const calls: string[] = [];
const emittedOf = (ev: string) => sock.emitted.filter(([e]) => e === ev).map(([, p]) => p);
/** The screen showing now (one on its way out may still be in the page). */
const live = () => document.querySelector<HTMLElement>('#app main:not(.screen-out)')!;
const screen = () => /\b(screen-(?!out)\w+)/.exec(document.querySelector('#app main:not(.screen-out)')?.className ?? '')?.[1];
async function waitFor(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await flush(20)) if (ok()) return;
  throw new Error(`timed out waiting for ${what} (screen ${screen()})`);
}
const type = (sel: string, value: string) => {
  const i = document.querySelector<HTMLInputElement>(sel)!;
  i.value = value;
  i.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeAll(async () => {
  setupDom();
  const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.split('?')[0]}`;
    calls.push(key);
    const h = http[key];
    if (!h) return new Response('{}', { status: 404 });
    const [status, body] = h(init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  Object.assign(globalThis, { fetch: fakeFetch });
  Object.assign(window, { fetch: fakeFetch });
  await import('../../../src/client/main.js');
});

const lobby = (over: Partial<PublicLobby> = {}): PublicLobby => ({
  id: 'L1',
  name: 'Family',
  hostId: 1,
  status: 'waiting',
  members: [{ color: 'red', userId: 1, username: 'alice', isBot: false, ready: false, connected: true, wins: 2 }],
  spectators: [],
  gameId: null,
  teams: false,
  size: 4,
  ...over,
});

describe('the app, end to end', () => {
  it('splash → the access code (wrong, too many tries, right)', async () => {
    expect(screen()).toBe('screen-splash');
    expect(document.querySelector('.app-version')!.textContent).toBe('v0.0.0-test');
    expect(document.querySelector('.splash-foot .made-with')!.textContent).toBe('Made with ❤️, by Somnath');
    http['GET /api/gate/status'] = () => [200, { verified: false }];
    click('#play');
    await waitFor('the gate', () => screen() === 'screen-gate');
    http['POST /api/gate/verify'] = () => [400, { error: 'INVALID_CODE' }];
    type('#otp-input', '12a3456');
    await waitFor('the error', () => document.querySelector('#gate-error')!.textContent === 'That code is not right.');
    http['POST /api/gate/verify'] = () => [429, { error: 'RATE_LIMITED', retryAfterSec: 1 }];
    type('#otp-input', '111111');
    await waitFor('the lock', () => document.querySelector('#gate-error')!.textContent!.startsWith('Too many attempts'));
    expect(document.querySelector<HTMLInputElement>('#otp-input')!.disabled).toBe(true);
    await waitFor('unlocked', () => !document.querySelector<HTMLInputElement>('#otp-input')!.disabled, 3000);
    http['POST /api/gate/verify'] = (b) => (b.code === '424242' ? [200, { deviceToken: 'dev-1' }] : [400, { error: 'INVALID_CODE' }]);
    type('#otp-input', '424242');
    await waitFor('the name screen', () => screen() === 'screen-signup');
    expect(localStorage.getItem('ludo.deviceToken')).toBe('dev-1');
  });

  it('picking a name signs in and connects; hello lands on home', async () => {
    const go = document.querySelector<HTMLButtonElement>('#go')!;
    type('#username', 'al');
    expect(go.disabled).toBe(true);
    type('#username', 'alice');
    expect(go.disabled).toBe(false);
    http['POST /api/users'] = () => [409, { error: 'USERNAME_TAKEN' }];
    document.querySelector('#signup-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor('the error', () => document.querySelector('#name-help')!.textContent === 'That name is taken.');
    http['POST /api/users'] = () => [200, { token: 'sess-1' }];
    http['GET /api/me'] = () => [200, { user: { id: 1, username: 'alice', gamesPlayed: 3, wins: 1 }, isAdmin: false }];
    document.querySelector('#signup-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor('the socket', () => sock.made === 1);
    expect(sock.opts).toMatchObject({ auth: { token: 'sess-1' }, transports: ['websocket', 'polling'] });
    sock.s.connected = true;
    sock.s.fire('connect');
    sock.replies['lobby:list'] = () => ({ ok: true, data: [] });
    sock.s.fire('hello', { appVersion: '0.0.0-test', user: { id: 1, username: 'alice' }, lobby: null, game: null });
    await waitFor('home', () => screen() === 'screen-home');
    expect(document.querySelector('#me-name')!.textContent).toBe('alice');
    expect(document.querySelector('.bottom-bar .made-with')!.textContent).toBe('Made with ❤️, by Somnath');
    expect(document.querySelector('#me-stats')!.textContent).toBe('1 wins · 3 games');
    expect(document.querySelector('#app-update')!.textContent).toContain('Up to date');
  });

  it('home: the lobby list (with Team-up), joining with a password, renaming, the menu', async () => {
    sock.s.fire('lobby:list', [{ id: 'L2', name: 'Other', hostName: 'zed', status: 'waiting', players: 2, watching: 1, teams: true, share: true }]);
    await waitFor('the card', () => document.querySelector('.lobby-card') !== null);
    expect(document.querySelector('.lobby-card')!.textContent).toContain('🤝 Team-up · sharing');
    click('.lobby-card');
    await flush(10);
    (topModal().querySelector('input') as HTMLInputElement).value = 'nope';
    sock.replies['lobby:join'] = () => ({ ok: false, error: 'WRONG_LOBBY_PASSWORD' });
    modalButton('Join');
    await waitFor('wrong password', () => topModal().querySelector('.form-error')!.textContent === 'Wrong password.');
    modalButton('Cancel');
    // Rename.
    click('#me');
    await flush(80);
    (topModal().querySelector('input') as HTMLInputElement).value = 'alice2';
    http['PATCH /api/me'] = () => [200, { user: { id: 1, username: 'alice2' } }];
    modalButton('Save');
    await waitFor('renamed', () => document.querySelector('#me-name')!.textContent === 'alice2');
    expect(toasts()).toContain("You're now alice2");
    // Profile: pick an animal; the preview and the home tag change, only the avatar is sent.
    click('#me');
    await flush(80);
    const grid = topModal().querySelector('.avatar-grid')!;
    expect(grid.querySelectorAll('.avatar-opt').length).toBeGreaterThan(24);
    expect(grid.querySelector('.avatar-opt.on')!.getAttribute('data-avatar')).toBe('');
    expect(document.querySelector('#avatar')!.textContent).toBe('A');
    click('.avatar-opt[data-avatar="cat"]', topModal());
    expect(topModal().querySelector('#avatar-preview')!.textContent).toBe('🐱');
    expect(grid.querySelector('.avatar-opt.on')!.getAttribute('aria-checked')).toBe('true');
    let sent: unknown;
    http['PATCH /api/me'] = (b) => ((sent = b), [200, { user: { id: 1, username: 'alice2', avatar: 'cat' } }]);
    modalButton('Save');
    await waitFor('the avatar', () => document.querySelector('#avatar')!.textContent === '🐱');
    expect(sent).toEqual({ avatar: 'cat' });
    expect(document.querySelector('#avatar')!.classList.contains('has-avatar')).toBe(true);
    // Keyboard: one tab stop for the group (the selected one), arrows move the pick, and the "none" tile follows the typed name.
    click('#me');
    await flush(80);
    const radios = () => [...topModal().querySelectorAll<HTMLButtonElement>('.avatar-opt')];
    expect(radios().filter((b) => b.tabIndex === 0).map((b) => b.dataset.avatar)).toEqual(['cat']);
    const key = (k: string) => radios().find((b) => b.tabIndex === 0)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    radios().find((b) => b.tabIndex === 0)!.focus();
    key('ArrowRight');
    expect(radios().filter((b) => b.tabIndex === 0).map((b) => b.dataset.avatar)).toEqual(['rabbit']);
    expect(document.activeElement).toBe(radios().find((b) => b.dataset.avatar === 'rabbit'));
    key('Home');
    expect(radios().find((b) => b.tabIndex === 0)!.dataset.avatar).toBe('');
    key('ArrowLeft'); // wraps round to the last one
    expect(radios().find((b) => b.tabIndex === 0)!.dataset.avatar).toBe(AVATARS[AVATARS.length - 1].id);
    expect(radios()[0].textContent).toBe('A');
    const nameBox = topModal().querySelector('input') as HTMLInputElement;
    nameBox.value = 'zed';
    nameBox.dispatchEvent(new Event('input', { bubbles: true }));
    expect(radios()[0].textContent).toBe('Z');
    modalButton('Cancel');
    await flush(250);
    // A stored avatar that is not on the list any more: the "none" tile is checked and is the tab stop.
    const store = await import('../../../src/client/store.js');
    store.update({ user: { ...store.state.user!, avatar: 'retired' } });
    click('#me');
    await flush(80);
    expect(radios().filter((b) => b.tabIndex === 0).map((b) => b.dataset.avatar)).toEqual(['']);
    modalButton('Cancel');
    await flush(250);
    store.update({ user: { ...store.state.user!, avatar: 'cat' } });
    // Saving nothing new sends nothing; a rejected avatar shows its message and keeps the dialog.
    click('#me');
    await flush(80);
    sent = undefined;
    modalButton('Save');
    await flush(40);
    expect(sent).toBeUndefined();
    click('#me');
    await flush(80);
    click('.avatar-opt[data-avatar="dog"]', topModal());
    http['PATCH /api/me'] = () => [400, { error: 'INVALID_AVATAR' }];
    modalButton('Save');
    await waitFor('the error', () => topModal().querySelector('.form-error')!.textContent === 'That avatar is not available.');
    modalButton('Cancel');
    await flush(250);
    // Hiding my phone from the Users tab: on by default; only that is sent.
    click('#me');
    await flush(80);
    const showBox = topModal().querySelector<HTMLInputElement>('input[name=showDevice]')!;
    expect(showBox.checked).toBe(true);
    showBox.checked = false;
    http['PATCH /api/me'] = (b) => ((sent = b), [200, { user: { id: 1, username: 'alice2', avatar: 'cat', showDevice: false } }]);
    modalButton('Save');
    await waitFor('saved', () => toasts().includes('Profile saved'));
    expect(sent).toEqual({ showDevice: false });
    expect(store.state.user!.showDevice).toBe(false);
    click('#me');
    await flush(80);
    expect(topModal().querySelector<HTMLInputElement>('input[name=showDevice]')!.checked).toBe(false);
    modalButton('Cancel');
    await flush(250);
    // Create a lobby: checked first, then sent.
    click('#create');
    await flush(10);
    modalButton('Create');
    await flush(10);
    expect(topModal().querySelector('.form-error')!.textContent).toBe('Give the lobby a name.');
    (topModal().querySelector('[name=name]') as HTMLInputElement).value = 'Family';
    (topModal().querySelector('[name=password]') as HTMLInputElement).value = 'pw';
    sock.replies['lobby:create'] = () => ({ ok: true, data: lobby() });
    modalButton('Create');
    await waitFor('the lobby', () => screen() === 'screen-lobby');
    expect(emittedOf('lobby:create')).toEqual([{ name: 'Family', password: 'pw', createPassword: '' }]);
  });

  it('the lobby: changes arrive live; a game starting opens the board; the end shows results', async () => {
    sock.s.fire('lobby:state', lobby({ teams: true, members: [...lobby().members, { color: 'yellow', userId: 2, username: 'bob', isBot: false, ready: true, connected: true, wins: 0 }] }));
    await waitFor('team tags', () => document.querySelectorAll('.team-tag').length === 4);
    sock.s.fire('net:stats', { lobbyId: 'L1', players: [{ userId: 2, pingMs: 30, bars: 4 }] });
    sock.s.fire('voice:state', { lobbyId: 'L1', enabled: true, epoch: 0, bitrateKbps: 6, participants: [{ userId: 2, muted: true }] });
    await flush(20);
    const g = createGameState({ id: 'G1', lobbyId: 'L1', seats: [{ color: 'red', userId: 1, username: 'alice', controller: 'human', connected: true }, { color: 'yellow', userId: 2, username: 'bob', controller: 'human', connected: true }], now: 0 });
    const pub = (x: typeof g): PublicGameState => ({ ...structuredClone(x), legalMoves: legalMoves(x), serverNow: Date.now() });
    sock.s.fire('lobby:state', lobby({ status: 'playing', gameId: 'G1' }));
    sock.s.fire('game:state', { state: pub(g) });
    await waitFor('the board', () => screen() === 'screen-game');
    expect(localStorage.getItem('ludo.lastGameId')).toBe('G1');
    g.finished = true;
    g.ranks = ['red', 'yellow'];
    g.version++;
    sock.s.fire('game:state', { state: pub(g), events: [{ type: 'gameOver', ranks: ['red', 'yellow'] }] });
    await waitFor('results', () => screen() === 'screen-results', 4000);
    expect(document.querySelector('.results h2')!.textContent).toBe('You won!');
    click('#lobby');
    sock.s.fire('lobby:state', lobby());
    await waitFor('back in the lobby', () => screen() === 'screen-lobby');
  });

  it('home while in a lobby: the Users tab, a remembered creation password, the host closing it, the host leaving', async () => {
    // The phone said what it is once connected (no client hints in this browser: an empty report).
    expect(emittedOf('device:info').length).toBeGreaterThan(0);
    // ‹ goes home and keeps the seat.
    const leavesBefore = emittedOf('lobby:leave').length;
    click('#back', live());
    await waitFor('home', () => screen() === 'screen-home');
    expect(emittedOf('lobby:leave').length).toBe(leavesBefore);
    expect(live().querySelector('.my-lobby-card')!.textContent).toContain('Family');

    // The Users tab: everyone online, where they are, and their phones unless hidden.
    sock.s.fire('users:online', [
      { id: 1, username: 'alice2', avatar: 'cat', since: Date.now() - 5 * 60_000, where: { kind: 'lobby', lobby: 'Family' }, devices: [{ model: 'Samsung SM-S918B', os: 'Android 14', browser: 'Chrome 130', isp: 'Reliance Jio Infocomm Limited' }] },
      { id: 2, username: 'bob', since: Date.now(), where: { kind: 'home' }, hidden: true },
      { id: 3, username: 'carol', since: Date.now(), where: { kind: 'playing', lobby: 'Other' }, devices: [{ model: 'iPhone', os: 'iOS 17.5', browser: 'Safari 17.5', isp: '' }, { model: '', os: 'Windows 11', browser: 'Edge 130', isp: 'Local network' }] },
    ]);
    await flush(10);
    expect(live().querySelector('#users-count')!.textContent).toBe('3');
    expect(live().querySelector<HTMLElement>('#panel-users')!.hidden).toBe(true);
    click('#tab-users', live());
    expect(live().querySelector<HTMLElement>('#panel-users')!.hidden).toBe(false);
    expect(live().querySelector<HTMLElement>('#panel-lobbies')!.hidden).toBe(true);
    expect(live().querySelector('#tab-users')!.getAttribute('aria-selected')).toBe('true');
    expect(live().querySelector<HTMLElement>('#create')!.hidden).toBe(true);
    const rows = [...live().querySelectorAll('.user-row')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
    expect(live().querySelector('.user-row.user-me .user-name')!.textContent).toContain('alice2');
    expect(live().querySelector('.user-row.user-me .user-since')!.textContent).toBe('online 5m');
    expect(rows[0]).toContain('In lobby Family');
    expect(rows[0]).toContain('Samsung SM-S918B · Android 14 · Chrome 130');
    expect(rows[0]).toContain('Reliance Jio Infocomm Limited');
    expect(rows[1]).toContain('On the home screen');
    expect(rows[1]).toContain('Phone details hidden');
    expect(rows[2]).toContain('Playing in Other');
    expect(rows[2]).toContain('iPhone · iOS 17.5 · Safari 17.5');
    expect(rows[2]).toContain('Windows 11 · Edge 130');
    expect(rows[2]).toContain('Local network');
    expect(localStorage.getItem('ludo.homeTab')).toBe('users');
    // Alone online (on a computer): my row, and a note that nobody else is.
    sock.s.fire('users:online', [{ id: 1, username: 'alice2', since: Date.now(), where: { kind: 'home' }, devices: [{ model: '', os: 'Windows 11', browser: 'Edge 130', isp: '' }] }]);
    await flush(10);
    expect(live().querySelectorAll('.user-row')).toHaveLength(1);
    expect(live().querySelector('#user-list')!.textContent).toContain('💻 Windows 11 · Edge 130');
    expect(live().querySelector('#user-list')!.textContent).toContain('Nobody else is online right now.');
    expect(live().querySelector('#users-count')!.textContent).toBe('1');
    // Arrow keys switch tabs.
    live().querySelector('#tab-users')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(live().querySelector<HTMLElement>('#panel-lobbies')!.hidden).toBe(false);
    expect(document.activeElement).toBe(live().querySelector('#tab-lobbies'));

    // Creating again: this account entered the creation password before (in the step above), so it isn't asked;
    // and the dialog says the current lobby will be left.
    click('#create', live());
    await flush(10);
    expect(topModal().querySelector<HTMLElement>('#create-pw')!.hidden).toBe(true);
    expect(topModal().querySelector('#create-ok')).not.toBeNull();
    expect(topModal().querySelector('.form-note')!.textContent).toBe("You'll leave Family.");
    (topModal().querySelector('[name=name]') as HTMLInputElement).value = 'Again';
    (topModal().querySelector('[name=password]') as HTMLInputElement).value = 'pw';
    // An admin changed the creation password meanwhile: it is asked again, in the same dialog.
    sock.replies['lobby:create'] = () => ({ ok: false, error: 'WRONG_CREATE_PASSWORD' });
    modalButton('Create');
    await waitFor('asked again', () => !topModal().querySelector<HTMLElement>('#create-pw')!.hidden);
    expect(topModal().querySelector('.form-error')!.textContent).toBe('The creation password is needed again (it was changed).');
    modalButton('Cancel');
    await flush(250);

    // The host closes the lobby while we're on the home screen: told here, and the card goes.
    sock.s.fire('lobby:closed', { byAdmin: false, byHost: true });
    sock.s.fire('lobby:state', null);
    await flush(10);
    expect(screen()).toBe('screen-home');
    expect(toasts()).toContain('Family was closed by the host.');
    expect(live().querySelector('.my-lobby-card')).toBeNull();

    // As host with someone else in it: leaving asks whether to close it for everyone.
    const bob = { color: 'green' as const, userId: 2, username: 'bob', isBot: false, ready: false, connected: true };
    sock.s.fire('lobby:state', lobby({ members: [...lobby().members, bob] }));
    await waitFor('the card', () => live().querySelector('.my-lobby-card') !== null);
    click('.my-lobby-card', live());
    await waitFor('the lobby', () => screen() === 'screen-lobby');
    click('#leave', live());
    await flush(10);
    expect(topModal().querySelector('h2')!.textContent).toBe('Leave the lobby?');
    expect(topModal().textContent).toContain('bob becomes the host');
    modalButton('Close for everyone');
    await waitFor('home', () => screen() === 'screen-home');
    await flush(10);
    expect(emittedOf('lobby:close').length).toBe(1);
    // The server's echo of our own close isn't news to us.
    const before = toasts().length;
    sock.s.fire('lobby:closed', { byAdmin: false, byHost: true });
    sock.s.fire('lobby:state', null);
    await flush(10);
    expect(toasts().length).toBe(before);

    // Back into the lobby for the next steps.
    sock.s.fire('lobby:state', lobby());
    await waitFor('the card', () => live().querySelector('.my-lobby-card') !== null);
    click('.my-lobby-card', live());
    await waitFor('the lobby', () => screen() === 'screen-lobby');
  });

  it('removed from the lobby, a colour-swap request, a reconnect, and being signed out', async () => {
    sock.s.fire('lobby:state', null);
    await waitFor('home', () => screen() === 'screen-home');
    expect(toasts()).toContain('You were removed from the lobby.');
    sock.s.fire('lobby:state', lobby({ members: [...lobby().members, { color: 'green', userId: 3, username: 'carol', isBot: false, ready: false, connected: true }] }));
    sock.s.fire('lobby:swapRequest', { lobbyId: 'L1', from: 3, fromName: 'carol', to: 1, fromColor: 'green', toColor: 'red', expiresAt: Date.now() + 20_000 });
    await flush(20);
    expect(topModal().textContent).toContain('carol');
    sock.s.fire('lobby:swapEnded', { from: 3, to: 1, how: 'cancelled' });
    await flush(250);
    // Dropped and back: voice rejoins; a disconnect shows the banner.
    sock.s.fire('disconnect', 'transport close');
    expect(document.getElementById('net-banner')!.hidden).toBe(false);
    sock.s.fire('connect');
    expect(document.getElementById('net-banner')!.hidden).toBe(true);
    // An admin ended the session.
    sock.s.fire('session:revoked');
    await waitFor('signed out', () => screen() === 'screen-signup');
    expect(toasts()).toContain('Your session was ended by an admin.');
    expect(localStorage.getItem('ludo.sessionToken')).toBeNull();
  });

  it('an unauthorized reconnect signs out too; offline shows the retry screen', async () => {
    localStorage.setItem('ludo.sessionToken', 'sess-2');
    http['GET /api/me'] = () => [200, { user: { id: 1, username: 'alice' }, isAdmin: false }];
    const { enterApp } = await import('../../../src/client/app.js');
    await enterApp();
    sock.s.fire('connect_error', new Error('UNAUTHORIZED'));
    await waitFor('signed out', () => screen() === 'screen-signup');
    http['GET /api/gate/status'] = () => {
      throw new Error('down');
    };
    delete http['GET /api/gate/status'];
    const { boot } = await import('../../../src/client/app.js');
    (globalThis as any).fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await boot();
    await waitFor('offline', () => screen() === 'screen-offline');
    click('#retry');
  });
});
