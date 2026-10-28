/**
 * Browser smoke tests: real phones (headless Chrome at phone size) against a real server, for the
 * things that only show up in the UI. Run with `npm run test:e2e`; skipped when Chrome isn't found
 * (set CHROME_PATH to point at one).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, mergeConfig } from '../src/server/config.js';
import { startServer, type LudoServer } from '../src/server/server.js';
import { BASE as B, HOME } from '../src/shared/board.js';
import type { Color, GameState } from '../src/shared/types.js';

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
const BUILT = existsSync('dist/client/index.html');
const SHOTS = process.env.E2E_SHOTS; // a folder to save screenshots in, if set

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ok()) return;
  throw new Error(`timed out waiting for ${what}`);
};

/** A server with scripted dice, and phones that sign in and join one lobby. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ludo-e2e-'));
  const dice: number[] = [];
  const server: LudoServer = await startServer(
    mergeConfig(DEFAULTS, { lobbyCreatePassword: 'create', adminPassword: 'admin', dbPath: ':memory:', port: 0, turnTimeoutSec: 120, https: { enabled: false }, certDir: dir, voice: { iceServers: [] } }),
    { dice: () => dice.shift() ?? 1, randomInt: () => 0, log: () => {}, gateDelayMs: 0 },
  );
  const url = `http://localhost:${server.port}`;
  const browser: Browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  const errors: string[] = [];

  async function phone(name: string): Promise<Page> {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${name}] ${(e as Error).message}`));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(url, { waitUntil: 'networkidle0' });
    await tap(p, '#play');
    await p.waitForSelector('#otp-input');
    await p.type('#otp-input', server.ctx.gate.current);
    await p.waitForSelector('#username');
    await p.type('#username', name);
    await tap(p, '#go');
    await p.waitForSelector('.screen-home');
    return p;
  }

  /** Alice hosts "Family"; everyone else joins it. */
  async function lobby(names: string[]): Promise<Page[]> {
    const phones = await Promise.all(names.map(phone));
    const [host, ...rest] = phones;
    await tap(host, '#create');
    await host.waitForSelector('.modal [name=name]');
    await host.type('.modal [name=name]', 'Family');
    await host.type('.modal [name=password]', 'pw');
    await host.type('.modal [name=createPassword]', 'create');
    await tap(host, '.modal .btn-primary');
    await host.waitForSelector('.screen-lobby');
    for (const p of rest) {
      await p.waitForSelector('.lobby-card');
      await tap(p, '.lobby-card');
      await p.waitForSelector('.modal input');
      await p.type('.modal input', 'pw');
      await tap(p, '.modal .btn-primary');
      await p.waitForSelector('.screen-lobby');
    }
    await sleep(400);
    return phones;
  }

  const close = async () => {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { server, dice, errors, phone, lobby, close };
}

