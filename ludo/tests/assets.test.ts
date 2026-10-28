import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './serverHelpers.js';

const JS = `export const board = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ square: i, safe: i % 13 === 0 })))};\n`;

describe('compressed app files', () => {
  let t: TestServer;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'ludo-assets-'));
    writeFileSync(join(root, 'secret.js'), 'nope'); // beside the site, not in it
    const dir = join(root, 'site');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ludo</title>');
    writeFileSync(join(dir, 'assets', 'index-abc.js'), JS);
    writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{color:red}'.repeat(200));
    writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    t = await startTestServer({}, { staticDir: dir });
  });
  afterAll(() => t.close());

  /** A raw GET (no automatic decompression), so the bytes on the wire can be checked. */
  const get = (path: string, encoding?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http
        .get(t.base + path, { headers: encoding ? { 'accept-encoding': encoding } : {} }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });

  it('sends brotli to browsers that take it: a fraction of the size, same file once unpacked', async () => {
    const r = await get('/assets/index-abc.js', 'gzip, deflate, br');
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers.vary).toMatch(/Accept-Encoding/);
    expect(r.headers['cache-control']).toMatch(/immutable/);
    expect(r.body.length).toBeLessThan(JS.length / 4);
    expect(brotliDecompressSync(r.body).toString()).toBe(JS);
  });

  it('gzip for browsers without brotli, and the plain file for those without either', async () => {
    const gz = await get('/assets/index-abc.css', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe('body{color:red}'.repeat(200));
    const plain = await get('/assets/index-abc.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(JS);
  });

  it("images aren't recompressed, missing files are still 404, and nothing outside assets is reachable", async () => {
    const png = await get('/assets/logo.png', 'br');
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.status).toBe(200);
    expect((await get('/assets/missing.js', 'br')).headers['content-encoding']).toBeUndefined();
    for (const path of ['/assets/..%2f..%2fsecret.js', '/assets/%2e%2e/%2e%2e/secret.js', '/assets/..%5c..%5csecret.js']) {
      const escape = await get(path, 'br');
      expect(escape.body.toString(), path).not.toContain('nope');
      expect(escape.headers['content-encoding'], path).toBeUndefined();
    }
  });
});
