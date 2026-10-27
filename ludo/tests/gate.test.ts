import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gate } from '../src/server/gate.js';
import { hashToken } from '../src/server/sessions.js';
import { ADMIN_PW, client, connectSocket, http, signup, startTestServer, verifiedDevice, type TestServer } from './serverHelpers.js';

afterEach(() => vi.restoreAllMocks());

describe('Gate (unit)', () => {
  const make = (now = { t: 0 }, over: Partial<ConstructorParameters<typeof Gate>[0]> = {}) =>
    new Gate({ maxFailsPerIp: 5, globalFailRotateThreshold: 50, now: () => now.t, ...over });

  it('makes a 6-digit code with crypto.randomInt', () => {
    const spy = vi.spyOn(crypto, 'randomInt');
    for (let i = 0; i < 200; i++) expect(make().current).toMatch(/^\d{6}$/);
    expect(spy).toHaveBeenCalledWith(0, 1_000_000);
    expect(new Gate({ maxFailsPerIp: 5, globalFailRotateThreshold: 50, randomInt: () => 42 }).current).toBe('000042');
  });

  it('accepts the right code (spaces allowed) and rejects others', () => {
    const g = make();
    expect(g.verify(g.current, 'ip')).toEqual({ ok: true });
    expect(g.verify(`${g.current.slice(0, 3)} ${g.current.slice(3)}`, 'ip')).toEqual({ ok: true });
    const wrong = g.current === '000000' ? '000001' : '000000';
    expect(g.verify(wrong, 'ip')).toEqual({ ok: false });
    expect(g.verify(12345, 'ip')).toEqual({ ok: false });
    expect(g.verify('abcdef', 'ip')).toEqual({ ok: false });
  });

  it('locks an IP after 5 wrong tries, with growing lockouts', () => {
    const now = { t: 0 };
    const g = make(now, { randomInt: () => 123456 });
    for (let i = 0; i < 5; i++) expect(g.verify('000000', 'a')).toEqual({ ok: false });
    // Locked even for the right code; other IPs are unaffected.
    expect(g.verify('123456', 'a')).toEqual({ ok: false, retryAfterSec: 60 });
    expect(g.verify('123456', 'b')).toEqual({ ok: true });
    now.t += 60_000;
    for (let i = 0; i < 5; i++) g.verify('000000', 'a');
    expect(g.verify('123456', 'a')).toEqual({ ok: false, retryAfterSec: 300 });
    now.t += 300_000;
    for (let i = 0; i < 5; i++) g.verify('000000', 'a');
    expect(g.verify('123456', 'a')).toEqual({ ok: false, retryAfterSec: 900 });
  });

  it('rotates the code when failures pile up across many IPs', () => {
    const onRotate = vi.fn();
    let n = 0;
    const g = make({ t: 0 }, { onRotate, randomInt: () => (n++ === 0 ? 111111 : 222222) });
    for (let i = 0; i < 50; i++) g.verify('000000', `ip${i}`);
    expect(onRotate).not.toHaveBeenCalled();
    g.verify('000000', 'ip-last');
    expect(onRotate).toHaveBeenCalledWith('222222', 'brute-force');
    expect(g.verify('111111', 'fresh')).toEqual({ ok: false });
    expect(g.verify('222222', 'fresh2')).toEqual({ ok: true });
  });
});

