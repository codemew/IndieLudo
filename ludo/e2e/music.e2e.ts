/**
 * Browser tests: the lobby music starts once every seat is taken (a bot filling a seat counts),
 * stops repeating when the game starts, and loops again after the match. Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySurrender } from '../src/shared/rules.js';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

/** What the music is doing on a phone: play-throughs going (two in a crossfade), and whether a repeat is lined up. */
const musicOn = (p: Page) =>
  p.evaluate(() => (window as unknown as { __music?: { voices: number; repeating: boolean } }).__music ?? { voices: -1, repeating: false });
/** A real finger on the screen: the page may only make sound after one. */
const touch = (p: Page) => p.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));

describe.skipIf(!CHROME || !BUILT)('lobby music', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let phones: Page[];
  const fetched = new Map<Page, number>();

  beforeAll(async () => {
    t = await setup({
      onPage: async (p) => {
        fetched.set(p, 0);
        p.on('request', (r) => r.url().includes('/assets/lobby-') && r.url().endsWith('.mp3') && fetched.set(p, (fetched.get(p) ?? 0) + 1));
      },
    });
    phones = await t.lobby(['alice', 'bob']);
    for (const p of phones) await touch(p);
  });
  afterAll(() => t?.close());

  it('quiet with seats open; with two people and two bots filling the seats, it plays and repeats on every phone', async () => {
    await sleep(800);
    for (const p of phones) expect((await musicOn(p)).voices).toBe(0);
    for (const p of phones) expect(fetched.get(p)).toBe(0);
    await tap(phones[0], '#fill-bots');
    for (const p of phones) await until('music', async () => (await musicOn(p)).voices === 1, 8000);
    for (const p of phones) expect((await musicOn(p)).repeating).toBe(true);
    for (const p of phones) expect(fetched.get(p)).toBe(1);
    await shot(phones[1], 'music-lobby');
  });

  it('once the game starts it plays on without repeating; after the match it loops again', async () => {
    await tap(phones[1], '.bottom-bar .btn');
    await phones[0].waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(phones[0], '.bottom-bar .btn-primary');
    await Promise.all(phones.map((p) => p.waitForSelector('.screen-game')));
    for (const p of phones) await until('no repeat', async () => !(await musicOn(p)).repeating, 5000);
    for (const p of phones) expect((await musicOn(p)).voices).toBe(1);
    // The match ends: both bots give up, then bob.
    const game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    for (const s of game.seats.filter((x) => x.controller === 'bot')) applySurrender(game, s.color);
    const bob = game.seats.find((s) => s.username === 'bob')!;
    expect(t.server.ctx.games.surrender(bob.userId!, { gameId: game.id, actionId: 'surrender-bob' }).ok).toBe(true);
    await Promise.all(phones.map((p) => p.waitForSelector('.screen-results', { timeout: 10_000 })));
    for (const p of phones) await until('looping again', async () => (await musicOn(p)).repeating, 5000);
    // Back in the lobby (the bots have left their seats): still looping.
    await tap(phones[0], '#lobby');
    await phones[0].waitForSelector('.screen-lobby');
    await sleep(500);
    expect(await musicOn(phones[0])).toMatchObject({ voices: 1, repeating: true });
    expect(t.errors).toEqual([]);
  });
});
