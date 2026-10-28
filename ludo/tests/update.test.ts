import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { client, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('"Update app"', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('/refresh tells the browser to drop its cached files (only the cache), then forwards to the game', async () => {
    t = await startTestServer();
    const r = await fetch(t.base + '/refresh', { redirect: 'manual' });
    expect(r.status).toBe(200);
    expect(r.headers.get('clear-site-data')).toBe('"cache"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const page = await r.text();
    expect(page).toMatch(/location\.replace\('\/\?fresh='/);
    expect(page).toMatch(/http-equiv="refresh" content="0;url=\/\?fresh=\d+"/);
  });

  it('the welcome message carries the server version, so phones on an older build can offer to update', async () => {
    t = await startTestServer();
    const c = await client(t, 'alice');
    clients.push(c);
    expect(c.hello.appVersion).toBe(version);
  });

  it('the page is always checked with the server; hashed build files are kept for a year', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludo-static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ludo</title>');
    writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    t = await startTestServer({}, { staticDir: dir });
    const get = (path: string) => fetch(t.base + path);
    for (const path of ['/', '/index.html', '/some/deep/link', '/manifest.webmanifest']) {
      expect((await get(path)).headers.get('cache-control'), path).toBe('no-cache');
    }
    expect((await get('/assets/index-abc123.js')).headers.get('cache-control')).toMatch(/max-age=31536000.*immutable|immutable.*max-age=31536000/);
  });
});