describe('access gate over HTTP', () => {
  let t: TestServer;
  afterEach(async () => t?.close());

  it('wrong code → 401, right code → device token stored only as a hash', async () => {
    t = await startTestServer();
    const wrong = t.server.ctx.gate.current === '000000' ? '000001' : '000000';
    const bad = await http(t.base, 'POST', '/api/gate/verify', { body: { code: wrong } });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe('INVALID_CODE');

    const ok = await http(t.base, 'POST', '/api/gate/verify', { body: { code: t.server.ctx.gate.current } });
    expect(ok.status).toBe(200);
    const token = ok.json.deviceToken as string;
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(ok.headers.get('set-cookie')).toMatch(/ludo_device=.*HttpOnly.*SameSite=Strict/i);
    const row = t.server.ctx.db.prepare('SELECT token_hash FROM devices').get() as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
  });

  it('signup and admin login need a verified device', async () => {
    t = await startTestServer();
    expect((await http(t.base, 'POST', '/api/users', { body: { username: 'alice' } })).status).toBe(401);
    expect((await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW } })).status).toBe(401);
    const device = await verifiedDevice(t);
    expect((await http(t.base, 'POST', '/api/users', { body: { username: 'alice' }, device })).status).toBe(201);
    expect((await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device })).status).toBe(200);
    expect((await http(t.base, 'POST', '/api/admin/login', { body: { password: 'nope' }, device })).status).toBe(403);
  });

  it('6th try from one IP gets 429 with Retry-After', async () => {
    t = await startTestServer();
    const wrong = t.server.ctx.gate.current === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) expect((await http(t.base, 'POST', '/api/gate/verify', { body: { code: wrong } })).status).toBe(401);
    const locked = await http(t.base, 'POST', '/api/gate/verify', { body: { code: t.server.ctx.gate.current } });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('60');
    expect(locked.json.error).toBe('INVALID_CODE');
  });

  it('a verified device stays verified through code rotation, user deletion and session revocation', async () => {
    t = await startTestServer();
    const { token, userId, device } = await signup(t, 'alice');
    t.server.ctx.gate.rotate();
    t.server.ctx.gate.rotate('brute-force');
    expect((await http(t.base, 'GET', '/api/gate/status', { device })).json.verified).toBe(true);

    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device })).json.token;
    const sessions = (await http(t.base, 'GET', '/api/admin/sessions', { session: admin })).json as { id: number; user_id: number }[];
    const mine = sessions.find((s) => s.user_id === userId)!;
    expect((await http(t.base, 'DELETE', `/api/admin/sessions/${mine.id}`, { session: admin })).status).toBe(200);
    expect((await http(t.base, 'GET', '/api/me', { session: token })).status).toBe(401);
    expect((await http(t.base, 'GET', '/api/gate/status', { device })).json.verified).toBe(true);

    expect((await http(t.base, 'DELETE', `/api/admin/users/${userId}`, { session: admin })).status).toBe(200);
    expect((await http(t.base, 'GET', '/api/gate/status', { device })).json.verified).toBe(true);
    // Signs up again without a code.
    expect((await http(t.base, 'POST', '/api/users', { body: { username: 'alice2' }, device })).status).toBe(201);
  });

  it('survives a server restart with a new code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ludo-gate-'));
    try {
      t = await startTestServer({ dbPath: join(dir, 'db.sqlite') });
      const { token, device } = await signup(t, 'alice');
      await t.close();
      // A fresh process makes a fresh random code.
      t = await startTestServer({ dbPath: join(dir, 'db.sqlite') }, { randomInt: undefined });
      expect((await http(t.base, 'GET', '/api/gate/status', { device })).json.verified).toBe(true);
      expect((await http(t.base, 'GET', '/api/me', { session: token })).json.user.username).toBe('alice');
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores the device token from the cookie, and the cookie from the header', async () => {
    t = await startTestServer();
    const device = await verifiedDevice(t);
    const viaCookie = await http(t.base, 'GET', '/api/gate/status', { headers: { Cookie: `ludo_device=${device}` } });
    expect(viaCookie.json).toEqual({ verified: true, deviceToken: device });
    const viaHeader = await http(t.base, 'GET', '/api/gate/status', { device });
    expect(viaHeader.json).toEqual({ verified: true });
    expect(viaHeader.headers.get('set-cookie')).toContain(`ludo_device=${device}`);
    const both = await http(t.base, 'GET', '/api/gate/status', { device, headers: { Cookie: `ludo_device=${device}` } });
    expect(both.headers.get('set-cookie')).toBeNull();
  });

  it('Revoke device sends that device back to the code screen', async () => {
    t = await startTestServer();
    const { token, device } = await signup(t, 'alice');
    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token;
    const devices = (await http(t.base, 'GET', '/api/admin/devices', { session: admin })).json as { id: number }[];
    const target = t.server.ctx.devices.resolve(device)!;
    expect(devices.some((d) => d.id === target.id)).toBe(true);
    expect((await http(t.base, 'DELETE', `/api/admin/devices/${target.id}`, { session: admin })).status).toBe(200);
    expect((await http(t.base, 'GET', '/api/gate/status', { device })).json.verified).toBe(false);
    expect((await http(t.base, 'GET', '/api/me', { session: token })).status).toBe(401);
  });

  it('every other /api route needs a session; admin routes need an admin', async () => {
    t = await startTestServer();
    for (const [m, p] of [
      ['GET', '/api/me'],
      ['POST', '/api/logout'],
      ['GET', '/api/admin/users'],
      ['DELETE', '/api/admin/users/1'],
      ['GET', '/api/admin/code'],
      ['POST', '/api/admin/code/rotate'],
      ['GET', '/api/whatever'],
    ]) {
      expect((await http(t.base, m, p)).status, `${m} ${p}`).toBe(401);
    }
    const { token } = await signup(t, 'alice');
    expect((await http(t.base, 'GET', '/api/admin/users', { session: token })).status).toBe(403);
    expect((await http(t.base, 'GET', '/api/admin/code', { session: token })).status).toBe(403);
  });

  it('admin can read and rotate the code', async () => {
    t = await startTestServer({}, { randomInt: undefined });
    const admin = (await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: await verifiedDevice(t) })).json.token;
    const before = (await http(t.base, 'GET', '/api/admin/code', { session: admin })).json.code;
    expect(before).toBe(t.server.ctx.gate.current);
    const after = (await http(t.base, 'POST', '/api/admin/code/rotate', { session: admin })).json.code;
    expect(after).toBe(t.server.ctx.gate.current);
  });

  it('a socket handshake without a session is refused', async () => {
    t = await startTestServer();
    for (const token of [undefined, 'garbage']) {
      const s = connectSocket(t.base, token as string);
      const err = await new Promise<Error>((res) => s.once('connect_error', res));
      expect(err.message).toBe('UNAUTHORIZED');
      s.close();
    }
    // A working session connects.
    const c = await client(t, 'alice');
    expect(c.hello.user.username).toBe('alice');
    c.close();
  });

  it('rejects oversized JSON bodies', async () => {
    t = await startTestServer();
    const r = await http(t.base, 'POST', '/api/gate/verify', { body: { code: 'x'.repeat(10_000) } });
    expect(r.status).toBe(413);
  });
});
