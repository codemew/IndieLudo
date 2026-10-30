import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE, HOME, LAP2_FIRST } from '../src/shared/board.js';
import { RuleError, applyMove, applyRespawn, applyRoll, applySurrender, currentColor, distinctChoices, extraLapsOf, hasExtraLap, legalMoves, respawnable, statsOf } from '../src/shared/rules.js';
import { threatenedTokens } from '../src/shared/threats.js';
import { GameManager } from '../src/server/gameManager.js';
import { openDb } from '../src/server/db.js';
import type { Lobby } from '../src/server/lobbies.js';
import { WILDCARD_MS, type GameEvent, type PublicGameState } from '../src/shared/types.js';
import { game, scriptedDice, withQueue } from './helpers.js';
import { client, startTestServer, startTwoPlayerGame, type TestClient, type TestServer } from './serverHelpers.js';

const four = () => game(['red', 'green', 'yellow', 'blue']);
const H = HOME;

describe('wildcard entry (rules)', () => {
  it('sends a home token back to base, keeping its moustache; it needs a 6 to come out again', () => {
    const s = game();
    s.tokens.red = [H, H, 20, BASE];
    s.kills = { red: [3, 0, 0, 0] };
    const events = applyRespawn(s, 'red', [0]);
    expect(events).toEqual([{ type: 'respawn', color: 'red', tokenIds: [0] }]);
    expect(s.tokens.red).toEqual([BASE, H, 20, BASE]);
    expect(s.kills!.red![0]).toBe(3);
    expect(extraLapsOf(s, 'red')).toEqual([1, 0, 0, 0]);
    expect(statsOf(s, 'red').risks).toBe(1);
    applyRoll(s, 4);
    expect(legalMoves(s).filter((m) => m.tokenId === 0)).toEqual([]);
    const t = withQueue(game(), [6]);
    t.tokens.red = [H, BASE, BASE, BASE];
    applyRespawn(t, 'red', [0]);
    expect(legalMoves(t).find((m) => m.tokenId === 0)).toMatchObject({ from: BASE, to: 0 });
  });

  it('is a free action: any time, also on an opponent turn, and it ends nobody’s turn', () => {
    const s = withQueue(game(), [3]);
    s.tokens.yellow = [H, 10, BASE, BASE];
    const before = structuredClone(s.turn);
    applyRespawn(s, 'yellow', [0]); // red is moving
    expect(s.turn).toEqual(before);
    expect(currentColor(s)).toBe('red');
  });

  it('mid-turn with a queued 6: the token sent back can use it at once', () => {
    const s = withQueue(game(), [6, 2]);
    s.tokens.red = [H, 51, 52, H]; // in the home column: a 6 overshoots
    expect(legalMoves(s).filter((m) => m.die === 6)).toEqual([]);
    applyRespawn(s, 'red', [0]);
    expect(legalMoves(s).filter((m) => m.die === 6).map((m) => m.tokenId)).toEqual([0]);
  });

  it('several at once; ids come back sorted', () => {
    const s = game();
    s.tokens.red = [H, H, H, 10];
    expect(applyRespawn(s, 'red', [2, 0])[0]).toMatchObject({ tokenIds: [0, 2] });
    expect(s.tokens.red).toEqual([BASE, H, BASE, 10]);
    expect(statsOf(s, 'red').risks).toBe(2);
  });

  it('refuses tokens not home, unknown ids, duplicates, an empty list, outsiders, surrendered players and a finished game', () => {
    const s = four();
    s.tokens.red = [H, 30, BASE, H];
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as RuleError).code;
      }
      return 'no error';
    };
    expect(err(() => applyRespawn(s, 'red', [1]))).toBe('NOT_HOME');
    expect(err(() => applyRespawn(s, 'red', [2]))).toBe('NOT_HOME');
    expect(err(() => applyRespawn(s, 'red', [4]))).toBe('BAD_TOKENS');
    expect(err(() => applyRespawn(s, 'red', [-1]))).toBe('BAD_TOKENS');
    expect(err(() => applyRespawn(s, 'red', [0.5]))).toBe('BAD_TOKENS');
    expect(err(() => applyRespawn(s, 'red', [0, 0]))).toBe('BAD_TOKENS');
    expect(err(() => applyRespawn(s, 'red', []))).toBe('BAD_TOKENS');
    const two = game(['red', 'yellow']);
    expect(err(() => applyRespawn(two, 'green', [0]))).toBe('NOT_SEATED');
    s.tokens.green = [H, BASE, BASE, BASE];
    applySurrender(s, 'green');
    expect(err(() => applyRespawn(s, 'green', [0]))).toBe('SURRENDERED');
    const over = game(['red', 'yellow']);
    over.tokens.yellow = [H, BASE, BASE, BASE];
    applySurrender(over, 'red');
    expect(err(() => applyRespawn(over, 'yellow', [0]))).toBe('GAME_OVER');
    // A refused request changes nothing.
    expect(s.tokens.red).toEqual([H, 30, BASE, H]);
  });

  it('once per token: after a wildcard entry it can neither go round again nor be sent back again', () => {
    const s = withQueue(game(), [4]);
    s.tokens.red = [H, BASE, BASE, BASE];
    applyRespawn(s, 'red', [0]);
    s.tokens.red[0] = 48; // back at its home turn
    expect(legalMoves(s).filter((m) => m.tokenId === 0)).toEqual([expect.objectContaining({ to: 52 })]);
    expect(legalMoves(s).some((m) => m.lap)).toBe(false);
    s.tokens.red[0] = H;
    expect(respawnable(s, 'red')).toEqual([]);
    expect(() => applyRespawn(s, 'red', [0])).toThrow('NO_LAPS_LEFT');
  });

  it('a token that went round again has done its two laps: no wildcard entry for it', () => {
    const s = withQueue(game(), [4]);
    s.tokens.red = [48, BASE, BASE, BASE];
    applyMove(s, 0, 0, true);
    expect(s.tokens.red[0]).toBe(LAP2_FIRST + 1);
    expect(hasExtraLap(s, 'red', 0)).toBe(false);
    expect(statsOf(s, 'red').risks).toBe(1);
    s.tokens.red[0] = H;
    expect(() => applyRespawn(s, 'red', [0])).toThrow('NO_LAPS_LEFT');
  });

  it('captured on its second lap, a token starts over fresh: its extra lap is given back', () => {
    const s = withQueue(game(), [2]);
    s.tokens.yellow = [LAP2_FIRST + 10, BASE, BASE, BASE];
    s.extraLaps = { yellow: [1, 0, 0, 0] };
    // yellow's 67 is absolute (26 + 67 - 6) % 52 = 35; red reaches 35 from 33.
    s.tokens.red = [33, BASE, BASE, BASE];
    applyMove(s, 0, 0);
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(hasExtraLap(s, 'yellow', 0)).toBe(true);
  });

  it('captured after a wildcard entry, a token keeps its entry used (one per token, ever)', () => {
    const s = withQueue(game(), [2]);
    s.tokens.yellow = [5, BASE, BASE, BASE]; // absolute 31
    s.extraLaps = { yellow: [1, 0, 0, 0] };
    s.tokens.red = [29, BASE, BASE, BASE];
    applyMove(s, 0, 0);
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(hasExtraLap(s, 'yellow', 0)).toBe(false);
  });

  it('at most four per player', () => {
    const s = game();
    s.tokens.red = [H, H, H, H];
    s.ranks = []; // not yet ranked in this hand-built state
    applyRespawn(s, 'red', [0, 1, 2, 3]);
    expect(statsOf(s, 'red').risks).toBe(4);
    s.tokens.red = [H, H, H, H];
    expect(respawnable(s, 'red')).toEqual([]);
  });

  it('home again: another bonus roll, another macho arrival, and the home count reaches 5', () => {
    const s = withQueue(game(), [1]);
    s.tokens.red = [55, H, H, H];
    s.kills = { red: [2, 0, 0, 0] };
    s.stats = { red: { cells: 0, captures: 0, sixes: 0, revenges: 0, machoHome: 1, homeRuns: 4, firstBlood: false, owed: {} } };
    s.extraLaps = { red: [1, 0, 0, 0] };
    const events = applyMove(s, 0, 0);
    expect(events.map((e) => e.type)).toContain('rank');
    expect(statsOf(s, 'red').homeRuns).toBe(5);
    expect(statsOf(s, 'red').machoHome).toBe(2);
    const t = withQueue(game(), [1]);
    t.tokens.red = [55, H, BASE, BASE];
    applyMove(t, 0, 0);
    expect(t.turn.bonus).toBe(0); // the bonus was taken: the turn goes on with a roll
    expect(currentColor(t)).toBe('red');
  });

  it('a finished player may go again: they give up their place and the others move up', () => {
    const s = four();
    s.tokens.red = [H, H, H, H];
    s.tokens.green = [H, H, H, H];
    s.ranks = ['red', 'green'];
    const events = applyRespawn(s, 'red', [1]);
    expect(events[0]).toEqual({ type: 'respawn', color: 'red', tokenIds: [1], unranked: 1 });
    expect(s.ranks).toEqual(['green']);
    // Red takes turns again.
    Object.assign(s.turn, { seat: 3, phase: 'rolling', queue: [] }); // blue
    applyRoll(s, 2); // blue has nothing out: turn passes, skipping finished green
    expect(currentColor(s)).toBe('red');
    // Red must bring all four home again to finish.
    s.tokens.red[1] = 55;
    applyRoll(s, 1);
    applyMove(s, 0, 1);
    expect(s.ranks).toEqual(['green', 'red']);
  });

  it('respawnable(): home tokens with their extra lap, none for a surrendered player or after the game', () => {
    const s = four();
    s.tokens.blue = [H, H, 3, BASE];
    s.extraLaps = { blue: [0, 1, 0, 0] };
    expect(respawnable(s, 'blue')).toEqual([0]);
    expect(s.extraLaps.red).toBeUndefined(); // reading doesn't create state
    applySurrender(s, 'blue');
    expect(respawnable(s, 'blue')).toEqual([]);
    const two = game(['red', 'yellow']);
    expect(respawnable(two, 'green')).toEqual([]);
    two.finished = true;
    two.tokens.red = [H, BASE, BASE, BASE];
    expect(respawnable(two, 'red')).toEqual([]);
  });

  it('distinct choices tell apart tokens on one square when one has used its extra lap', () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [10, 10, BASE, BASE];
    expect(distinctChoices(legalMoves(s), s)).toHaveLength(1);
    s.extraLaps = { red: [0, 1, 0, 0] };
    expect(distinctChoices(legalMoves(s), s).map((m) => m.tokenId)).toEqual([0, 1]);
  });

  it('threats: a token with no extra lap left turns home, so it no longer hunts past its home turn', () => {
    const s = game(['red', 'green']);
    s.tokens.red = [48, BASE, BASE, BASE]; // absolute 48
    s.tokens.green = [38, BASE, BASE, BASE]; // absolute 51: three squares past red's 48, beyond red's home turn at 50
    expect(threatenedTokens(s).has('green:0')).toBe(true); // red could go round again and catch it
    s.extraLaps = { red: [1, 0, 0, 0] };
    expect(threatenedTokens(s).has('green:0')).toBe(false);
  });
});

