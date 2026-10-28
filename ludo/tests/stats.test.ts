import { describe, expect, it } from 'vitest';
import { BASE } from '../src/shared/board.js';
import { gameAwards, playerStats } from '../src/shared/awards.js';
import { applyMove, applyRoll } from '../src/shared/rules.js';
import type { GameState } from '../src/shared/types.js';
import { game, withQueue } from './helpers.js';

describe('match stats', () => {
  it('counts cells moved (leaving base is 1) and every six rolled', () => {
    const s = game();
    applyRoll(s, 6);
    applyRoll(s, 2);
    applyMove(s, 0, 0); // base → start: 1 cell
    applyMove(s, 0, 0); // 0 → 2: 2 cells
    expect(playerStats(s, 'red')).toMatchObject({ cells: 3, sixes: 1, captures: 0 });
  });

  it('a capture of someone who captured you is a revenge, and only pays back once per capture', () => {
    const s = withQueue(game(), [3]);
    // Yellow already captured red once (red owes yellow one).
    s.stats = { red: { cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: { yellow: 1 } } };
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, 32, BASE, BASE]; // absolute 5 and 6
    applyMove(s, 0, 0);
    expect(playerStats(s, 'red')).toMatchObject({ captures: 1, revenges: 1, owed: { yellow: 0 } });
    expect(playerStats(s, 'yellow').owed).toEqual({ red: 1 }); // now yellow wants revenge

    s.turn = { ...s.turn, phase: 'moving', queue: [1] };
    applyMove(s, 0, 0); // captures yellow again: no debt left, so no revenge
    expect(playerStats(s, 'red')).toMatchObject({ captures: 2, revenges: 1 });
    expect(playerStats(s, 'yellow').owed).toEqual({ red: 2 });
  });

  it("first blood is recorded in the capturer's stats", () => {
    const s = withQueue(game(), [3]);
    s.tokens.red = [2, BASE, BASE, BASE];
    s.tokens.yellow = [31, BASE, BASE, BASE];
    applyMove(s, 0, 0);
    expect(playerStats(s, 'red').firstBlood).toBe(true);
    expect(playerStats(s, 'yellow').firstBlood).toBe(false);
  });

  it('macho: a token that captured someone counts when it reaches home; a clean-shaven one does not', () => {
    const s = withQueue(game(), [3, 2]);
    s.tokens.red = [53, 54, BASE, BASE];
    s.kills = { red: [2, 0, 0, 0] };
    applyMove(s, 0, 0); // 53 + 3 = home, with 2 kills
    expect(playerStats(s, 'red').machoHome).toBe(1);
    applyMove(s, 0, 1); // 54 + 2 = home, no kills
    expect(playerStats(s, 'red').machoHome).toBe(1);
  });

  it('macho: a captured token loses its moustache, so it no longer counts when it gets home', () => {
    const s = withQueue(game(['red', 'yellow'], 1), [3]); // yellow moves
    s.tokens.red = [5, BASE, BASE, BASE]; // absolute 5
    s.tokens.yellow = [28, BASE, BASE, BASE]; // absolute 2
    s.kills = { red: [3, 0, 0, 0] };
    applyMove(s, 0, 0);
    expect(s.kills.red![0]).toBe(0);
    expect(s.kills.yellow![0]).toBe(1);
  });
});

describe('gameAwards', () => {
  const stats = (o: object) => ({ cells: 0, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {}, ...o });

  it('the best in each stat wins it, ties are shared, nobody wins a stat nobody scored', () => {
    const s = game(['red', 'green', 'yellow']);
    s.stats = {
      red: stats({ cells: 120, captures: 2, sixes: 3, firstBlood: true }),
      green: stats({ cells: 90, captures: 2, sixes: 5 }),
      yellow: stats({ cells: 40 }),
    };
    expect(gameAwards(s).map((a) => [a.key, a.colors, a.value])).toEqual([
      ['cells', ['red'], 120],
      ['captures', ['red', 'green'], 2],
      ['sixes', ['green'], 5],
      ['firstBlood', ['red'], 1],
    ]);
  });

  it('most macho goes to whoever brought the most moustached tokens home', () => {
    const s = game(['red', 'green']);
    s.stats = { red: stats({ machoHome: 1 }), green: stats({ machoHome: 3 }) };
    expect(gameAwards(s)).toEqual([{ key: 'machoHome', icon: '🥸', title: 'Most macho', colors: ['green'], value: 3 }]);
  });

  it('stats saved before macho existed count it as 0, with no award and no crash', () => {
    const s = game(['red', 'green']);
    s.stats = { red: { cells: 10, captures: 0, sixes: 0, revenges: 0, firstBlood: false, owed: {} } } as GameState['stats'];
    expect(playerStats(s, 'red').machoHome).toBe(0);
    expect(gameAwards(s).map((a) => a.key)).toEqual(['cells']);
  });

  it('a game without stats (saved before they existed) has no awards', () => {
    expect(gameAwards(game())).toEqual([]);
  });
});

describe('wins beside names in the lobby', () => {
  it('shows each human\'s wins, updated right after a game; bots have none', async () => {
    const { HOME } = await import('../src/shared/board.js');
    const { scriptedDice } = await import('./helpers.js');
    const { client, createLobby, startTestServer, wait } = await import('./serverHelpers.js');
    const t = await startTestServer({}, { dice: scriptedDice(Array(50).fill(1)) });
    const host = await client(t, 'alice');
    const guest = await client(t, 'bob');
    try {
      const lobbyId = await createLobby(host);
      await guest.emit('lobby:join', { lobbyId, password: 'pw' });
      await host.emit('lobby:addBot', {});
      await wait(30);
      const members = () => host.lobbyStates.at(-1)!.members.map((m) => [m.username, m.wins]);
      expect(members()).toEqual([
        ['alice', 0],
        ['bob', 0],
        [expect.any(String), undefined],
      ]);
      await host.emit('lobby:removeBot', { color: host.lobbyStates.at(-1)!.members[2].color });

      await guest.emit('lobby:ready', { ready: true });
      const first = host.nextState();
      await host.emit('lobby:start', {});
      const gameId = (await first).state.id;
      const s = t.server.ctx.games.get(gameId)!;
      s.tokens.red = [HOME, HOME, HOME, 55];
      await host.emit('game:roll', { gameId, version: s.version, actionId: crypto.randomUUID() });
      await host.emit('game:move', { gameId, version: s.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 3 });
      await wait(50);
      expect(members()).toEqual([
        ['alice', 1],
        ['bob', 0],
      ]);
    } finally {
      host.close();
      guest.close();
      await t.close();
    }
  });
});
