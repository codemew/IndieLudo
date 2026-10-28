import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http, signup, startTestServer, type TestServer } from './serverHelpers.js';

describe('API errors', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(() => t.close());

  const raw = (path: string, body: string) => fetch(t.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  it('a body over 4 KB is refused with 413, before any route sees it', async () => {
    const res = await raw('/api/gate/verify', JSON.stringify({ code: '1'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
  });

  it('broken JSON is a 400, not a crash', async () => {
    const res = await raw('/api/gate/verify', '{"code": ');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'BAD_JSON' });
  });

  it('an unknown route is a 401 without a session and a 404 with one', async () => {
    expect((await http(t.base, 'GET', '/api/nope')).status).toBe(401);
    const { token } = await signup(t, 'alice');
    const r = await http(t.base, 'GET', '/api/nope', { session: token });
    expect(r).toMatchObject({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  it('the server keeps answering after the bad requests', async () => {
    const r = await http(t.base, 'POST', '/api/gate/verify', { body: { code: t.server.ctx.gate.current } });
    expect(r.status).toBe(200);
  });
});
