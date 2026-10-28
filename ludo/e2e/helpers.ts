/** Shared set-up for the browser tests: a real server and headless Chrome "phones". */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { DEFAULTS, mergeConfig, type ConfigOverrides } from '../src/server/config.js';
import { startServer, type LudoServer } from '../src/server/server.js';

export const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
export const BUILT = existsSync('dist/client/index.html');
export const SHOTS = process.env.E2E_SHOTS; // a folder to save screenshots in, if set

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ok()) return;
  throw new Error(`timed out waiting for ${what}`);
};

export interface SetupOptions {
  /** Extra Chrome flags (e.g. a fake microphone file). */
  chromeArgs?: string[];
  config?: ConfigOverrides;
  /** Runs on each new page before the app loads (e.g. to watch its WebRTC connections). */
  onPage?: (p: Page) => Promise<void>;
}

/** A server with scripted dice, and phones that sign in and join one lobby. */
export async function setup(o: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ludo-e2e-'));
  const dice: number[] = [];
  const server: LudoServer = await startServer(
    mergeConfig(DEFAULTS, { lobbyCreatePassword: 'create', adminPassword: 'admin', dbPath: ':memory:', port: 0, turnTimeoutSec: 120, https: { enabled: false }, certDir: dir, voice: { iceServers: [], sfu: { enabled: true, portMin: 43000, portMax: 43199, announcedIp: '' } }, ...o.config }),
    { dice: () => dice.shift() ?? 1, randomInt: () => 0, log: () => {}, gateDelayMs: 0 },
  );
  const url = `http://localhost:${server.port}`;
  const browser: Browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...(o.chromeArgs ?? [])] });
  const errors: string[] = [];

  async function phone(name: string): Promise<Page> {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${name}] ${(e as Error).message}`));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await o.onPage?.(p);
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

export async function tap(p: Page, sel: string): Promise<void> {
  await p.waitForSelector(sel, { timeout: 10_000 });
  await p.$eval(sel, (e) => (e as HTMLElement).click());
}
export const shot = (p: Page, name: string) => (SHOTS ? p.screenshot({ path: join(SHOTS, `${name}.png`) }) : Promise.resolve());
/** Each occupied seat in the lobby as "colour:name". */
export const seats = (p: Page) => p.$$eval('.seat:not(.seat-open)', (ss) => ss.map((s) => `${s.className.match(/s-(\w+)/)![1]}:${s.querySelector('.seat-name')!.childNodes[0].textContent!.trim()}`));
