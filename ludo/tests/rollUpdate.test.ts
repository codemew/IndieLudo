/**
 * Slim roll updates: a roll that only grows the queue goes out whole to the roller and as a few
 * hundred bytes to everyone else, who apply it to the state they have.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameUpdate, RollUpdate } from '../src/shared/protocol.js';
import { applyRollUpdate, rollUpdateOf } from '../src/shared/rollUpdate.js';
import { applyMove, applyRoll, createGameState, legalMoves } from '../src/shared/rules.js';
import type { GameEvent, GameState, PublicGameState } from '../src/shared/types.js';
import { scriptedDice, seat } from './helpers.js';
import { client, startTestServer, startTwoPlayerGame, wait, type TestClient, type TestServer } from './serverHelpers.js';

const pub = (s: GameState): PublicGameState => ({ ...structuredClone(s), legalMoves: legalMoves(s), serverNow: 1234 });
const fresh = () => createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('green', 2)], firstSeat: 0, now: 0 });

/** Applies a change as the server does (version bump) and returns the full update. */
function commit(s: GameState, change: (s: GameState) => GameEvent[]): { state: PublicGameState; events: GameEvent[] } {
  const events = change(s);
  s.version++;
  return { state: pub(s), events };
}

describe('the slim update itself', () => {
  it('only for a roll that leaves the turn as it was; anything else goes out whole', () => {
    const s = fresh();
    s.tokens.red = [0, -1, -1, -1];
    const before = pub(s);
    const six = commit(s, (x) => applyRoll(x, 6)); // a six: roll again
    expect(rollUpdateOf(six.state, six.events)).toMatchObject({ id: 'g', version: 2, events: [{ type: 'roll', value: 6 }] });
    expect(rollUpdateOf(six.state)).toBeNull(); // a resync
    const two = commit(s, (x) => applyRoll(x, 2)); // now moving
    expect(rollUpdateOf(two.state, two.events)).not.toBeNull();
    const move = commit(s, (x) => applyMove(x, 0, 0));
    expect(rollUpdateOf(move.state, move.events)).toBeNull();
    // A roll nobody can use ends the turn: noMoves and turn come with it, so it goes out whole.
    const t = fresh();
    const useless = commit(t, (x) => applyRoll(x, 3));
    expect(useless.events.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
    expect(rollUpdateOf(useless.state, useless.events)).toBeNull();
    // Applied in turn to the state before, the slim updates give the server's state, less the legal moves.
    const a = applyRollUpdate(before, rollUpdateOf(six.state, six.events)!)!;
    expect(a).toEqual({ ...six.state, legalMoves: [] });
    const b = applyRollUpdate(a, rollUpdateOf(two.state, two.events)!)!;
    expect(b).toEqual({ ...two.state, legalMoves: [] });
  });

  it('refused when it does not follow on: another game, or a version missed', () => {
    const s = fresh();
    const base = pub(s);
    const six = commit(s, (x) => applyRoll(x, 6));
    const u = rollUpdateOf(six.state, six.events)!;
    expect(applyRollUpdate({ ...base, id: 'other' }, u)).toBeNull();
    expect(applyRollUpdate({ ...base, version: 0 }, u)).toBeNull();
    expect(applyRollUpdate(base, { ...u, events: [] })).toBeNull();
    // A game saved before stats existed still counts the six.
    expect(applyRollUpdate({ ...base, stats: undefined }, u)!.stats!.red!.sixes).toBe(1);
  });

  it('is a small fraction of the full update', () => {
    const s = createGameState({ id: crypto.randomUUID(), lobbyId: 'lobby123', seats: ['red', 'green', 'yellow', 'blue'].map((c, i) => seat(c as 'red', i + 1)), firstSeat: 0, now: 0 });
    s.tokens.red = [0, 12, -1, -1];
    const full = commit(s, (x) => applyRoll(x, 4));
    const slim = rollUpdateOf(full.state, full.events)!;
    const fullBytes = JSON.stringify(full).length;
    const slimBytes = JSON.stringify(slim).length;
    expect(slimBytes).toBeLessThan(400);
    expect(slimBytes / fullBytes).toBeLessThan(0.25);
  });
});

describe('over the socket', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the roller gets the whole state, the other player and a spectator the slim one; moves go to everyone whole', async () => {
    t = await startTestServer({}, { dice: scriptedDice([6, 2]), randomInt: () => 0 });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    const watcher = await client(t, 'zed');
    clients.push(host, guest, watcher);
    const fullTo = new Map<TestClient, GameUpdate[]>();
    for (const c of [host, guest, watcher]) {
      fullTo.set(c, []);
      c.socket.on('game:state', (u: GameUpdate) => fullTo.get(c)!.push(u));
    }
    const gameId = await startTwoPlayerGame(host, guest);
    const lobbyId = t.server.ctx.games.get(gameId)!.lobbyId;
    expect((await watcher.emit('lobby:join', { lobbyId, password: 'pw', watch: true })).ok).toBe(true);
    await wait(50);
    const roller = t.server.ctx.games.get(gameId)!.seats[0].userId === host.userId ? host : guest;
    const other = roller === host ? guest : host;
    for (const c of [host, guest, watcher]) fullTo.get(c)!.length = 0;

    expect(await roller.emit('game:roll', { gameId, version: 1, actionId: crypto.randomUUID() })).toEqual({ ok: true });
    expect(await roller.emit('game:roll', { gameId, version: 2, actionId: crypto.randomUUID() })).toEqual({ ok: true });
    await wait(80);
    expect(fullTo.get(roller)!.map((u) => u.state.version)).toEqual([2, 3]);
    expect(fullTo.get(roller)!.at(-1)!.state.legalMoves.length).toBeGreaterThan(0);
    expect(roller.rolls).toEqual([]);
    for (const c of [other, watcher]) {
      expect(fullTo.get(c)).toEqual([]);
      expect(c.rolls.map((u: RollUpdate) => u.version)).toEqual([2, 3]);
      // What they hold now is the server's state, less the legal moves.
      const server = t.server.ctx.games.publicState(t.server.ctx.games.get(gameId)!);
      expect({ ...c.states.at(-1)!.state, serverNow: 0 }).toEqual({ ...server, legalMoves: [], serverNow: 0 });
    }

    expect(await roller.emit('game:move', { gameId, version: 3, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 0 })).toEqual({ ok: true });
    await wait(80);
    for (const c of [roller, other, watcher]) expect(fullTo.get(c)!.at(-1)!.state.version).toBe(4);
  });

  it('a bot’s roll is slim for everyone; a 6-player lobby plays on the 6-player board', async () => {
    t = await startTestServer({}, { dice: scriptedDice(Array(400).fill([6, 3, 5, 1, 2, 4]).flat()), botDelayMs: 5, autoMoveDelayMs: 5, animScale: 0 });
    const host = await client(t, 'alice');
    clients.push(host);
    const created = await host.emit<{ id: string }>('lobby:create', { createPassword: 'create-pw', name: 'Six', password: 'pw' });
    expect(await host.emit('lobby:size', { size: 6 })).toEqual({ ok: true });
    expect(await host.emit('lobby:size', { size: 9 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await host.emit('lobby:spectate', {})).toEqual({ ok: true });
    expect(await host.emit('lobby:fillBots', {})).toEqual({ ok: true });
    expect(host.lobbyStates.at(-1)).toMatchObject({ id: created.ok && created.data!.id, size: 6 });
    expect(host.lobbyStates.at(-1)!.members).toHaveLength(6);
    expect(await host.emit('lobby:start', {})).toEqual({ ok: true });
    await wait(400);
    const g = t.server.ctx.games.get(host.states[0].state.id)!;
    expect(g.board).toBe(6);
    expect(g.seats.map((s) => s.color)).toEqual(['red', 'green', 'yellow', 'blue', 'orange', 'purple']);
    expect(host.rolls.length).toBeGreaterThan(0);
    // Slim and whole updates together: every version arrived, in order, none missed.
    const versions = [...new Set(host.states.map((u) => u.state.version))];
    expect(versions).toEqual(versions.map((_, i) => versions[0] + i));
    expect(versions.length).toBeGreaterThan(host.rolls.length);
  });
});
