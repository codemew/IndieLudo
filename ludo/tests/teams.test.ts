import { afterEach, describe, expect, it } from 'vitest';
import { BASE, HOME, LAP2_FIRST } from '../src/shared/board.js';
import { RuleError, applyMove, applyRespawn, applyRoll, applySurrender, createGameState, currentColor, hasExtraLap, isTeammate, legalMoves, statsOf, winnersOf } from '../src/shared/rules.js';
import { threatenedTokens } from '../src/shared/threats.js';
import { gameAwards } from '../src/shared/awards.js';
import { chooseMove } from '../src/server/bot.js';
import { TEAMMATE, type Color, type PublicLobby } from '../src/shared/types.js';
import { seat, withQueue } from './helpers.js';
import { client, createLobby, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

const H = HOME;
/** A Team-up game: red+yellow against green+blue, red to move. */
const teamGame = (first = 0) =>
  createGameState({ id: 'g', lobbyId: 'l', seats: (['red', 'green', 'yellow', 'blue'] as Color[]).map((c, i) => seat(c, i + 1)), firstSeat: first, teams: true, now: 0 });

describe('Team-up rules', () => {
  it('needs all four seats', () => {
    expect(() => createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('yellow', 2)], teams: true })).toThrow(RuleError);
    expect(teamGame().teams).toBe(true);
    expect(createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('yellow', 2)] }).teams).toBeUndefined();
  });

  it('partners are diagonal: red with yellow, green with blue', () => {
    const s = teamGame();
    expect(isTeammate(s, 'red', 'yellow')).toBe(true);
    expect(isTeammate(s, 'green', 'blue')).toBe(true);
    expect(isTeammate(s, 'red', 'green')).toBe(false);
    expect(isTeammate({ teams: false }, 'red', 'yellow')).toBe(false);
    expect(TEAMMATE.yellow).toBe('red');
  });

  it('a partner who finishes first sits out; the team wins when the second gets home', () => {
    const s = withQueue(teamGame(), [1]);
    s.tokens.red = [H, H, H, 55];
    s.tokens.green = [H, H, H, H];
    s.ranks = ['green']; // green finished earlier, but its partner blue hasn't
    const events = applyMove(s, 0, 3); // red's last token home
    expect(s.finished).toBe(false);
    expect(s.ranks).toEqual(['green', 'red']);
    expect(currentColor(s)).toBe('yellow'); // skips finished green
    applyRoll(s, 3);
    expect(currentColor(s)).toBe('blue'); // yellow had nothing out
    expect(events.at(-1)).toMatchObject({ type: 'turn', color: 'yellow' });
    // Yellow finishes: red+yellow win, ahead of green who finished before yellow.
    Object.assign(s.turn, { seat: 2, phase: 'moving', queue: [2], bonus: 0 });
    s.tokens.yellow = [H, H, H, 54];
    const end = applyMove(s, 0, 3);
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual(['red', 'yellow', 'green', 'blue']);
    expect(end.at(-1)).toEqual({ type: 'gameOver', ranks: ['red', 'yellow', 'green', 'blue'] });
    expect(winnersOf(s)).toEqual(['red', 'yellow']);
  });

  it('winnersOf: nobody yet, the first finisher in a classic game', () => {
    expect(winnersOf({ ranks: [] })).toEqual([]);
    expect(winnersOf({ ranks: ['blue', 'red'] })).toEqual(['blue']);
    expect(winnersOf({ ranks: ['blue', 'green'], teams: true })).toEqual(['blue', 'green']);
  });

  it('a surrender concedes for the team: the other team wins at once', () => {
    const s = teamGame();
    s.tokens.yellow = [H, 20, BASE, BASE];
    s.tokens.blue = [H, H, H, H];
    s.ranks = ['blue'];
    const events = applySurrender(s, 'red');
    expect(s.finished).toBe(true);
    expect(s.ranks).toEqual(['blue', 'green', 'yellow', 'red']);
    expect(winnersOf(s)).toEqual(['blue', 'green']);
    expect(events.map((e) => e.type)).toEqual(['surrender', 'gameOver']);
  });

  it('a finished partner can rejoin with a wildcard entry; the team then needs them home again', () => {
    const s = withQueue(teamGame(2), [1]); // yellow to move
    s.tokens.red = [H, H, H, H];
    s.ranks = ['red'];
    applyRespawn(s, 'red', [0]);
    expect(s.ranks).toEqual([]);
    s.tokens.yellow = [H, H, H, 55];
    applyMove(s, 0, 3); // yellow home, but red isn't any more
    expect(s.finished).toBe(false);
    expect(s.ranks).toEqual(['yellow']);
  });

  it('friendly fire: allowed, a bonus roll, but the capturer’s moustache shrinks a level and it counts for nothing else', () => {
    const s = withQueue(teamGame(), [3]);
    s.tokens.red = [10, BASE, BASE, BASE];
    s.tokens.yellow = [39, BASE, BASE, BASE]; // absolute (26 + 39) % 52 = 13: a start square, safe
    expect(legalMoves(s)[0].captures).toEqual([]);
    s.tokens.yellow = [41, BASE, BASE, BASE]; // absolute (26 + 41) % 52 = 15
    s.tokens.red = [12, BASE, BASE, BASE];
    s.kills = { red: [6, 0, 0, 0], yellow: [2, 0, 0, 0] };
    const m = legalMoves(s)[0];
    expect(m.captures).toEqual([{ color: 'yellow', tokenId: 0 }]);
    const events = applyMove(s, 0, 0);
    expect(events.find((e) => e.type === 'capture')).toEqual({ type: 'capture', color: 'red', victim: 'yellow', tokenId: 0, from: 41, friendly: true });
    expect(s.tokens.yellow[0]).toBe(BASE);
    expect(s.kills!.red![0]).toBe(3); // level 4 (6 kills) down to level 3
    expect(s.kills!.yellow![0]).toBe(0);
    expect(s.firstBlood).toBe(false);
    expect(statsOf(s, 'red')).toMatchObject({ captures: 0, friendlyFire: 1, staches: 0, revenges: 0, firstBlood: false });
    expect(statsOf(s, 'yellow').owed).toEqual({});
    expect(s.turn.phase).toBe('rolling'); // the bonus roll
    expect(currentColor(s)).toBe('red');
  });

  it('friendly fire on a clean-shaven capturer leaves it clean-shaven; a second-lap victim gets its extra lap back', () => {
    const s = withQueue(teamGame(), [2]);
    s.tokens.red = [13, BASE, BASE, BASE];
    // yellow's second-lap 99 is absolute (26 + 99 - 6) % 52 = 15
    s.tokens.yellow = [99, BASE, BASE, BASE];
    expect(99).toBeGreaterThan(LAP2_FIRST);
    s.extraLaps = { yellow: [1, 0, 0, 0] };
    applyMove(s, 0, 0);
    expect(s.kills?.red?.[0] ?? 0).toBe(0);
    expect(hasExtraLap(s, 'yellow', 0)).toBe(true);
  });

  it('a mixed square: the opponent counts as a capture and the teammate as friendly fire, in seat order', () => {
    const s = withQueue(teamGame(), [2]);
    s.tokens.red = [13, BASE, BASE, BASE];
    s.tokens.green = [2, BASE, BASE, BASE]; // absolute 15
    s.tokens.yellow = [41, BASE, BASE, BASE]; // absolute 15
    s.kills = { red: [2, 0, 0, 0] };
    const events = applyMove(s, 0, 0);
    expect(events.filter((e) => e.type === 'capture').map((e) => [e.type === 'capture' && e.victim, e.type === 'capture' && e.friendly])).toEqual([
      ['green', undefined],
      ['yellow', true],
    ]);
    expect(s.kills!.red![0]).toBe(2); // 2 → 3 for green, back to 2 for yellow
    expect(statsOf(s, 'red')).toMatchObject({ captures: 1, friendlyFire: 1, firstBlood: true });
    expect(s.turn.bonus).toBe(1); // two bonus rolls: one taken now, one waiting
  });

  it('bots never capture a teammate when anything else is possible, but will when it is the only move', () => {
    const s = withQueue(teamGame(), [2]);
    s.tokens.red = [13, 30, BASE, BASE];
    s.tokens.yellow = [41, BASE, BASE, BASE]; // red's 13 + 2 lands on it
    expect(chooseMove(s)?.tokenId).toBe(1);
    s.tokens.red = [13, H, H, H];
    expect(chooseMove(s)).toMatchObject({ tokenId: 0, captures: [{ color: 'yellow', tokenId: 0 }] });
    // Classic: the same square is a capture worth taking.
    const c = withQueue(createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('yellow', 2)], now: 0 }), [2]);
    c.tokens.red = [13, 30, BASE, BASE];
    c.tokens.yellow = [41, BASE, BASE, BASE];
    expect(chooseMove(c)?.tokenId).toBe(0);
  });

  it('a teammate is no threat: neither the warnings nor the bots worry about them', () => {
    const s = teamGame();
    s.tokens.red = [10, BASE, BASE, BASE]; // absolute 10
    s.tokens.yellow = [34, BASE, BASE, BASE]; // absolute 8: two behind red
    expect(threatenedTokens(s).has('red:0')).toBe(false);
    s.teams = false;
    expect(threatenedTokens(s).has('red:0')).toBe(true);
  });

  it('awards: "Backstabber" for the most friendly fire, "Balls of steel" for the most risks', () => {
    const s = teamGame();
    statsOf(s, 'red').friendlyFire = 2;
    statsOf(s, 'blue').friendlyFire = 1;
    statsOf(s, 'green').risks = 3;
    statsOf(s, 'yellow').risks = 3;
    const awards = gameAwards(s);
    expect(awards.find((a) => a.key === 'friendlyFire')).toMatchObject({ title: 'Backstabber', colors: ['red'], value: 2 });
    expect(awards.find((a) => a.key === 'risks')).toMatchObject({ title: 'Balls of steel', colors: ['green', 'yellow'], value: 3 });
  });
});

