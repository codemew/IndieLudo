/**
 * Browser test for v3.8's match history: the History tab on the home screen and a match's own page.
 * Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySurrender, createGameState } from '../src/shared/rules.js';
import type { Color, GameState, PlayerStats } from '../src/shared/types.js';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

const stats = (o: Partial<PlayerStats>, rolls: number[]): PlayerStats => ({
  cells: 0,
  captures: 0,
  sixes: rolls[5],
  revenges: 0,
  firstBlood: false,
  owed: {},
  rolls,
  ...o,
});

describe.skipIf(!CHROME || !BUILT)('match history', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;

  beforeAll(async () => {
    t = await setup();
    alice = await t.phone('alice');
    const me = t.server.ctx.users.getByName('alice')!;
    const bob = t.server.ctx.users.create('bob');
    const save = (s: GameState, endedAt: number) =>
      t.server.ctx.db
        .prepare('INSERT INTO games (id, lobby_id, state_json, version, updated_at, finished) VALUES (?, ?, ?, ?, ?, 1)')
        .run(s.id, 'L', JSON.stringify(s), 9, endedAt);
    const seat = (color: Color, userId: number | null, username: string, avatar?: string) => ({
      color,
      userId,
      username,
      ...(avatar && { avatar }),
      controller: userId === null ? ('bot' as const) : ('human' as const),
      connected: true,
    });
    const now = Date.now();
    // A Classic game alice won, with power ups.
    const g1 = createGameState({
      id: 'h1',
      lobbyId: 'L',
      seats: [seat('red', me.id, 'alice', me.avatar), seat('green', bob.id, 'bob'), seat('yellow', null, 'Bot Yellow')],
      now: now - 25 * 60_000,
      powerUps: { seed: 3 },
    });
    g1.stats = {
      red: stats({ cells: 120, captures: 4, homeRuns: 4, firstBlood: true, staches: 2 }, [6, 7, 5, 8, 6, 11]),
      green: stats({ cells: 98, captures: 1, revenges: 1, homeRuns: 2, staches: 1 }, [9, 6, 7, 6, 8, 5]),
      yellow: stats({ cells: 80, homeRuns: 1, staches: 1 }, [7, 8, 9, 5, 6, 4]),
    };
    applySurrender(g1, 'yellow');
    applySurrender(g1, 'green');
    save(g1, now - 4 * 60_000);
    // A Team-up game from yesterday, alice not in it.
    const g2 = createGameState({
      id: 'h2',
      lobbyId: 'L',
      seats: [seat('red', bob.id, 'bob'), seat('green', null, 'Bot Green'), seat('yellow', null, 'Bot Yellow'), seat('blue', null, 'Bot Blue')],
      now: now - 26 * 3600_000,
      teams: true,
      golden: { red: 1 },
    });
    g2.stats = { blue: stats({ cells: 140, captures: 3 }, [8, 8, 8, 8, 8, 8]) };
    applySurrender(g2, 'red');
    save(g2, now - 25.5 * 3600_000);
  });
  afterAll(() => t?.close());

  it('the History tab lists every match, newest first, with places, winners and awards; "Mine" only mine', async () => {
    await tap(alice, '#tab-history');
    await until('two matches', async () => (await alice.$$('.match-card')).length === 2);
    const first = await alice.$eval('.match-card', (c) => (c as HTMLElement).innerText.replace(/\s+/g, ' '));
    expect(first).toMatch(/^Today, .*⏱ 21 min/);
    expect(first).toMatch(/Classic.*3 players.*Power ups/);
    expect(first).toMatch(/1st .*alice ?you/i);
    expect(await alice.$$eval('.match-card:first-child .mp.won .crown', (x) => x.length)).toBe(1);
    expect(await alice.$eval('.match-card:nth-child(2)', (c) => (c as HTMLElement).innerText)).toMatch(/Yesterday[\s\S]*Team-up[\s\S]*Golden/);
    await sleep(400);
    await shot(alice, 'history-list');
    await tap(alice, '.history-scope [data-scope=mine]');
    await until('only mine', async () => (await alice.$$('.match-card')).length === 1);
    await tap(alice, '.history-scope [data-scope=all]');
    await until('all again', async () => (await alice.$$('.match-card')).length === 2);
  });

  it('a match opens whole: podium, awards, stats and dice luck; back returns to the history', async () => {
    await tap(alice, '.match-card .match-open');
    await alice.waitForSelector('.screen-match .podium-row');
    expect(await alice.$eval('.screen-match h2', (x) => x.textContent)).toBe('You won');
    expect(await alice.$$eval('.screen-match .award', (xs) => xs.length)).toBeGreaterThan(2);
    await sleep(900);
    await shot(alice, 'history-match');
    await tap(alice, '#tab-odds');
    await alice.waitForSelector('#panel-odds:not([hidden]) .odds-table');
    await alice.$eval('#panel-odds', (x) => x.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await shot(alice, 'history-dice-luck');
    await tap(alice, '#back');
    await alice.waitForSelector('.screen-home #panel-history:not([hidden]) .match-card');
    expect(t.errors).toEqual([]);
  });
  it("the admin deletes one match, then the rest, and resets a player's stats", async () => {
    const mine = t.server.ctx.sessions.list().find((s) => s.username === 'alice')!;
    t.server.ctx.sessions.setAdmin(mine.id, true);
    t.server.ctx.users.recordGame(t.server.ctx.users.getByName('alice')!.id, true);
    await alice.reload({ waitUntil: 'networkidle0' });
    await tap(alice, '#play');
    await alice.waitForSelector('.screen-home');
    await tap(alice, '#menu');
    await alice.waitForSelector('.menu-item');
    await alice.$$eval('.menu-item', (bs) => (bs.find((b) => b.textContent!.includes('Admin panel')) as HTMLElement).click());
    await alice.waitForSelector('.screen-admin');
    await tap(alice, '.screen-admin .tabs button[data-tab=history]');
    await until('two rows', async () => (await alice.$$('#panel .admin-list li[data-id^="h"]')).length === 2);
    await sleep(300);
    await shot(alice, 'admin-history');
    await tap(alice, '#panel li[data-id="h2"] [data-act=delete]');
    await alice.waitForSelector('.modal');
    await alice.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Delete') as HTMLElement).click());
    await until('one row', async () => (await alice.$$('#panel .admin-list li[data-id^="h"]')).length === 1);
    await tap(alice, '#delete-all');
    await alice.waitForSelector('.modal');
    await alice.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Delete all') as HTMLElement).click());
    await until('none', async () => (await alice.$$('#panel .admin-list li[data-id^="h"]')).length === 0);
    expect(t.server.ctx.history.list().matches).toEqual([]);
    await tap(alice, '.screen-admin .tabs button[data-tab=users]');
    await alice.waitForSelector('#panel [data-act=reset]');
    await sleep(300);
    await shot(alice, 'admin-users-reset');
    const id = t.server.ctx.users.getByName('alice')!.id;
    await tap(alice, `#panel li[data-id="${id}"] [data-act=reset]`);
    await alice.waitForSelector('.modal');
    await alice.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Reset') as HTMLElement).click());
    await until('reset', () => t.server.ctx.users.get(id)!.wins === 0);
    expect(t.errors).toEqual([]);
  });
});
