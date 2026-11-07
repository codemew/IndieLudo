/**
 * Browser tests for v3.6: the home screen's Users tab (who is online, where, and on what phone),
 * going home without leaving the lobby, the host closing the lobby on the way out, the creation
 * password remembered per account, and the admin panel's Passwords tab. Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

/** A Samsung phone on Chrome: the user agent is frozen (model "K"), the client hints say what it is. */
const SAMSUNG_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SAMSUNG_HINTS = {
  brands: [
    { brand: 'Chromium', version: '130' },
    { brand: 'Google Chrome', version: '130' },
    { brand: 'Not?A_Brand', version: '99' },
  ],
  fullVersionList: [
    { brand: 'Chromium', version: '130.0.6723.58' },
    { brand: 'Google Chrome', version: '130.0.6723.58' },
    { brand: 'Not?A_Brand', version: '99.0.0.0' },
  ],
  platform: 'Android',
  platformVersion: '14.0.0',
  architecture: '',
  model: 'SM-S918B',
  mobile: true,
};

const rows = (p: Page) => p.$$eval('.screen-home:not(.screen-out) .user-row', (rs) => rs.map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
const toastTexts = (p: Page) => p.$$eval('#toasts .toast', (ts) => ts.map((x) => x.textContent ?? ''));

describe.skipIf(!CHROME || !BUILT)('home while in a lobby, the Users tab, and the host closing up', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let carol: Page;
  let nextIsSamsung = false;
  beforeAll(async () => {
    t = await setup({
      // Every test phone comes from 127.0.0.1, which the real lookup calls "Local network"; this stub names a network.
      start: { isp: { lookup: () => 'Reliance Jio Infocomm Limited' }, presenceDelayMs: 50 },
      onPage: async (p) => {
        if (nextIsSamsung) await p.setUserAgent(SAMSUNG_UA, SAMSUNG_HINTS);
      },
    });
    [alice, bob] = await t.lobby(['alice', 'bob']);
    nextIsSamsung = true;
    carol = await t.phone('carol');
    nextIsSamsung = false;
  });
  afterAll(() => t?.close());

  it('the Users tab lists everyone online with where they are, and their phone, browser and network', async () => {
    await tap(carol, '#tab-users');
    await until('three online', async () => (await rows(carol)).length === 3);
    const list = await rows(carol);
    const carolRow = list.find((r) => r.includes('carol'))!;
    // The client hints replaced Chrome's frozen "K" and Android 10.
    expect(carolRow).toContain('Samsung SM-S918B · Android 14 · Chrome 130');
    expect(carolRow).toContain('Reliance Jio Infocomm Limited');
    expect(carolRow).toContain('On the home screen');
    expect(list.find((r) => r.includes('alice'))).toContain('In lobby Family');
    expect(await carol.$eval('#users-count', (e) => e.textContent)).toBe('3');
    // The tab is remembered on this phone.
    await carol.reload({ waitUntil: 'networkidle0' });
    await tap(carol, '#play');
    await carol.waitForSelector('.screen-home #panel-users:not([hidden])');
    await until('three online again', async () => (await rows(carol)).length === 3);
    await sleep(300);
    await shot(carol, 'users-tab');
  });

  it('‹ in the lobby goes home and keeps the seat; the lobby is a tap away', async () => {
    await tap(bob, '#back');
    await bob.waitForSelector('.screen-home .my-lobby-card');
    expect(t.server.ctx.lobbies.forUser(userId('bob'))).toBeDefined();
    expect(await bob.$eval('.my-lobby-card', (e) => e.textContent)).toContain('your place is kept');
    // Alice still sees bob in his seat.
    await until('bob still seated', async () =>
      (await alice.$$eval('.seat .seat-name', (s) => s.map((x) => x.textContent ?? ''))).some((x) => x.includes('bob')),
    );
    await sleep(300);
    await shot(bob, 'home-in-lobby');
    await tap(bob, '.my-lobby-card');
    await bob.waitForSelector('.screen-lobby');
    await tap(bob, '#back');
    await bob.waitForSelector('.screen-home .my-lobby-card');
  });

  it('the host leaving is asked whether to close the lobby for everyone; closing sends everyone home, told why', async () => {
    await tap(alice, '#leave');
    await alice.waitForSelector('.modal h2');
    expect(await alice.$eval('.modal h2', (e) => e.textContent)).toBe('Leave the lobby?');
    expect(await alice.$eval('.modal', (e) => e.textContent)).toContain('bob becomes the host');
    await sleep(300);
    await shot(alice, 'host-leave');
    await alice.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Close for everyone') as HTMLElement).click());
    await alice.waitForSelector('.screen-home');
    await until('closed', () => t.server.ctx.lobbies.all().length === 0);
    await until("bob's card gone", async () => (await bob.$('.screen-home .my-lobby-card')) === null);
    await until('bob told', async () => (await toastTexts(bob)).includes('Family was closed by the host.'));
    // The host isn't told about their own close.
    expect((await toastTexts(alice)).some((x) => x.includes('closed by the host'))).toBe(false);
    expect(t.errors).toEqual([]);
  });

  it('a host who entered the creation password once is not asked for it again', async () => {
    await tap(alice, '#tab-lobbies');
    await tap(alice, '#create');
    await alice.waitForSelector('.modal #create-ok');
    // Not on screen at all (a display rule on .field must not undo [hidden]).
    expect(await alice.$eval('.modal #create-pw', (e) => getComputedStyle(e).display)).toBe('none');
    await alice.type('.modal [name=name]', 'Again');
    await alice.type('.modal [name=password]', 'pw');
    await sleep(300);
    await shot(alice, 'create-remembered');
    await tap(alice, '.modal .btn-primary');
    await alice.waitForSelector('.screen-lobby');
    // Carol never entered it: she is asked.
    await tap(carol, '#tab-lobbies');
    await tap(carol, '#create');
    await carol.waitForSelector('.modal [name=createPassword]');
    expect(await carol.$eval('.modal #create-pw', (e) => getComputedStyle(e).display)).not.toBe('none');
    await carol.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Cancel') as HTMLElement).click());
  });

  it("the admin's Passwords tab: the creation password and the remembered hosts; a lobby's join password", async () => {
    const mine = t.server.ctx.sessions.list().find((s) => s.username === 'alice')!;
    t.server.ctx.sessions.setAdmin(mine.id, true);
    await alice.reload({ waitUntil: 'networkidle0' });
    await tap(alice, '#play');
    await alice.waitForSelector('.screen-lobby');
    await tap(alice, '#back');
    await alice.waitForSelector('.screen-home');
    await tap(alice, '#menu');
    await alice.waitForSelector('.menu-item');
    await alice.$$eval('.menu-item', (bs) => (bs.find((b) => b.textContent!.includes('Admin panel')) as HTMLElement).click());
    await tap(alice, '.tabs button[data-tab=passwords]');
    await alice.waitForSelector('#create-pw-form');
    await until('alice remembered', async () => (await alice.$eval('#panel', (e) => e.textContent ?? '')).includes('Remembered hosts (1)'));
    await sleep(300);
    await shot(alice, 'admin-passwords');
    // A new join password for "Again": bob needs it.
    await tap(alice, '.tabs button[data-tab=lobbies]');
    await tap(alice, '[data-act=password]');
    await alice.waitForSelector('.modal [name=password]');
    await alice.type('.modal [name=password]', 'fresh');
    await tap(alice, '.modal .btn-primary');
    await until('saved', async () => (await toastTexts(alice)).some((x) => x.includes('New password for Again')));
    const lobby = t.server.ctx.lobbies.all()[0];
    const carolUser = { id: userId('carol'), username: 'carol' };
    expect(() => t.server.ctx.lobbies.join(carolUser, lobby.id, 'pw')).toThrow('WRONG_LOBBY_PASSWORD');
    expect(t.errors).toEqual([]);
  });

  const userId = (name: string) => t.server.ctx.users.getByName(name)!.id;
});
