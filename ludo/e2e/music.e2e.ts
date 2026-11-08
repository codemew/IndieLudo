/**
 * Browser tests: the lobby music (starts only with every seat a person's, repeats with a crossfade
 * until the game starts) and the admin panel's resets. Run with `npm run test:e2e`.
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT, CHROME, setup, shot, sleep, tap, until } from './helpers.js';

/** How many play-throughs of the music each phone has going, read from its Web Audio graph. */
const playingOn = (p: Page) => p.evaluate(() => (window as unknown as { __music?: { playing: boolean; voices: number } }).__music?.voices ?? -1);
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
    phones = await t.lobby(['alice', 'bob', 'carol']);
    for (const p of phones) await touch(p);
  });
  afterAll(() => t?.close());

  it('not with three people and a bot', async () => {
    await tap(phones[0], '#fill-bots');
    await until('the bot', async () => (await phones[0].$$('.seat.s-blue:not(.seat-open)')).length === 1);
    await sleep(800);
    for (const p of phones) expect(fetched.get(p)).toBe(0);
    for (const p of phones) expect(await playingOn(p)).toBe(0);
    await phones[0].$$eval('.seat.s-blue .chip', (cs) => (cs.find((c) => /Remove/.test(c.textContent ?? '')) as HTMLElement | undefined)?.click());
    await until('the seat open again', async () => (await phones[0].$$('.seat.s-blue.seat-open')).length === 1);
  });

  it('starts on every phone once the fourth person sits down, and keeps going with no repeat once the game starts', async () => {
    const dave = await t.phone('dave');
    await touch(dave);
    await dave.waitForSelector('.lobby-card');
    await tap(dave, '.lobby-card');
    await dave.waitForSelector('.modal input');
    await dave.type('.modal input', 'pw');
    await tap(dave, '.modal .btn-primary');
    await dave.waitForSelector('.screen-lobby');
    phones.push(dave);
    for (const p of phones) await until('music', async () => (await playingOn(p)) === 1, 8000);
    for (const p of phones) expect(fetched.get(p)).toBe(1);
    await shot(dave, 'music-lobby');
    // Start the game: the music plays on, and no repeat is lined up.
    for (const p of phones.slice(1)) await tap(p, '.bottom-bar .btn');
    await phones[0].waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(phones[0], '.bottom-bar .btn-primary');
    await Promise.all(phones.map((p) => p.waitForSelector('.screen-game')));
    for (const p of phones) expect(await playingOn(p)).toBe(1);
    expect(await phones[0].evaluate(() => (window as unknown as { __music: { repeating: boolean } }).__music.repeating)).toBe(false);
    expect(t.errors).toEqual([]);
  });
});
