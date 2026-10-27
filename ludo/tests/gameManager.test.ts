import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BASE, HOME } from '../src/shared/board.js';
import { MAX_MISSED_TURNS, type GameEvent, type GameState, type PublicGameState } from '../src/shared/types.js';
import { openDb, type DB } from '../src/server/db.js';
import { GameManager } from '../src/server/gameManager.js';
import type { Lobby } from '../src/server/lobbies.js';
import { scriptedDice } from './helpers.js';

const A = 1;
const B = 2;

function lobby(members: Partial<Lobby['members'][number]>[]): Lobby {
  return {
    id: 'lobby1',
    name: 'L',
    hostId: A,
    passwordHash: 'x:y',
    status: 'waiting',
    gameId: null,
    createdAt: 0,
    allOfflineSince: null,
    members: members.map((m, i) => ({
      color: (['red', 'green', 'yellow', 'blue'] as const)[i],
      userId: null,
      username: `p${i}`,
      isBot: false,
      ready: true,
      connected: true,
      ...m,
    })),
  };
}

const twoHumans = () => lobby([{ userId: A, username: 'alice' }, { userId: B, username: 'bob' }]);

let db: DB;
let updates: { state: PublicGameState; events?: GameEvent[] }[];
let gameOver: Mock<(state: GameState) => void>;

function manager(dice: number[], over: Partial<ConstructorParameters<typeof GameManager>[0]> = {}): GameManager {
  return new GameManager({
    db,
    dice: scriptedDice(dice),
    turnTimeoutSec: 30,
    disconnectGraceSec: 60,
    botDelayMs: 500,
    autoMoveDelayMs: 600,
    animScale: 0,
    randomInt: () => 0,
    onUpdate: (state, events) => updates.push({ state, events }),
    onGameOver: gameOver,
    ...over,
  });
}

