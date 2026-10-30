/**
 * Browser tests for v3.2: the wildcard entry (hold your home tokens), Team-up, the stacked-token
 * picker's neighbours (the lap markers, which must take real taps), and the results screen with
 * long names and many awards. Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE as B, HOME as H, absoluteSquare } from '../src/shared/board.js';
import type { Color, GameState, PlayerStats } from '../src/shared/types.js';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

/** The centre of an element on screen, for real (hit-tested) touches. */
const centre = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
/** What a finger at the centre of `sel` would actually touch. */
const hit = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(top && (top === e || e.contains(top)));
  });
const hold = async (p: Page, sel: string, ms = 700) => {
  const { x, y } = await centre(p, sel);
  await p.touchscreen.touchStart(x, y);
  await sleep(ms);
  await p.touchscreen.touchEnd();
};

describe.skipIf(!CHROME || !BUILT)('wildcard entry and real taps on the board', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let game: GameState;
  let a: Color;
  let aliceId: number;
  /** Re-sends the game to every phone after the test changed it on the server. */
  const nudge = () => t.server.ctx.games.renameUser(aliceId, 'alice');
  const turnOf = () => game.seats[game.turn.seat].color;

  beforeAll(async () => {
    t = await setup();
    [alice, bob] = await t.lobby(['alice', 'bob']);
    await tap(alice, '#fill-bots');
    await tap(bob, '.bottom-bar .btn');
    await alice.waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(alice, '.bottom-bar .btn-primary');
    await Promise.all([alice.waitForSelector('.screen-game'), bob.waitForSelector('.screen-game')]);
    game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    a = game.seats.find((s) => s.username === 'alice')!.color;
    aliceId = game.seats.find((s) => s.username === 'alice')!.userId!;
  });
  afterAll(() => t?.close());

  it('holding the home triangle opens the wildcard sheet; a short tap says to hold', async () => {
    game.tokens[a] = [H, H, 10, B];
    nudge();
    await alice.waitForSelector('#holds .home-hold');
    expect(await bob.$('#holds .home-hold')).toBeNull(); // only for your own home
    // The home tokens let the touch through to the zone underneath.
    expect(await hit(alice, '#holds .home-hold')).toBe(true);
    const { x, y } = await centre(alice, '#holds .home-hold');
    await alice.touchscreen.tap(x, y);
    await until('the hint', async () => (await alice.$$eval('.toast', (ts) => ts.map((x) => x.textContent).join(' '))).includes('Hold your home tokens'));
    await hold(alice, '#holds .home-hold');
    await alice.waitForSelector('.wildcard-sheet');
    expect(await alice.$$eval('.wc-card', (cs) => cs.map((c) => (c as HTMLElement).dataset.token))).toEqual(['0', '1']);
    expect(await alice.$eval('.wc-send', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await tap(alice, '.wc-card[data-token="0"]');
    expect(await alice.$eval('.wc-send', (b) => b.textContent)).toContain('Send back (1)');
    await shot(alice, 'wildcard-sheet');
    await tap(alice, '.wc-send');
    // Everyone sees the banner, and the token flies back to base.
    await Promise.all([alice.waitForSelector('.wildcard-banner', { timeout: 5000 }), bob.waitForSelector('.wildcard-banner', { timeout: 5000 })]);
    expect(await bob.$eval('.wildcard-banner', (b) => b.textContent)).toMatch(/Wildcard entry[\s\S]*alice is back for more · beware!/);
    await sleep(900);
    await shot(bob, 'wildcard-banner');
    expect(game.tokens[a][0]).toBe(B);
    expect(game.extraLaps?.[a]).toEqual([1, 0, 0, 0]);
    await until('the chip', async () => (await bob.$eval(`.pchip[data-color=${a}] .pchip-sub`, (x) => x.textContent)) === '1/4 home', 8000);
    // Token 0 used its extra lap: even home again, it isn't offered.
    game.tokens[a][0] = H;
    nudge();
    await sleep(2600);
    await hold(alice, '#holds .home-hold');
    await alice.waitForSelector('.wildcard-sheet');
    expect(await alice.$$eval('.wc-card', (cs) => cs.map((c) => (c as HTMLElement).dataset.token))).toEqual(['1']);
    await tap(alice, '.modal-actions .btn');
    await sleep(300);
    expect(t.errors).toEqual([]);
  });

  it('a finished player may go again: they give up their place', async () => {
    game.tokens[a] = [H, H, H, H];
    game.extraLaps = {};
    game.ranks = [a];
    nudge();
    await alice.waitForSelector('#holds .home-hold');
    await hold(alice, '#holds .home-hold');
    await alice.waitForSelector('.wildcard-sheet');
    expect(await alice.$eval('.wc-rank', (x) => x.textContent)).toContain('You finished 🥇');
    await tap(alice, '.wc-card[data-token="3"]');
    await tap(alice, '.wc-send');
    await until('unranked', () => game.ranks.length === 0, 5000);
    await until('the toast', async () => (await bob.$$eval('.toast', (ts) => ts.map((x) => x.textContent).join(' '))).includes('gave up 🥇 for a wildcard entry'), 5000);
    game.tokens[a] = [B, B, B, B];
    game.extraLaps = {};
  });

  it('the gold and blue lap markers take real taps (the token layer lets them through)', async () => {
    await until("alice's turn", async () => {
      if (turnOf() !== a && game.turn.phase === 'rolling' && game.seats[game.turn.seat].controller === 'human' && (await bob.$('.dice.can-roll'))) {
        t.dice.push(1);
        await tap(bob, '.dice.can-roll');
        await sleep(300);
      }
      return turnOf() === a && game.turn.phase === 'rolling' && (await alice.$('.dice.can-roll')) !== null;
    }, 30_000);
    game.tokens[a] = [48, B, B, B];
    t.dice.push(5);
    await tap(alice, '.dice.can-roll');
    await alice.waitForSelector('#targets .target.round[data-token]', { timeout: 8000 });
    await sleep(600);
    expect(await hit(alice, '#targets .target.round[data-token]')).toBe(true);
    const { x, y } = await centre(alice, '#targets .target.round[data-token]');
    await alice.touchscreen.tap(x, y);
    await until('the lap', () => game.tokens[a][0] === 59, 8000);
    game.tokens[a] = [B, B, B, B];
  });
});

describe.skipIf(!CHROME || !BUILT)('Team-up', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let game: GameState;
  beforeAll(async () => {
    t = await setup();
    [alice, bob] = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('the host switches the lobby to Team-up; seats show the pairs; it needs all four seats', async () => {
    await tap(alice, '.mode-opt[data-teams="1"]');
    for (const p of [alice, bob]) await until('team-up on', async () => (await p.$eval('.mode-opt.on', (b) => (b as HTMLElement).dataset.teams)) === '1');
    expect(await bob.$eval('.mode-opt[data-teams="0"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(await alice.$$eval('.team-tag', (ts) => ts.length)).toBe(4);
    // Alice is red: bob moves to yellow, her partner.
    await bob.$eval('.seat-open.s-yellow .chip', (c) => (c as HTMLElement).click());
    await until('bob on yellow', async () => (await alice.$('.seat.s-yellow:not(.seat-open)')) !== null);
    expect(await alice.$$eval('.seat-open .chip', (cs) => cs.map((c) => c.textContent).filter((x) => x!.includes('Bot')))).toEqual(['＋ Bot opponent', '＋ Bot opponent']);
    await tap(bob, '.bottom-bar .btn');
    await until('the hint', async () => (await alice.$eval('.action-hint', (h) => h.textContent)) === 'Team-up needs all 4 seats: fill the open ones with bots?');
    expect(await alice.$eval('#start', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await shot(alice, 'teamup-lobby');
    await tap(alice, '#fill-bots');
    await alice.waitForSelector('#start:not(:disabled)');
    await tap(alice, '#start');
    await Promise.all([alice.waitForSelector('.screen-game'), bob.waitForSelector('.screen-game')]);
    game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    expect(game.teams).toBe(true);
    await until('the line-up', async () => (await alice.$$eval('.toast', (ts) => ts.map((x) => x.textContent).join(' '))).includes('Team-up: you & bob vs Bot Green & Bot Blue'));
    expect(await alice.$eval('.pchip[data-color=red] .pchip-mate', (m) => [(m as HTMLElement).hidden, m.className])).toEqual([false, 'pchip-mate m-yellow']);
  });

  it('capturing your teammate asks first, then shows friendly fire and shrinks the moustache', async () => {
    await until("alice's turn", () => game.seats[game.turn.seat].color === 'red' && game.turn.phase === 'rolling', 20_000);
    await alice.waitForSelector('.dice.can-roll');
    // Red's 13 + 2 lands on yellow's 41 (absolute 15); red's other token gives a second choice.
    expect(absoluteSquare('yellow', 41)).toBe(absoluteSquare('red', 15));
    game.tokens.red = [13, 30, B, B];
    game.tokens.yellow = [41, B, B, B];
    game.kills = { red: [3, 0, 0, 0] };
    t.dice.push(2);
    await tap(alice, '.dice.can-roll');
    await alice.waitForSelector('.token.legal');
    await sleep(500);
    await alice.$$eval('.token.legal', (ts) => (ts.find((x) => x.getAttribute('aria-label')!.endsWith('token 1')) as HTMLElement).click());
    await alice.waitForSelector('.modal');
    expect(await alice.$eval('.modal h2', (h) => h.textContent)).toBe('Capture your teammate?');
    await alice.$$eval('.modal .btn', (bs) => (bs.find((b) => b.textContent === 'Capture anyway') as HTMLElement).click());
    await until('the capture', () => game.tokens.yellow[0] === B, 8000);
    expect(game.kills!.red![0]).toBe(2);
    expect(game.stats?.red?.friendlyFire).toBe(1);
    expect(game.stats?.red?.captures).toBe(0);
    await until('the callout', async () => (await bob.$$eval('.callout b', (cs) => cs.map((c) => c.textContent))).includes('Friendly fire!'), 6000);
  });

  it('both partners home: their team wins, on everyone’s results', async () => {
    await until("alice's bonus roll", async () => game.seats[game.turn.seat].color === 'red' && game.turn.phase === 'rolling' && (await alice.$('.dice.can-roll')) !== null, 15_000);
    game.tokens.yellow = [H, H, H, H];
    game.ranks = ['yellow'];
    game.tokens.red = [H, H, H, 55];
    t.dice.push(1);
    await tap(alice, '.dice.can-roll');
    await Promise.all([alice.waitForSelector('.results', { timeout: 15_000 }), bob.waitForSelector('.results', { timeout: 15_000 })]);
    for (const p of [alice, bob]) {
      expect(await p.$eval('.results h2', (h) => h.textContent)).toBe('Your team won!');
      expect(await p.$$eval('.podium-row .crown', (cs) => cs.length)).toBe(2);
      expect(await p.$$eval('.podium-row .place', (ps) => ps.map((x) => x.textContent))).toEqual(['1st', '1st', '2nd', '2nd']);
    }
    expect(await alice.$$eval('.award', (as) => as.map((x) => x.querySelector('b')!.textContent))).toContain('Et tu, Brute?');
    await shot(alice, 'teamup-results');
    expect(t.errors).toEqual([]);
  });
});

describe.skipIf(!CHROME || !BUILT)('results with long names and many awards', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    t = await setup();
  });
  afterAll(() => t?.close());

  it('every award stays inside its row, and nothing scrolls sideways', async () => {
    const [w, m] = await t.lobby(['Wwwwwwwwwwwwwww1', 'Mmmmmmmmmmmmmmm2']);
    await tap(m, '.bottom-bar .btn');
    await w.waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(w, '.bottom-bar .btn-primary');
    await Promise.all([w.waitForSelector('.screen-game'), m.waitForSelector('.screen-game')]);
    const game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    const [first, second] = game.seats;
    const stat = (s: Partial<PlayerStats>): PlayerStats => ({ cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {}, ...s });
    game.stats = {
      [first.color]: stat({ cells: 120, captures: 6, sixes: 4, revenges: 2, machoHome: 2, staches: 3, homeRuns: 5, risks: 3, firstBlood: true }),
      [second.color]: stat({ cells: 80, staches: 1 }),
    };
    t.server.ctx.games.surrender(second.userId!, { gameId: game.id, actionId: crypto.randomUUID() });
    for (const p of [w, m]) {
      await p.waitForSelector('.results', { timeout: 15_000 });
      await sleep(1500); // the rows animate in
      const bad = await p.$$eval('.podium-row', (rows) =>
        rows.flatMap((row) => {
          const r = row.getBoundingClientRect();
          return [...row.querySelectorAll('.podium-awards, .crown, .podium-name')].filter((x) => {
            const b = x.getBoundingClientRect();
            return b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5;
          }).map((x) => x.className);
        }),
      );
      expect(bad).toEqual([]);
      const awardsOut = await p.$$eval('.award', (as) =>
        as.flatMap((row) => {
          const r = row.getBoundingClientRect();
          return [...row.querySelectorAll('.aw-who, .aw-val, .aw-icon')].filter((x) => x.getBoundingClientRect().right > r.right + 0.5).map((x) => x.className);
        }),
      );
      expect(awardsOut).toEqual([]);
      for (const width of [390, 360]) {
        await p.setViewport({ width, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await sleep(200);
        const over = await p.evaluate(() => {
          const res = document.querySelector('.results')!;
          const right = res.getBoundingClientRect().right;
          return [...res.querySelectorAll('*')].filter((x) => !x.closest('.confetti') && x.getBoundingClientRect().right > right + 0.5).map((x) => x.tagName + '.' + x.className);
        });
        expect(over, `at ${width} px`).toEqual([]);
      }
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(await w.$$eval('.podium-row:first-child .podium-awards > span', (s) => s.length)).toBeGreaterThanOrEqual(7);
    expect(await w.$('.award .steel-ball')).not.toBeNull();
    expect(await w.$$eval('.stats-table thead th[scope=col]', (h) => h.map((x) => x.textContent))).toContain('🏠Home');
    await shot(w, 'results-long-names');
    expect(t.errors).toEqual([]);
  });
});
