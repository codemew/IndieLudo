import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE } from '../src/shared/board.js';
import { gameAwards, playerStats } from '../src/shared/awards.js';
import { applyMove, distinctChoices, legalMoves } from '../src/shared/rules.js';
import type { GameState } from '../src/shared/types.js';
import { chooseMove } from '../src/server/bot.js';
import { GameManager } from '../src/server/gameManager.js';
import { openDb } from '../src/server/db.js';
import type { Lobby } from '../src/server/lobbies.js';
import { game, scriptedDice, withQueue } from './helpers.js';

/** Red has two tokens on its star (absolute 8): token 0 clean-shaven, token 1 with `kills`. */
function stacked(kills: number): GameState {
  const s = withQueue(game(), [3]);
  s.tokens.red = [8, 8, BASE, BASE];
  s.kills = { red: [0, kills, 0, 0] };
  return s;
}

describe('choosing between tokens stacked on one square', () => {
  it('tokens with different moustaches are different choices, so the server asks instead of picking', () => {
    expect(distinctChoices(legalMoves(stacked(3)), stacked(3))).toHaveLength(2);
    // Same moustache (here none): truly the same move, fine to play it for the player.
    expect(distinctChoices(legalMoves(stacked(0)), stacked(0))).toHaveLength(1);
    // Without the state (older callers) it still collapses by square only.
    expect(distinctChoices(legalMoves(stacked(3)))).toHaveLength(1);
  });

  it('the player decides which one goes: moving the clean-shaven one leaves the macho one where it was', () => {
    const s = stacked(4);
    applyMove(s, 0, 0);
    expect(s.tokens.red.slice(0, 2)).toEqual([11, 8]);
    expect(s.kills!.red![1]).toBe(4);
    const t = stacked(4);
    applyMove(t, 0, 1);
    expect(t.tokens.red.slice(0, 2)).toEqual([8, 11]);
  });

  it('a bot, or the timer playing for someone, moves the smaller moustache and keeps the macho one safe', () => {
    expect(chooseMove(stacked(3))!.tokenId).toBe(0);
    const s = stacked(3);
    s.kills = { red: [2, 0, 0, 0] }; // now token 1 is the clean one
    expect(chooseMove(s)!.tokenId).toBe(1);
  });
});

describe('the server waits for the choice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const lobby: Lobby = {
    id: 'l1', name: 'L', hostId: 1, passwordHash: 'x:y', status: 'waiting', gameId: null, createdAt: 0, allOfflineSince: null, spectators: [],
    members: [
      { color: 'red', userId: 1, username: 'alice', isBot: false, ready: true, connected: true },
      { color: 'green', userId: 2, username: 'bob', isBot: false, ready: true, connected: true },
    ],
  };
  const setup = (kills: number) => {
    const gm = new GameManager({ db: openDb(':memory:'), dice: scriptedDice([3]), turnTimeoutSec: 30, disconnectGraceSec: 60, botDelayMs: 0, autoMoveDelayMs: 600, animScale: 0, randomInt: () => 0 });
    const g = gm.create(lobby);
    g.tokens.red = [8, 8, BASE, BASE];
    g.kills = { red: [0, kills, 0, 0] };
    gm.roll(1, { gameId: g.id, version: 1, actionId: crypto.randomUUID() });
    return { gm, g };
  };

  it('no auto-move when the stacked tokens wear different moustaches', () => {
    const { gm, g } = setup(2);
    vi.advanceTimersByTime(5000);
    expect(gm.get(g.id)!.tokens.red.slice(0, 2)).toEqual([8, 8]);
    expect(gm.get(g.id)!.turn.deadline).toBeGreaterThan(0); // the player's own timer runs instead
    expect(gm.move(1, { gameId: g.id, version: gm.get(g.id)!.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 0 })).toEqual({ ok: true });
    expect(gm.get(g.id)!.tokens.red.slice(0, 2)).toEqual([11, 8]);
  });

  it('still auto-moves when the stacked tokens are alike', () => {
    const { gm, g } = setup(0);
    vi.advanceTimersByTime(600);
    expect(gm.get(g.id)!.tokens.red.filter((p) => p === 11)).toHaveLength(1);
  });
});

describe("Barber's nightmare: tokens that grew a moustache", () => {
  it("counts a clean-shaven token's first capture, not its later ones; shaved and regrown counts again", () => {
    const s = withQueue(game(), [3, 1, 1]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, 32, 33, BASE]; // absolute 5, 6, 7
    applyMove(s, 0, 0); // red 0 captures at 5: grows a moustache
    expect(playerStats(s, 'red').staches).toBe(1);
    applyMove(s, 0, 0); // captures again at 6: thicker moustache, same token
    expect(playerStats(s, 'red').staches).toBe(1);
    s.kills!.red![0] = 0; // shaved (captured and back out again)
    applyMove(s, 0, 0); // captures at 7: grows one again
    expect(playerStats(s, 'red').staches).toBe(2);
  });

  it('the award goes to whoever made the most, and older games count it as 0', () => {
    const s = game(['red', 'green']);
    const base = { cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {} };
    s.stats = { red: { ...base, staches: 3 }, green: { ...base, staches: 1 } };
    expect(gameAwards(s).find((a) => a.key === 'staches')).toEqual({ key: 'staches', icon: '💈', title: "Barber's nightmare", colors: ['red'], value: 3 });
    s.stats = { red: base, green: base };
    expect(gameAwards(s).find((a) => a.key === 'staches')).toBeUndefined();
    expect(playerStats(s, 'red').staches).toBe(0);
  });
});