describe('wildcard entry (game manager)', () => {
  const lobby = (): Lobby =>
    ({
      id: 'l1',
      members: [
        { color: 'red', userId: 1, username: 'alice', isBot: false, ready: true, connected: true },
        { color: 'yellow', userId: 2, username: 'bob', isBot: false, ready: true, connected: true },
      ],
    }) as unknown as Lobby;

  afterEach(() => vi.useRealTimers());

  it('checks the payload and the seat, and pauses (not restarts) the current player’s timer', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const updates: { state: PublicGameState; events?: GameEvent[] }[] = [];
    const logs: string[] = [];
    const gm = new GameManager({
      db: openDb(':memory:'),
      dice: scriptedDice([]),
      turnTimeoutSec: 30,
      disconnectGraceSec: 60,
      animScale: 1,
      randomInt: () => 0,
      onUpdate: (state, events) => updates.push({ state, events }),
      log: (m) => logs.push(m),
    });
    const s = gm.create(lobby());
    s.tokens.yellow = [H, BASE, BASE, BASE];
    expect(s.turn.deadline).toBe(1_000_000 + 30_000);
    vi.advanceTimersByTime(20_000); // red has 10 s left
    const actionId = 'abcdefgh-1';
    expect(gm.respawn(2, { gameId: s.id, actionId, tokens: 0 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(gm.respawn(2, { gameId: s.id, actionId, tokens: 16 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(gm.respawn(3, { gameId: s.id, actionId, tokens: 1 })).toEqual({ ok: false, error: 'NOT_SEATED' });
    expect(gm.respawn(2, { gameId: 'nope', actionId, tokens: 1 })).toEqual({ ok: false, error: 'NO_GAME' });
    expect(gm.respawn(2, { gameId: s.id, actionId, tokens: 2 })).toEqual({ ok: false, error: 'NOT_HOME' });
    expect(gm.respawn(2, { gameId: s.id, actionId, tokens: 1 })).toEqual({ ok: true });
    expect(gm.respawn(2, { gameId: s.id, actionId, tokens: 1 })).toEqual({ ok: true }); // retry: no-op
    expect(updates.filter((u) => u.events?.[0]?.type === 'respawn')).toHaveLength(1);
    expect(logs.some((l) => l.includes('bob made a wildcard entry (0)'))).toBe(true);
    // Red keeps its 10 s, plus the time the phones spend showing the wildcard entry.
    expect(s.turn.deadline).toBe(Date.now() + 10_000 + WILDCARD_MS);
    gm.shutdown();
  });
});

describe('wildcard entry over the network', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('everyone sees the respawn event; the token is back in base', async () => {
    t = await startTestServer({}, { dice: scriptedDice([]) });
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    const gameId = await startTwoPlayerGame(alice, bob);
    const g = t.server.ctx.games.get(gameId)!;
    const color = g.seats.find((s) => s.userId === bob.userId)!.color;
    g.tokens[color] = [H, H, 30, BASE];
    const seen = alice.nextState((u) => u.events?.[0]?.type === 'respawn');
    expect(await bob.emit('game:respawn', { gameId, actionId: crypto.randomUUID(), tokens: 0b11 })).toEqual({ ok: true });
    const u = await seen;
    expect(u.events).toEqual([{ type: 'respawn', color, tokenIds: [0, 1] }]);
    expect(u.state.tokens[color]).toEqual([BASE, BASE, 30, BASE]);
    expect(await bob.emit('game:respawn', { gameId, actionId: crypto.randomUUID(), tokens: 0b11 })).toEqual({ ok: false, error: 'NOT_HOME' });
  });
});
