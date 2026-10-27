import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTls } from '../src/server/tls.js';
import { clientForToken, startTestServer, type TestServer } from './serverHelpers.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ludo-tls-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('certificates', () => {
  it('generates a self-signed cert covering localhost and the LAN IPs, and reuses it', async () => {
    const certDir = join(dir, 'a');
    const first = await loadTls({ autoSelfSigned: true, certDir, ips: ['192.168.1.20'] });
    expect(first.trusted).toBe(false);
    const san = new X509Certificate(first.cert).subjectAltName!;
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP Address:127.0.0.1');
    expect(san).toContain('IP Address:192.168.1.20');

    const again = await loadTls({ autoSelfSigned: true, certDir, ips: ['192.168.1.20'] });
    expect(again.cert).toBe(first.cert);

    const moved = await loadTls({ autoSelfSigned: true, certDir, ips: ['10.0.0.7'] });
    expect(moved.cert).not.toBe(first.cert);
    expect(new X509Certificate(moved.cert).subjectAltName).toContain('IP Address:10.0.0.7');
  });

  it('prefers a configured certificate', async () => {
    const gen = await loadTls({ autoSelfSigned: true, certDir: join(dir, 'b'), ips: [] });
    writeFileSync(join(dir, 'my.crt'), gen.cert);
    writeFileSync(join(dir, 'my.key'), gen.key);
    const tls = await loadTls({ certPath: join(dir, 'my.crt'), keyPath: join(dir, 'my.key'), autoSelfSigned: true, certDir: join(dir, 'unused'), ips: [] });
    expect(tls).toEqual({ cert: gen.cert, key: gen.key, trusted: true });
  });

  it('refuses to run HTTPS without any certificate source', async () => {
    await expect(loadTls({ autoSelfSigned: false, certDir: join(dir, 'c') })).rejects.toThrow(/no certificate/);
  });
});

describe('HTTPS server', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({ https: { enabled: true, port: 0, httpRedirectPort: 0, autoSelfSigned: true }, certDir: join(dir, 'srv') });
  });
  afterAll(async () => t?.close());

  it('serves over https and redirects plain http with a 301', async () => {
    expect(t.server.secure).toBe(true);
    expect(t.base.startsWith('https://')).toBe(true);
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ host: '127.0.0.1', port: t.server.redirectPort!, path: '/lobby?x=1', headers: { Host: 'game.local:3000' } }, resolve),
    );
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(`https://game.local:${t.server.port}/lobby?x=1`);
  });

  it('does not reflect a malicious Host header into the redirect', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ host: '127.0.0.1', port: t.server.redirectPort!, path: '/', headers: { Host: 'evil.com/<script>' } }, resolve),
    );
    expect(res.headers.location).toBe(`https://localhost:${t.server.port}/`);
  });

  it('accepts socket connections over wss', async () => {
    const ctx = t.server.ctx;
    const { device } = ctx.devices.create('test', '127.0.0.1');
    const user = ctx.users.create('tls_user');
    const { token } = ctx.sessions.create({ userId: user.id, deviceId: device.id });
    const c = await clientForToken(t.base, token, user.id);
    expect(c.hello.user.username).toBe('tls_user');
    c.close();
  });

  it('sends security headers but no HSTS for a self-signed cert', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      https.get({ host: '127.0.0.1', port: t.server.port, path: '/api/gate/status', rejectUnauthorized: false }, resolve),
    );
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