const intent = (gameId: string, version: number, extra: object = {}) => ({ gameId, version, actionId: crypto.randomUUID(), ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  db = openDb(':memory:');
  updates = [];
  gameOver = vi.fn<(state: GameState) => void>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('intents', () => {
  it('rolls with the server dice only after validation', () => {
    const gm = manager([4]);
    const g = gm.create(twoHumans());
    expect(gm.roll(B, intent(g.id, 1))).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
    expect(gm.roll(A, intent(g.id, 1))).toEqual({ ok: true });
    expect(updates.at(-1)!.events!.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
    expect(gm.get(g.id)!.version).toBe(2);
  });

  it('ignores a duplicate actionId', () => {
    const gm = manager([6, 3]);
    const g = gm.create(twoHumans());
    const p = intent(g.id, 1);
    expect(gm.roll(A, p)).toEqual({ ok: true });
    expect(gm.roll(A, p)).toEqual({ ok: true });
    const s = gm.get(g.id)!;
    expect(s.version).toBe(2);
    expect(s.turn.queue).toEqual([6]);
  });

  it('rejects a stale version', () => {
    const gm = manager([6, 3]);
    const g = gm.create(twoHumans());
    gm.roll(A, intent(g.id, 1));
    expect(gm.roll(A, intent(g.id, 1))).toEqual({ ok: false, error: 'STALE_VERSION' });
  });

  it('two back-to-back roll intents with the same version add exactly one die', () => {
    const gm = manager([6, 6, 6]);
    const g = gm.create(twoHumans());
    const r1 = gm.roll(A, intent(g.id, 1));
    const r2 = gm.roll(A, intent(g.id, 1));
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, error: 'STALE_VERSION' });
    expect(gm.get(g.id)!.turn.queue).toEqual([6]);
  });

  it('rejects wrong phase and illegal moves', () => {
    const gm = manager([6, 2]);
    const g = gm.create(twoHumans());
    expect(gm.move(A, intent(g.id, 1, { dieIndex: 0, tokenId: 0 }))).toEqual({ ok: false, error: 'WRONG_PHASE' });
    gm.roll(A, intent(g.id, 1));
    gm.roll(A, intent(g.id, 2));
    // [6, 2] with everything in base: the 2 cannot be played first.
    expect(gm.move(A, intent(g.id, 3, { dieIndex: 1, tokenId: 0 }))).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
    expect(gm.move(A, intent(g.id, 3, { dieIndex: 0, tokenId: 0 }))).toEqual({ ok: true });
    expect(gm.get(g.id)!.tokens.red[0]).toBe(0);
  });

  it('rejects malformed payloads', () => {
    const gm = manager([3]);
    const g = gm.create(twoHumans());
    expect(gm.roll(A, { ...intent(g.id, 1), value: 6 })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(gm.roll(A, null)).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(gm.move(A, intent(g.id, 1, { dieIndex: 0, tokenId: 7 }))).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
  });
});

describe('timers', () => {
  it('acts for a player whose turn times out', () => {
    const gm = manager([2]);
    const g = gm.create(twoHumans());
    vi.advanceTimersByTime(29_999);
    expect(gm.get(g.id)!.version).toBe(1);
    vi.advanceTimersByTime(1);
    const s = gm.get(g.id)!;
    expect(s.version).toBe(2);
    expect(s.seats[0].timeouts).toBe(1);
    expect(s.turn.seat).toBe(1);
  });

  it(`hands a seat to a takeover bot after ${MAX_MISSED_TURNS} missed turns in a row`, () => {
    expect(MAX_MISSED_TURNS).toBe(5);
    const gm = manager(Array(20).fill(1));
    const g = gm.create(twoHumans());
    // Red and green alternate missing turns: red's 5th miss is the 9th timeout.
    for (let i = 0; i < 8; i++) vi.advanceTimersByTime(30_000);
    expect(gm.get(g.id)!.seats[0]).toMatchObject({ controller: 'human', timeouts: 4 });
    vi.advanceTimersByTime(30_000);
    expect(gm.get(g.id)!.seats[0]).toMatchObject({ controller: 'takeover', timeouts: 5 });
    expect(gm.get(g.id)!.seats[1]).toMatchObject({ controller: 'human', timeouts: 4 });
  });

  it('a missed timer auto-plays the whole rest of that turn, then hands back', () => {
    const gm = manager([6, 3, 2]);
    const g = gm.create(twoHumans());
    vi.advanceTimersByTime(30_000); // red misses the roll: server rolls a 6
    let s = gm.get(g.id)!;
    expect(s.turn).toMatchObject({ seat: 0, phase: 'rolling', queue: [6], auto: true, deadline: 0 });
    // No second 30s wait: the rest of the turn plays at bot speed.
    vi.advanceTimersByTime(500); // rolls 3
    vi.advanceTimersByTime(500); // plays the 6 (token out)
    vi.advanceTimersByTime(500); // plays the 3
    s = gm.get(g.id)!;
    expect(s.tokens.red.filter((p) => p === 3)).toHaveLength(1);
    expect(s.turn).toMatchObject({ seat: 1, auto: false });
    expect(s.seats[0]).toMatchObject({ controller: 'human', timeouts: 1 });
    // Green plays normally; red's next turn has a full timer again.
    expect(gm.roll(B, intent(g.id, s.version))).toEqual({ ok: true });
    s = gm.get(g.id)!;
    expect(s.turn).toMatchObject({ seat: 0, auto: false });
    expect(s.turn.deadline).toBeGreaterThan(Date.now() + 29_000);
  });

  it('a player can interrupt their own auto-played turn', () => {
    const gm = manager([6, 3]);
    const g = gm.create(twoHumans());
    vi.advanceTimersByTime(30_000);
    const s = gm.get(g.id)!;
    expect(s.turn.auto).toBe(true);
    expect(gm.roll(A, intent(g.id, s.version))).toEqual({ ok: true });
    expect(gm.get(g.id)!.turn.auto).toBe(false);
    expect(gm.get(g.id)!.seats[0].timeouts).toBe(0);
  });

  it('waits for clients to finish animating before a bot acts', () => {
    const gm = manager([4, 4], { animScale: 1 });
    const g = gm.create(lobby([{ userId: A, username: 'alice' }, { isBot: true, username: 'Bot Green' }]));
    gm.roll(A, intent(g.id, 1)); // red: roll 4, no moves, turn → bot (animation ≈ 1200 + 650ms)
    vi.advanceTimersByTime(500 + 1849);
    expect(gm.get(g.id)!.version).toBe(2);
    vi.advanceTimersByTime(1);
    expect(gm.get(g.id)!.version).toBe(3);
  });

  it('presence changes do not extend the current player\'s timer', () => {
    const gm = manager([2]);
    const g = gm.create(twoHumans());
    vi.advanceTimersByTime(20_000);
    gm.setConnected(B, false);
    gm.setConnected(B, true);
    vi.advanceTimersByTime(10_000);
    expect(gm.get(g.id)!.version).toBe(2);
  });

  it('auto-plays a forced single move after a short delay', () => {
    const gm = manager([6, 3]);
    const g = gm.create(twoHumans());
    gm.roll(A, intent(g.id, 1));
    gm.roll(A, intent(g.id, 2));
    // Four tokens in base and a 6: all equivalent, so the server plays it.
    vi.advanceTimersByTime(600);
    const s = gm.get(g.id)!;
    expect(s.tokens.red.filter((p) => p === 0)).toHaveLength(1);
    // Then the 3 is the only choice too.
    vi.advanceTimersByTime(600);
    expect(gm.get(g.id)!.tokens.red.includes(3)).toBe(true);
    expect(gm.get(g.id)!.seats[0].timeouts).toBe(0);
  });

  it('bot seats play by themselves', () => {
    const gm = manager([5, 4]);
    const g = gm.create(lobby([{ isBot: true, username: 'Bot Red' }, { userId: B, username: 'bob' }]));
    vi.advanceTimersByTime(500);
    expect(gm.get(g.id)!.turn.seat).toBe(1);
  });
});

describe('disconnects', () => {
  it('a bot takes over after the grace period and hands back on reconnect', () => {
    const gm = manager(Array(50).fill(1));
    const g = gm.create(twoHumans());
    gm.setConnected(B, false);
    expect(gm.get(g.id)!.seats[1]).toMatchObject({ connected: false, controller: 'human' });
    vi.advanceTimersByTime(59_000);
    expect(gm.get(g.id)!.seats[1].controller).toBe('human');
    vi.advanceTimersByTime(1_000);
    expect(gm.get(g.id)!.seats[1].controller).toBe('takeover');
    gm.setConnected(B, true);
    expect(gm.get(g.id)!.seats[1]).toMatchObject({ connected: true, controller: 'human', timeouts: 0 });
  });

  it('reconnecting before the grace period ends cancels the takeover', () => {
    const gm = manager(Array(50).fill(1));
    const g = gm.create(twoHumans());
    gm.setConnected(B, false);
    vi.advanceTimersByTime(30_000);
    gm.setConnected(B, true);
    vi.advanceTimersByTime(60_000);
    expect(gm.get(g.id)!.seats[1].controller).toBe('human');
  });

  it('presence changes do not bump the version', () => {
    const gm = manager([3]);
    const g = gm.create(twoHumans());
    gm.setConnected(B, false);
    gm.setConnected(B, true);
    expect(gm.get(g.id)!.version).toBe(1);
    expect(gm.roll(A, intent(g.id, 1))).toEqual({ ok: true });
  });

  it('acting yourself takes the seat back from the takeover bot', () => {
    const gm = manager(Array(20).fill(2));
    const g = gm.create(twoHumans());
    for (let i = 0; i < 9; i++) vi.advanceTimersByTime(30_000);
    const s = gm.get(g.id)!;
    expect(s.seats[0].controller).toBe('takeover');
    expect(s.turn.seat).toBe(1);
    gm.roll(B, intent(g.id, s.version));
    // Red's turn again; red acts before the bot does.
    expect(gm.roll(A, intent(g.id, gm.get(g.id)!.version))).toEqual({ ok: true });
    expect(gm.get(g.id)!.seats[0]).toMatchObject({ controller: 'human', timeouts: 0 });
  });

  it('leaving for good hands the seat to a permanent bot', () => {
    const gm = manager([3, 3]);
    const g = gm.create(twoHumans());
    gm.leave(g.id, B);
    expect(gm.get(g.id)!.seats[1]).toMatchObject({ controller: 'bot', userId: null });
    expect(gm.takeback(B, g.id)).toEqual({ ok: false, error: 'NO_GAME' });
  });
});

describe('persistence', () => {
  it('round-trips through the database, including seat controllers', () => {
    // Long turn timeout so only B's disconnect grace period fires.
    const gm = manager([6, 4], { turnTimeoutSec: 1000 });
    const g = gm.create(twoHumans());
    gm.roll(A, intent(g.id, 1));
    gm.setConnected(B, false);
    vi.advanceTimersByTime(60_000);
    const before = structuredClone(gm.get(g.id)!);
    gm.shutdown();

    const restored = manager([4]);
    expect(restored.restore()).toBe(1);
    const after = restored.get(g.id)!;
    expect(after.tokens).toEqual(before.tokens);
    expect(after.turn.queue).toEqual(before.turn.queue);
    expect(after.version).toBe(before.version);
    expect(after.seats.map((s) => [s.color, s.userId, s.controller])).toEqual(before.seats.map((s) => [s.color, s.userId, s.controller]));
    // Everyone is offline until they reconnect.
    expect(after.seats.every((s) => !s.connected)).toBe(true);
    expect(restored.roll(A, intent(g.id, after.version))).toEqual({ ok: true });
  });

  it('serves finished games from the database', () => {
    const gm = manager([2]);
    const g = gm.create(twoHumans());
    const s = gm.get(g.id)!;
    s.tokens.red = [HOME, HOME, HOME, 54];
    s.turn.phase = 'moving';
    s.turn.queue = [2];
    expect(gm.move(A, intent(g.id, 1, { dieIndex: 0, tokenId: 3 }))).toEqual({ ok: true });
    expect(gameOver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11 * 60_000);
    expect(gm.get(g.id)).toBeUndefined();
    expect(gm.find(g.id)).toMatchObject({ finished: true, ranks: ['red', 'green'] });
  });

  it('aborting a game stops its timers and marks it finished', () => {
    const gm = manager([]);
    const g = gm.create(twoHumans());
    gm.abort(g.id);
    vi.advanceTimersByTime(120_000);
    expect(gm.find(g.id)?.finished).toBe(true);
    expect(gm.get(g.id)).toBeUndefined();
  });
});

describe('a full bot game', () => {
  it('four bots finish a game with every rule in play', () => {
    vi.useRealTimers();
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647), (seed % 6) + 1);
    const gm = new GameManager({
      db,
      dice: rng,
      turnTimeoutSec: 30,
      disconnectGraceSec: 60,
      botDelayMs: 0,
      animScale: 0,
      randomInt: () => 0,
      onGameOver: gameOver,
    });
    vi.useFakeTimers();
    const g = gm.create(lobby([{ isBot: true }, { isBot: true }, { isBot: true }, { isBot: true }]));
    for (let i = 0; i < 20_000 && !gm.get(g.id)!.finished; i++) vi.advanceTimersByTime(1);
    const s = gm.get(g.id)!;
    expect(s.finished).toBe(true);
    expect(new Set(s.ranks)).toEqual(new Set(['red', 'green', 'yellow', 'blue']));
    expect(s.tokens.red.every((p) => p === HOME || p === BASE || p >= 0)).toBe(true);
    expect(gameOver).toHaveBeenCalledTimes(1);
  });
});
