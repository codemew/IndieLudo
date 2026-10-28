import { afterEach, describe, expect, it } from 'vitest';
import { BASE, HOME } from '../src/shared/board.js';
import { RuleError, applyMove, applyRoll, applySurrender, currentColor, legalMoves } from '../src/shared/rules.js';
import { game, scriptedDice, withQueue } from './helpers.js';
import { client, startTestServer, startTwoPlayerGame, type TestClient, type TestServer } from './serverHelpers.js';

const four = () => game(['red', 'green', 'yellow', 'blue']);

describe('surrendering (rules)', () => {
  it('in a two-player game it ends the match at once: the other player wins', () => {
    const s = game(['red', 'yellow']);
    s.tokens.red = [10, HOME, BASE, BASE];
    const events = applySurrender(s, 'red');
    expect(events.map((e) => e.type)).toEqual(['surrender', 'rank', 'rank', 'gameOver']);
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual(['yellow', 'red']);
    expect(events[0]).toEqual({ type: 'surrender', color: 'red', from: [10, HOME, BASE, BASE] });
  });

  it('with more left, their tokens go back to base clean-shaven (home ones stay) and they take no more turns', () => {
    const s = four();
    s.tokens.green = [20, HOME, 3, BASE];
    s.kills = { green: [3, 1, 2, 0] };
    applySurrender(s, 'green'); // not green's turn: red keeps rolling
    expect(s.tokens.green).toEqual([BASE, HOME, BASE, BASE]);
    expect(s.kills.green).toEqual([0, 1, 0, 0]);
    expect(s.finished).toBe(false);
    expect(currentColor(s)).toBe('red');
    applyRoll(s, 4); // red can't move: the turn skips green
    expect(currentColor(s)).toBe('yellow');
  });

  it('on their own turn, mid-turn, the dice are dropped and the turn passes on', () => {
    const s = withQueue(four(), [6, 3]);
    s.turn.bonus = 1;
    applySurrender(s, 'red');
    expect(currentColor(s)).toBe('green');
    expect(s.turn).toMatchObject({ phase: 'rolling', queue: [], bonus: 0, sixes: 0 });
  });

  it('final places: finishers, then the last one playing, then those who gave up (last to give up highest)', () => {
    const s = four();
    applySurrender(s, 'yellow');
    s.tokens.red = [HOME, HOME, HOME, 55];
    applySurrender(s, 'green');
    Object.assign(s.turn, { seat: 0, phase: 'moving', queue: [1] });
    applyMove(s, 0, 3); // red finishes: only blue is left playing
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual(['red', 'blue', 'green', 'yellow']);
  });

  it("can't surrender twice, after finishing, or once the game is over", () => {
    const s = four();
    applySurrender(s, 'blue');
    expect(() => applySurrender(s, 'blue')).toThrow(RuleError);
    s.ranks.push('red'); // red finished
    expect(() => applySurrender(s, 'red')).toThrow('ALREADY_OUT');
    const t = game(['red', 'yellow']);
    applySurrender(t, 'red');
    expect(() => applySurrender(t, 'yellow')).toThrow('GAME_OVER');
  });

  it('nobody can capture or be blocked by a surrendered player: no tokens of theirs are left out', () => {
    const s = withQueue(four(), [3]);
    s.tokens.green = [44, BASE, BASE, BASE]; // absolute 5
    applySurrender(s, 'green');
    s.tokens.red = [2, BASE, BASE, BASE];
    expect(legalMoves(s)[0].captures).toEqual([]);
  });
});

describe('surrendering over the network', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('either player can give up at any time; the winner gets the win; retries and outsiders do nothing', async () => {
    t = await startTestServer({}, { dice: scriptedDice([4]) });
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    const carol = await client(t, 'carol');
    clients.push(alice, bob, carol);
    const gameId = await startTwoPlayerGame(alice, bob);
    expect(await bob.emit('game:surrender', { gameId, actionId: 'x', extra: 1 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await carol.emit('game:surrender', { gameId, actionId: crypto.randomUUID() })).toEqual({ ok: false, error: 'NOT_SEATED' });
    const over = alice.nextState((u) => u.state.finished);
    const actionId = crypto.randomUUID();
    expect(await bob.emit('game:surrender', { gameId, actionId })).toEqual({ ok: true }); // not bob's turn: still fine
    expect(await bob.emit('game:surrender', { gameId, actionId })).toEqual({ ok: true }); // retried: no-op
    const end = await over;
    expect(end.state.ranks).toEqual(['red', 'green']);
    expect(end.state.surrendered).toEqual(['green']);
    expect(end.events?.[0]).toMatchObject({ type: 'surrender', color: 'green' });
    expect(t.server.ctx.users.get(alice.userId)!.wins).toBe(1);
    expect(t.server.ctx.users.get(bob.userId)!.wins).toBe(0);
    expect(await alice.emit('game:surrender', { gameId, actionId: crypto.randomUUID() })).toEqual({ ok: false, error: 'GAME_OVER' });
  });
});
