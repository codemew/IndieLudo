/**
 * Browser tests for v3.7's optional rules: power ups (orbs on the stars; 2x, shield, cloak, vampire)
 * and the golden token. Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, boardOf, laneEntry, raidProgress } from '../src/shared/board.js';
import type { Color, GameState } from '../src/shared/types.js';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

const toastsOf = (p: Page) => p.$$eval('#toasts .toast, .callout', (ts) => ts.map((x) => x.textContent ?? '').join(' | '));

describe.skipIf(!CHROME || !BUILT)('power ups and the golden token', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let game: GameState;
  let a: Color;
  let b: Color;
  let aliceId: number;
  const B4 = boardOf(4);
  /** Re-sends the game to every phone after the test changed it on the server. */
  const nudge = () => t.server.ctx.games.updateUser(aliceId, { username: 'alice', avatar: t.server.ctx.users.get(aliceId)!.avatar });
  /** Alice to roll, with this die coming up. */
  const aliceRolls = async (die: number) => {
    game.turn = { ...game.turn, seat: game.seats.findIndex((s) => s.color === a), phase: 'rolling', queue: [], sixes: 0, bonus: 0 };
    nudge();
    await sleep(400);
    t.dice.push(die);
    await alice.waitForSelector('#dice-slot .dice.can-roll');
    await tap(alice, '#dice-slot .dice');
  };

  beforeAll(async () => {
    t = await setup();
    [alice, bob] = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('the host switches them on in the lobby; everyone sees them on', async () => {
    await tap(alice, '#powerups');
    await tap(alice, '#golden');
    await until('bob sees both', async () => (await bob.$$eval('#powerups, #golden', (xs) => xs.map((x) => (x as HTMLInputElement).checked))).every(Boolean));
    expect(await bob.$eval('#powerups', (x) => (x as HTMLInputElement).disabled)).toBe(true);
    expect(await alice.$eval('#powerups-rule', (x) => x.textContent)).toMatch(/Double move[\s\S]*Shield[\s\S]*Invisibility cloak[\s\S]*Vampire/);
    await alice.$eval('#golden-rule', (x) => x.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await shot(alice, 'powers-lobby');
    await tap(bob, '.bottom-bar .btn');
    await alice.waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(alice, '.bottom-bar .btn-primary');
    await Promise.all([alice.waitForSelector('.screen-game'), bob.waitForSelector('.screen-game')]);
    game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    a = game.seats.find((s) => s.username === 'alice')!.color;
    b = game.seats.find((s) => s.username === 'bob')!.color;
    aliceId = game.seats.find((s) => s.username === 'alice')!.userId!;
  });

  it('an orb on every star, and a crowned golden token each', async () => {
    for (const p of [alice, bob]) {
      await until('orbs', async () => (await p.$$('#orbs .orb')).length === 4);
      expect(await p.$$eval('.token.golden .tok-crown', (xs) => xs.length)).toBe(2);
    }
    await sleep(600);
    await shot(alice, 'powers-start');
    expect((await alice.$$eval('#orbs .orb', (os) => os.map((o) => o.getAttribute('aria-label') ?? ''))).join(' ')).toMatch(/Double move power-up/);
  });

  it("each power wears its badge; an opponent's cloaked token isn't on their board at all", async () => {
    game.orbs = game.orbs!.slice(0, 2);
    game.powers = { [a]: ['shield', 'double', 'cloak', null], [b]: ['vampire', null, null, null] };
    game.tokens[a] = [4, 17, 30, BASE];
    game.tokens[b] = [2, BASE, BASE, BASE];
    nudge();
    await until('badges', async () => (await alice.$$('.tok-badge')).length === 4);
    expect(await alice.$eval(`.token.t-${a}.pw-cloak`, (x) => x.classList.contains('unseen'))).toBe(false);
    expect(await bob.$eval(`.token.t-${a}.pw-cloak`, (x) => x.classList.contains('unseen'))).toBe(true);
    expect(await bob.$eval(`.token.t-${a}.pw-cloak`, (x) => getComputedStyle(x).visibility)).toBe('hidden');
    await sleep(500);
    await shot(alice, 'powers-badges-owner');
    await shot(bob, 'powers-badges-opponent');
    expect(t.errors).toEqual([]);
  });

  it('landing on an orb takes its power, with everyone told', async () => {
    const star = [...B4.stars].find((s) => game.orbs!.some((o) => o.square === s))!;
    const power = game.orbs!.find((o) => o.square === star)!.power;
    // Alice's token 3 three squares short of that star.
    const p = (star - B4.start[a]! + 52) % 52;
    game.tokens[a] = [BASE, BASE, BASE, p - 3];
    game.powers = {};
    // No golden tokens for this one: a golden token in base could leave with the 3 too, a second choice.
    game.golden = {};
    game.tokens[b] = [BASE, BASE, BASE, BASE];
    await aliceRolls(3);
    await until('the power', () => game.powers?.[a]?.[3] === power, 8000);
    await until('the callout on bob', async () => /got it/.test(await toastsOf(bob)), 5000);
    await sleep(150);
    await shot(bob, 'powers-pickup');
    await until('badge', async () => (await alice.$$(`.token.t-${a}.pw-${power} .tok-badge`)).length === 1, 5000);
  });

  it("a vampire can raid an opponent's home column: asked which way, and it captures there", async () => {
    await sleep(1500);
    const entry = laneEntry(b, B4);
    const p = (entry - B4.start[a]! + 52) % 52;
    game.orbs = [];
    game.powers = { [a]: ['vampire', null, null, null] };
    game.tokens[a] = [p - 2, BASE, BASE, BASE];
    game.tokens[b] = [B4.last + 2, BASE, BASE, BASE];
    await aliceRolls(4);
    await alice.waitForSelector(`.token.t-${a}.legal`);
    await sleep(300);
    await tap(alice, `.token.t-${a}.legal`);
    await alice.waitForSelector('.lap-opt.raid');
    expect(await alice.$eval('.lap-opt.raid', (x) => x.getAttribute('aria-label'))).toContain("Raid bob's home column, captures bob");
    await sleep(300);
    await shot(alice, 'powers-vampire-choice');
    await tap(alice, '.lap-opt.raid');
    await until('raided', () => game.tokens[a][0] === raidProgress(b, 2), 5000);
    expect(game.tokens[b][0]).toBe(BASE);
    await sleep(2500);
    await shot(bob, 'powers-vampire-raided');
    expect(t.errors).toEqual([]);
  });
});