async function tap(p: Page, sel: string): Promise<void> {
  await p.waitForSelector(sel, { timeout: 10_000 });
  await p.$eval(sel, (e) => (e as HTMLElement).click());
}
const shot = (p: Page, name: string) => (SHOTS ? p.screenshot({ path: join(SHOTS, `${name}.png`) }) : Promise.resolve());
/** Where the board sits on screen; it must never move while a game is on. */
const boardBox = (p: Page) => p.$eval('#board', (b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.top)}/${Math.round(r.height)}`; });
/** Each occupied seat in the lobby as "colour:name". */
const seats = (p: Page) => p.$$eval('.seat:not(.seat-open)', (ss) => ss.map((s) => `${s.className.match(/s-(\w+)/)![1]}:${s.querySelector('.seat-name')!.childNodes[0].textContent!.trim()}`));

describe.skipIf(!CHROME || !BUILT)('lobby seats', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  beforeAll(async () => {
    t = await setup();
    [alice, bob] = await t.lobby(['alice', 'bob']);
  });
  afterAll(() => t?.close());

  it('"+ Bot" puts the bot on the seat that was tapped, named after that colour', async () => {
    for (let i = 0; i < 2; i++) {
      const tapped = await alice.$eval('.seat-open', (s) => s.className.match(/s-(\w+)/)![1]);
      await alice.$eval('.seat-open', (s) => ([...s.querySelectorAll('.chip')].find((c) => c.textContent!.includes('Bot')) as HTMLElement).click());
      await until('the bot to sit', async () => (await seats(alice)).some((x) => x.startsWith(`${tapped}:`)));
      const name = tapped[0].toUpperCase() + tapped.slice(1);
      expect(await seats(alice)).toContain(`${tapped}:Bot ${name}`);
    }
  });

  it('a bot that swaps seats takes the name of its new colour, on every phone', async () => {
    const bobWas = (await seats(bob)).find((x) => x.endsWith(':bob'))!.split(':')[0];
    const botWas = await bob.$$eval('.seat', (ss) => {
      const s = ss.find((x) => x.textContent!.includes('Bot'))!;
      (s.querySelector('.chip:not(.chip-danger)') as HTMLElement).click();
      return s.className.match(/s-(\w+)/)![1];
    });
    const cap = (c: string) => c[0].toUpperCase() + c.slice(1);
    await until('the swap', async () => (await seats(alice)).includes(`${botWas}:bob`));
    for (const p of [alice, bob]) {
      const now = await seats(p);
      expect(now).toContain(`${botWas}:bob`);
      expect(now).toContain(`${bobWas}:Bot ${cap(bobWas)}`);
      expect(now.filter((x) => x.includes('Bot')).every((x) => x === `${x.split(':')[0]}:Bot ${cap(x.split(':')[0])}`)).toBe(true);
    }
    await shot(alice, 'lobby-bots');
    expect(t.errors).toEqual([]);
  });
});

describe.skipIf(!CHROME || !BUILT)('the second lap and the macho award', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let game: GameState;
  let a: Color;
  let b: Color;
  const turnOf = () => game.seats[game.turn.seat].color;
  /** Passes bob's turns (a 1 with every token in base can't move) until it is alice's. */
  const aliceTurn = async () => {
    await until("alice's turn", async () => {
      if (turnOf() === b && game.turn.phase === 'rolling' && (await bob.$('.dice.can-roll'))) {
        t.dice.push(1);
        await tap(bob, '.dice.can-roll');
        await sleep(300);
      }
      return turnOf() === a && game.turn.phase === 'rolling' && (await alice.$('.dice.can-roll')) !== null;
    }, 25_000);
  };
  /** Alice rolls the die she's given, with her tokens placed where the test wants them. */
  const roll = async (die: number, tokens: number[]) => {
    await aliceTurn();
    game.tokens[a] = tokens;
    game.tokens[b] = [B, B, B, B];
    t.dice.push(die);
    await tap(alice, '.dice.can-roll');
    await alice.waitForSelector('.token.legal', { timeout: 8000 });
    await sleep(500);
  };
  const tapToken = (id: number) => alice.$$eval('.token.legal', (ts, id) => (ts.find((x) => x.getAttribute('aria-label')!.endsWith(`token ${id + 1}`)) as HTMLElement).click(), id);

  beforeAll(async () => {
    t = await setup();
    [alice, bob] = await t.lobby(['alice', 'bob']);
    await tap(bob, '.bottom-bar .btn');
    await alice.waitForSelector('.bottom-bar .btn-primary:not(:disabled)', { timeout: 10_000 });
    await tap(alice, '.bottom-bar .btn-primary');
    await Promise.all([alice.waitForSelector('.screen-game'), bob.waitForSelector('.screen-game')]);
    game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    a = game.seats.find((s) => s.username === 'alice')!.color;
    b = game.seats.find((s) => s.username === 'bob')!.color;
  });
  afterAll(() => t?.close());

  it('at its home turn the board shows both ways, and tapping the token offers the two choices', async () => {
    await aliceTurn();
    await sleep(600);
    const still = await boardBox(alice); // dice showing, empty queue
    await roll(5, [48, B, B, B]);
    expect(await boardBox(alice), 'dice gone and a die in the queue: the board stays put').toBe(still);
    const board = await alice.evaluate(() => ({
      home: document.querySelectorAll('.trail.home').length,
      round: document.querySelectorAll('.trail.round').length,
      markers: [...document.querySelectorAll<HTMLElement>('#targets .target[data-token]')].map((x) => x.dataset.lap),
    }));
    expect(board.home).toBeGreaterThan(0);
    expect(board.round).toBeGreaterThan(0);
    expect(board.markers.sort()).toEqual(['0', '1']);

    await tapToken(0);
    await alice.waitForSelector('.lap-opts');
    const cards = await alice.$$eval('.lap-opt', (cs) => cs.map((c) => c.querySelector('b')!.textContent));
    expect(cards).toEqual(['Head home', 'Go round again']);
    expect(await alice.$eval('.lap-opt.home', (c) => c.textContent)).toContain('3 squares to finish');
    expect(await alice.$eval('.lap-opt.round', (c) => c.textContent)).not.toMatch(/squares/); // the distance round is the player's risk to judge
    await sleep(600); // the sheet slides up
    const sheet = await alice.$eval('.modal', (m) => m.getBoundingClientRect().bottom <= innerHeight + 1);
    expect(sheet, 'the whole choice, with "Not now", fits on a phone screen').toBe(true);
    await shot(alice, 'lap-choice');
  });

  it('"Not now" closes the choice without moving', async () => {
    await alice.$$eval('.modal .btn', (bs) => (bs.find((x) => x.textContent!.includes('Not now')) as HTMLElement).click());
    await until('the choice to close', async () => (await alice.$('.lap-choice')) === null);
    await sleep(300);
    expect(game.tokens[a][0]).toBe(48);
    expect(await alice.$$('.token.legal')).toHaveLength(1);
  });

  it('"Go round again" sends the token round: it passes its start and gets the dashed ring', async () => {
    await tapToken(0);
    await alice.waitForSelector('.lap-opt.round');
    await tap(alice, '.lap-opt.round');
    await until('the move', () => game.tokens[a][0] === 59);
    for (const p of [alice, bob]) await p.waitForSelector(`.token.t-${a}.lap2[aria-label$="token 1"]`, { timeout: 5000 });
    expect(await alice.$('.lap-choice')).toBeNull();
  });

  it('tapping the gold marker on the board heads home without the dialog', async () => {
    await roll(5, [59, 48, B, B]);
    await alice.waitForSelector('.target.home[data-token="1"]');
    await tap(alice, '.target.home[data-token="1"]');
    await until('the move', () => game.tokens[a][1] === 53);
    expect(await alice.$('.lap-choice')).toBeNull();
  });

  it('bringing a moustached token home wins "Most macho" on the results screen', async () => {
    await aliceTurn();
    game.kills = { [a]: [2, 0, 0, 0] };
    await roll(3, [53, HOME, HOME, HOME]);
    if (game.tokens[a][0] !== HOME) await tapToken(0).catch(() => {}); // the only move plays itself; tap in case it hasn't yet
    await Promise.all([alice.waitForSelector('.award', { timeout: 15_000 }), bob.waitForSelector('.award', { timeout: 15_000 })]);
    await sleep(1500);
    for (const p of [alice, bob]) {
      const macho = await p.$$eval('.award', (as) => {
        const x = as.find((y) => y.querySelector('b')!.textContent === 'Most macho')!;
        return [x.querySelector('.aw-sub')!.textContent, x.querySelector('.aw-who')!.textContent, x.querySelector('.aw-val')!.textContent];
      });
      expect(macho).toEqual(['moustached tokens brought home', expect.stringMatching(/^alice( you)?$/), '1']);
    }
    expect(await alice.$$eval('.stats-table th, .stats-table thead *', (h) => h.map((x) => x.textContent).join(' '))).toContain('Macho');
    await shot(alice, 'results-macho');
    expect(t.errors).toEqual([]);
  });
});

describe.skipIf(!CHROME || !BUILT)('watching and bot battles', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: Page;
  let bob: Page;
  let carol: Page;
  let game: GameState;
  /** Joins from the home screen's lobby card with the password, choosing 👀 Watch. */
  const watchFromHome = async (p: Page) => {
    await p.waitForSelector('.lobby-card:not(:disabled)');
    await tap(p, '.lobby-card');
    await p.waitForSelector('.modal input');
    await p.type('.modal input', 'pw');
    await p.$$eval('.modal .btn', (bs) => (bs.find((x) => x.textContent!.includes('Watch')) as HTMLElement).click());
  };

  beforeAll(async () => {
    t = await setup();
    [alice] = await t.lobby(['alice']);
    bob = await t.phone('bob');
    carol = await t.phone('carol');
  });
  afterAll(() => t?.close());

  it('the host watches instead and fills every seat with bots: the start button becomes a bot battle', async () => {
    await tap(alice, '#spectate');
    await alice.waitForSelector('.watcher-me');
    await tap(alice, '#fill-bots');
    await until('4 bots', async () => (await seats(alice)).filter((x) => x.includes('Bot')).length === 4);
    expect(await alice.$eval('#start', (b) => b.textContent)).toContain('Start bot battle');
    expect(await alice.$('#start:disabled')).toBeNull();
  });

  it('someone else can join a full lobby to watch, and is listed with the host under Watching', async () => {
    await watchFromHome(bob);
    await bob.waitForSelector('.screen-lobby .watcher-me');
    await until('two watchers', async () => (await alice.$$('.watcher')).length === 2);
    expect(await bob.$$('.seat .chip')).toHaveLength(0); // nothing to swap or kick from the side
    expect(await bob.$('#start')).toBeNull();
    await shot(alice, 'lobby-watching');
  });

  it('the bots battle at full speed while everyone watches', async () => {
    await tap(alice, '#start');
    await Promise.all([alice.waitForSelector('.screen-game'), bob.waitForSelector('.screen-game')]);
    game = t.server.ctx.games.get(t.server.ctx.lobbies.all()[0].gameId!)!;
    expect(game.botBattle).toBe(true);
    const v0 = game.version;
    await sleep(600); // the screen has slid in
    const places = new Set<string>();
    for (let i = 0; i < 44; i++, await sleep(100)) places.add(await boardBox(alice));
    expect([...places], 'dice, queue and hint come and go; the board never moves').toHaveLength(1);
    // Early on most turns are a roll with nothing to move: about 3.25 s each at the normal pace
    // (1.4 s "thinking" + dice + "no moves"), so fewer than 2 changes in 5 s. A bot battle does 5+.
    expect(game.version - v0).toBeGreaterThanOrEqual(5);
    const hint = await alice.$eval('#hint', (h) => h.textContent!);
    expect(hint).toMatch(/Watching/);
    expect(hint).toMatch(/Bot battle at full speed/);
    expect(await alice.$('.dice.can-roll')).toBeNull();
    await shot(alice, 'bot-battle');
  });

  it('a latecomer can watch the running battle from the home screen', async () => {
    expect(await carol.$eval('.lobby-card .badge-live', (b) => b.textContent)).toContain('Watch');
    await watchFromHome(carol);
    await carol.waitForSelector('.screen-game', { timeout: 10_000 });
    expect(await carol.$eval('#hint', (h) => h.textContent!)).toMatch(/Watching/);
  });

  it('the battle ends on the results screen for everyone watching, and the bots stay for another round', async () => {
    for (const c of ['red', 'green', 'yellow', 'blue'] as const) game.tokens[c] = [55, HOME, HOME, HOME]; // a 1 finishes each
    await Promise.all([alice, bob, carol].map((p) => p.waitForSelector('.results', { timeout: 30_000 })));
    expect(await alice.$eval('.results h2', (h) => h.textContent)).toMatch(/Bot \w+ wins the bot battle/);
    await sleep(2500); // the screen fades over from the board, and the finish toasts clear
    await shot(carol, 'bot-battle-results');
    await tap(alice, '#lobby');
    await alice.waitForSelector('#start');
    expect((await seats(alice)).filter((x) => x.includes('Bot'))).toHaveLength(4);
    expect(t.errors).toEqual([]);
  });
});
