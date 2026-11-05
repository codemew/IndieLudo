import { afterEach, describe, expect, it } from 'vitest';
import type { Hello } from '../src/shared/protocol.js';
import { scriptedDice } from './helpers.js';
import { ADMIN_PW, clientForToken, connectSocket, http, signup, startTestServer, startTwoPlayerGame, type TestClient, type TestServer } from './serverHelpers.js';

let t: TestServer;
const clients: TestClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await t?.close();
});

/** alice (host, red, rolls first) and bob; alice's session is an admin's when `admin` is true. */
async function setup(opts: { admin?: boolean; dice?: number[] } = {}) {
  t = await startTestServer({}, { dice: scriptedDice(opts.dice ?? [2, 2, 2, 2, 2, 2, 2, 2]) });
  const a = await signup(t, 'alice');
  const b = await signup(t, 'bob');
  if (opts.admin) {
    const r = await http(t.base, 'POST', '/api/admin/login', { body: { password: ADMIN_PW }, device: a.device, session: a.token });
    expect(r.status).toBe(200);
  }
  const alice = await clientForToken(t.base, a.token, a.userId);
  const bob = await clientForToken(t.base, b.token, b.userId);
  clients.push(alice, bob);
  const gameId = await startTwoPlayerGame(alice, bob);
  const forced: Record<string, unknown[]> = { alice: [], bob: [] };
  alice.socket.on('game:forced', (u) => forced.alice.push(u));
  bob.socket.on('game:forced', (u) => forced.bob.push(u));
  return { alice, bob, gameId, forced, a, b };
}

const rollOf = (u: { events?: { type: string; value?: number }[] }) => u.events?.find((e) => e.type === 'roll')?.value;
const rollIntent = (gameId: string, version: number) => ({ gameId, version, actionId: crypto.randomUUID() });

describe('an admin can choose their next roll (a test aid)', () => {
  it('only an admin can: anyone else is refused, and their roll stays random', async () => {
    const { alice, gameId, forced } = await setup({ admin: false });
    expect(await alice.emit('game:force', { gameId, value: 6 })).toEqual({ ok: false, error: 'FORBIDDEN' });
    const next = alice.nextState((u) => rollOf(u) !== undefined);
    expect((await alice.emit('game:roll', rollIntent(gameId, alice.states.at(-1)?.state.version ?? 1))).ok).toBe(true);
    expect(rollOf(await next)).toBe(2);
    expect(forced.alice).toEqual([]);
  });

  it('the next roll is exactly the one chosen, once; then it is chance again, and only the admin hears it was used', async () => {
    const { alice, bob, gameId, forced } = await setup({ admin: true });
    expect(await alice.emit('game:force', { gameId, value: 6 })).toEqual({ ok: true, data: { value: 6 } });
    const first = alice.nextState((u) => rollOf(u) !== undefined);
    await alice.emit('game:roll', rollIntent(gameId, alice.hello.game?.version ?? alice.states.at(-1)!.state.version));
    expect(rollOf(await first)).toBe(6);
    // The admin's own phone is told it is used up; bob's phone hears nothing about any of it.
    await new Promise((r) => setTimeout(r, 50));
    expect(forced.alice).toEqual([{ gameId, value: null }]);
    expect(forced.bob).toEqual([]);
    // The six gives another roll, and this one is the dice's again.
    const seen = alice.states.at(-1)!.state.version;
    const second = alice.nextState((u) => rollOf(u) !== undefined && u.state.version > seen);
    await alice.emit('game:roll', rollIntent(gameId, seen));
    expect(rollOf(await second)).toBe(2);
    expect(JSON.stringify(bob.states)).not.toMatch(/force/i);
  });

  it('can be put back to chance before it is used', async () => {
    const { alice, gameId } = await setup({ admin: true });
    await alice.emit('game:force', { gameId, value: 4 });
    expect(await alice.emit('game:force', { gameId, value: 0 })).toEqual({ ok: true, data: { value: null } });
    const next = alice.nextState((u) => rollOf(u) !== undefined);
    await alice.emit('game:roll', rollIntent(gameId, alice.states.at(-1)?.state.version ?? 1));
    expect(rollOf(await next)).toBe(2);
  });

  it('is only for your own seat in a game you are playing, with a value from 1 to 6', async () => {
    const { alice, gameId } = await setup({ admin: true });
    expect((await alice.emit('game:force', { gameId: 'nope', value: 3 })).ok).toBe(false);
    expect(await alice.emit('game:force', { gameId, value: 7 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await alice.emit('game:force', { gameId, value: 1.5 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });

  it('a phone that reconnects is told a roll is still set, but only an admin\'s', async () => {
    const { alice, gameId, a } = await setup({ admin: true });
    await alice.emit('game:force', { gameId, value: 5 });
    const s = connectSocket(t.base, a.token);
    const got: unknown[] = [];
    s.on('game:forced', (u) => got.push(u));
    await new Promise<Hello>((res) => s.once('hello', res));
    await new Promise((r) => setTimeout(r, 50));
    s.disconnect();
    expect(got).toEqual([{ gameId, value: 5 }]);
  });

  it('an admin who has logged out of admin mode does not keep a forced roll', async () => {
    const { alice, gameId, a } = await setup({ admin: true });
    await alice.emit('game:force', { gameId, value: 6 });
    await http(t.base, 'POST', '/api/admin/logout', { device: a.device, session: a.token });
    const next = alice.nextState((u) => rollOf(u) !== undefined);
    await alice.emit('game:roll', rollIntent(gameId, alice.states.at(-1)?.state.version ?? 1));
    expect(rollOf(await next)).toBe(2);
  });
});