describe('Team-up over the network', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the host switches the mode (clearing ready); it needs 4 seats; partners share the win', async () => {
    t = await startTestServer();
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    await bob.emit('lobby:color', { color: 'yellow' }); // alice is red: bob is her partner
    await bob.emit('lobby:ready', { ready: true });
    expect(await bob.emit('lobby:mode', { teams: true })).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(await alice.emit('lobby:mode', { teams: 'yes' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await alice.emit('lobby:mode', { teams: true })).toEqual({ ok: true });
    let lobby = t.server.ctx.lobbies.toPublic(t.server.ctx.lobbies.get(lobbyId)!) as PublicLobby;
    expect(lobby.teams).toBe(true);
    expect(lobby.members.find((m) => m.userId === bob.userId)!.ready).toBe(false);
    expect(t.server.ctx.lobbies.summaries()[0].teams).toBe(true);
    await bob.emit('lobby:ready', { ready: true });
    expect(await alice.emit('lobby:start', {})).toEqual({ ok: false, error: 'TEAMS_NEED_FOUR' });
    await alice.emit('lobby:fillBots', {});
    const first = alice.nextState();
    expect(await alice.emit('lobby:start', {})).toEqual({ ok: true });
    const { state } = await first;
    expect(state.teams).toBe(true);
    const g = t.server.ctx.games.get(state.id)!;
    // Bob is home already; alice brings her last token in.
    g.tokens.yellow = [H, H, H, H];
    g.ranks = ['yellow'];
    g.tokens.red = [H, H, H, 55];
    Object.assign(g.turn, { seat: 0, phase: 'moving', queue: [1], bonus: 0 });
    const over = alice.nextState((u) => u.state.finished);
    expect(await alice.emit('game:move', { gameId: g.id, version: g.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 3 })).toEqual({ ok: true });
    expect((await over).state.ranks.slice(0, 2)).toEqual(['yellow', 'red']);
    expect(t.server.ctx.users.get(alice.userId)!.wins).toBe(1);
    expect(t.server.ctx.users.get(bob.userId)!.wins).toBe(1);
    lobby = t.server.ctx.lobbies.toPublic(t.server.ctx.lobbies.get(lobbyId)!);
    expect(lobby.teams).toBe(true); // the mode stays for the next game
    expect(await alice.emit('lobby:mode', { teams: true })).toEqual({ ok: true }); // unchanged: no-op
  });
});
