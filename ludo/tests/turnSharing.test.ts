import { afterEach, describe, expect, it } from 'vitest';
import { BASE, HOME, LAP2_FIRST } from '../src/shared/board.js';
import { RuleError, applyMove, applyRoll, createGameState, currentColor, distinctChoices, hasExtraLap, legalMoves, movableColors, statsOf, takesTurns, winnersOf } from '../src/shared/rules.js';
import { chooseMove } from '../src/server/bot.js';
import { EMPTY_STATS, gameAwards } from '../src/shared/awards.js';
import type { Color, PublicLobby } from '../src/shared/types.js';
import { seat, withQueue } from './helpers.js';
import { client, createLobby, startTestServer, type TestClient, type TestServer } from './serverHelpers.js';

const H = HOME;
const COLORS = ['red', 'green', 'yellow', 'blue'] as Color[];
/** Team-up with turn sharing: red + yellow against green + blue, red to move. */
const shared = (opts: { share?: boolean; first?: number } = {}) =>
  createGameState({ id: 'g', lobbyId: 'l', seats: COLORS.map((c, i) => seat(c, i + 1)), firstSeat: opts.first ?? 0, teams: true, share: opts.share ?? true, now: 0 });
/** Everyone in base but the tokens given. */
const place = (s: ReturnType<typeof shared>, tokens: Partial<Record<Color, number[]>>) => Object.assign(s.tokens, tokens);

describe('turn sharing: the rule', () => {
  it('is only ever on in Team-up', () => {
    expect(shared().share).toBe(true);
    expect(shared({ share: false }).share).toBeUndefined();
    const classic = createGameState({ id: 'g', lobbyId: 'l', seats: [seat('red', 1), seat('green', 2)], share: true });
    expect(classic.share).toBeUndefined();
    expect(movableColors(classic, 'red')).toEqual(['red']);
    expect(movableColors(shared(), 'red')).toEqual(['red', 'yellow']);
    expect(movableColors(shared({ share: false }), 'red')).toEqual(['red']);
    expect(movableColors(shared(), 'blue')).toEqual(['blue', 'green']);
  });

  it('a die can move the partner\'s token too: those moves carry the partner\'s colour', () => {
    const s = withQueue(shared(), [3]);
    place(s, { red: [5, BASE, BASE, BASE], yellow: [20, BASE, BASE, BASE] });
    const moves = legalMoves(s);
    expect(moves.map((m) => [m.color, m.tokenId, m.from, m.to])).toEqual([
      [undefined, 0, 5, 8],
      ['yellow', 0, 20, 23],
    ]);
    // Without sharing, only the player's own.
    const plain = withQueue(shared({ share: false }), [3]);
    place(plain, { red: [5, BASE, BASE, BASE], yellow: [20, BASE, BASE, BASE] });
    expect(legalMoves(plain).map((m) => m.color)).toEqual([undefined]);
  });

  it('moving the partner\'s token: the board change is the token\'s, the stats are the mover\'s', () => {
    const s = withQueue(shared(), [3]);
    place(s, { yellow: [20, BASE, BASE, BASE] });
    s.kills = { yellow: [2, 0, 0, 0] };
    const events = applyMove(s, 0, 0, false, 'yellow');
    expect(s.tokens.yellow[0]).toBe(23);
    expect(s.tokens.red).toEqual([BASE, BASE, BASE, BASE]);
    expect(events[0]).toMatchObject({ type: 'move', color: 'yellow', tokenId: 0, from: 20, to: 23, die: 3, kills: 2 });
    // The squares are help given (Guardian), not red's own travel.
    expect(statsOf(s, 'red').helped).toBe(3);
    expect(statsOf(s, 'red').cells).toBe(0);
    expect(s.stats?.yellow?.cells ?? 0).toBe(0);
    expect(s.stats?.yellow?.helped ?? 0).toBe(0);
    expect(currentColor(s)).toBe('green'); // the turn passes on as usual
  });

  it('a token id alone names red\'s token; the partner\'s needs its colour, and only with sharing', () => {
    const s = withQueue(shared(), [3]);
    place(s, { red: [5, BASE, BASE, BASE], yellow: [20, BASE, BASE, BASE] });
    const copy = structuredClone(s);
    applyMove(copy, 0, 0);
    expect(copy.tokens.red[0]).toBe(8);
    expect(copy.tokens.yellow[0]).toBe(20);
    expect(() => applyMove(structuredClone(s), 0, 0, false, 'green')).toThrow(RuleError);
    const plain = withQueue(shared({ share: false }), [3]);
    place(plain, { yellow: [20, BASE, BASE, BASE] });
    expect(() => applyMove(plain, 0, 0, false, 'yellow')).toThrow('ILLEGAL_MOVE');
  });

  it('a six the player can\'t use but their partner can is still a roll to play, not a lost turn', () => {
    // Red's only tokens are in the home column (a 6 overshoots); yellow has one on the track.
    const mk = (share: boolean) => {
      const s = shared({ share });
      place(s, { red: [H - 1, H - 1, H, H], yellow: [10, BASE, BASE, BASE] });
      return s;
    };
    const ev = applyRoll(mk(true), 6);
    expect(ev.map((e) => e.type)).toEqual(['roll']);
    const s = mk(true);
    applyRoll(s, 6);
    expect(s.turn.sixes).toBe(1);
    expect(s.turn.phase).toBe('rolling'); // a six rolls again
    const lost = mk(false);
    expect(applyRoll(lost, 6).map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
  });

  it('captures: the partner\'s token grows its own moustache, the mover gets the capture and the bonus roll', () => {
    const s = withQueue(shared(), [3]);
    // Yellow starts at absolute 26; red's start is 0. Yellow progress 20 + 3 = 23 → absolute 49.
    // Green at progress 36 is absolute (13 + 36) % 52 = 49.
    place(s, { yellow: [20, BASE, BASE, BASE], green: [36, BASE, BASE, BASE] });
    const [m] = legalMoves(s).filter((x) => x.color === 'yellow');
    expect(m.captures).toEqual([{ color: 'green', tokenId: 0 }]);
    const events = applyMove(s, 0, 0, false, 'yellow');
    expect(events.find((e) => e.type === 'capture')).toMatchObject({ color: 'yellow', victim: 'green', tokenId: 0 });
    expect(s.kills?.yellow?.[0]).toBe(1);
    expect(s.kills?.red).toBeUndefined();
    expect(statsOf(s, 'red').captures).toBe(1);
    expect(statsOf(s, 'red').firstBlood).toBe(true);
    expect(s.stats?.green?.owed).toEqual({ red: 1 }); // green owes red, who made the move
    expect(events.at(-1)).toEqual({ type: 'bonus', color: 'red' }); // the bonus roll is the mover's
    expect(currentColor(s)).toBe('red');
  });

  it('the partner\'s token landing on the mover\'s own token is friendly fire: no bonus, and the partner\'s token loses a level', () => {
    const s = withQueue(shared(), [3]);
    // Yellow progress 20 → 23 is absolute 49. Red at progress 49 is absolute 49.
    place(s, { yellow: [20, BASE, BASE, BASE], red: [49, BASE, BASE, BASE] });
    s.kills = { yellow: [3, 0, 0, 0] };
    const events = applyMove(s, 0, 0, false, 'yellow');
    expect(events.find((e) => e.type === 'capture')).toMatchObject({ color: 'yellow', victim: 'red', friendly: true });
    expect(s.tokens.red[0]).toBe(BASE);
    expect(s.kills?.yellow?.[0]).toBeLessThan(3);
    expect(statsOf(s, 'red').friendlyFire).toBe(1);
    expect(statsOf(s, 'red').captures).toBe(0);
    expect(s.turn.bonus).toBe(0);
  });

  it('the partner\'s extra lap is spent on the partner\'s token, and the choice is its own move', () => {
    const s = withQueue(shared(), [4]);
    // A yellow token at the end of its first lap: it may go home, or round again.
    place(s, { yellow: [49, BASE, BASE, BASE] });
    const moves = legalMoves(s).filter((m) => m.color === 'yellow');
    expect(moves.map((m) => Boolean(m.lap))).toEqual([false, true]);
    const lap = moves.find((m) => m.lap)!;
    expect(lap.to).toBeGreaterThanOrEqual(LAP2_FIRST);
    applyMove(s, 0, 0, true, 'yellow');
    expect(hasExtraLap(s, 'yellow', 0)).toBe(false);
    expect(hasExtraLap(s, 'red', 0)).toBe(true);
    expect(statsOf(s, 'red').risks).toBe(1);
  });

  it('same-square tokens of the two partners are different choices', () => {
    const s = withQueue(shared(), [2]);
    place(s, { red: [30, BASE, BASE, BASE], yellow: [4, BASE, BASE, BASE] });
    const moves = legalMoves(s).filter((m) => m.tokenId === 0);
    expect(distinctChoices(moves, s)).toHaveLength(2);
    place(s, { red: [30, 30, BASE, BASE] });
    const own = legalMoves(s).filter((m) => !m.color);
    expect(distinctChoices(own, s)).toHaveLength(1); // alike: still one choice
  });
});

describe('turn sharing: Guardian award', () => {
  it('goes to the player who moved the most squares for their teammate; nobody gets it without sharing', () => {
    const s = shared();
    s.stats = { red: { ...EMPTY_STATS, cells: 10, helped: 14 }, yellow: { ...EMPTY_STATS, cells: 30, helped: 5 }, green: { ...EMPTY_STATS }, blue: { ...EMPTY_STATS } };
    const g = gameAwards(s).find((a) => a.key === 'helped');
    expect(g).toMatchObject({ title: 'Guardian', colors: ['red'], value: 14 });
    const none = shared({ share: false });
    expect(gameAwards(none).some((a) => a.key === 'helped')).toBe(false);
  });
});

describe('turn sharing: finishing and taking turns', () => {
  it('a player who gets home keeps the turn: the rest of the dice go to the partner, and the arrival earns a bonus roll', () => {
    const s = withQueue(shared(), [1, 2]);
    place(s, { red: [H - 1, H, H, H], yellow: [10, BASE, BASE, BASE] });
    const events = applyMove(s, 0, 0); // red's last token home with the 1
    expect(s.ranks).toEqual(['red']);
    expect(events.map((e) => e.type)).toEqual(['move', 'home', 'rank']);
    expect(currentColor(s)).toBe('red');
    expect(s.turn.phase).toBe('moving');
    expect(s.turn.queue).toEqual([2]);
    expect(s.turn.bonus).toBe(1);
    expect(legalMoves(s).map((m) => [m.color, m.tokenId])).toEqual([['yellow', 0]]);
    const end = applyMove(s, 0, 0, false, 'yellow');
    expect(s.tokens.yellow[0]).toBe(12);
    // The bonus roll is red's, even though red is home: it is used for the partner.
    expect(end.at(-1)).toEqual({ type: 'bonus', color: 'red' });
    expect(currentColor(s)).toBe('red');
  });

  it('moving the partner\'s last token home earns the mover a bonus roll, and the squares count as help', () => {
    const s = withQueue(shared(), [2]);
    place(s, { red: [5, BASE, BASE, BASE], yellow: [H, H, H, H - 2] });
    const events = applyMove(s, 0, 3, false, 'yellow');
    expect(s.ranks).toEqual(['yellow']);
    expect(s.finished).toBeFalsy();
    expect(events.some((e) => e.type === 'home' && e.color === 'yellow')).toBe(true);
    expect(statsOf(s, 'red').helped).toBe(2);
    expect(statsOf(s, 'red').homeRuns).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'bonus', color: 'red' });
    expect(currentColor(s)).toBe('red');
  });

  it('moving your own token home earns the bonus as usual, and your own last token too (you still roll for your partner)', () => {
    const s = withQueue(shared(), [1]);
    place(s, { red: [H - 1, H, H, H], yellow: [10, BASE, BASE, BASE] });
    const events = applyMove(s, 0, 0);
    expect(s.ranks).toEqual(['red']);
    expect(events.at(-1)).toEqual({ type: 'bonus', color: 'red' });
    expect(statsOf(s, 'red').cells).toBe(1);
    expect(statsOf(s, 'red').helped ?? 0).toBe(0);
  });

  it('without sharing, finishing ends the turn and drops the rest of the dice (as before)', () => {
    const s = withQueue(shared({ share: false }), [1, 2]);
    place(s, { red: [H - 1, H, H, H], yellow: [10, BASE, BASE, BASE] });
    applyMove(s, 0, 0);
    expect(s.turn.queue).toEqual([]);
    expect(currentColor(s)).toBe('green');
  });

  it('a finished player is not skipped: they roll, and every die is for their partner', () => {
    const s = shared();
    place(s, { red: [H, H, H, H], yellow: [10, BASE, BASE, BASE], green: [3, BASE, BASE, BASE] });
    s.ranks = ['red'];
    expect(takesTurns(s, 'red')).toBe(true);
    // Blue plays its last die: red, who is home, is next.
    Object.assign(s.turn, { seat: 3, phase: 'moving', queue: [1], bonus: 0 });
    s.tokens.blue = [3, BASE, BASE, BASE];
    const ev = applyMove(s, 0, 0);
    expect(ev.at(-1)).toMatchObject({ type: 'turn', color: 'red' });
    const rolled = applyRoll(s, 4);
    expect(rolled.map((e) => e.type)).toEqual(['roll']);
    expect(legalMoves(s).map((m) => [m.color, m.tokenId, m.to])).toEqual([['yellow', 0, 14]]);
    applyMove(s, 0, 0, false, 'yellow');
    expect(s.tokens.yellow[0]).toBe(14);
    // Without sharing the same finished player would have been skipped.
    const plain = shared({ share: false });
    plain.ranks = ['red'];
    expect(takesTurns(plain, 'red')).toBe(false);
    expect(takesTurns(shared(), 'green')).toBe(true);
  });

  it('a finished player with nothing to play for the partner loses the roll, like anyone with no moves', () => {
    const s = shared();
    place(s, { red: [H, H, H, H], yellow: [BASE, BASE, BASE, BASE] });
    s.ranks = ['red'];
    const ev = applyRoll(s, 3);
    expect(ev.map((e) => e.type)).toEqual(['roll', 'noMoves', 'turn']);
  });

  it('the team wins when its second player is home, whichever of them moved the last token', () => {
    const s = withQueue(shared(), [2]);
    place(s, { red: [H, H, H, H], yellow: [H, H, H, H - 2] });
    s.ranks = ['red'];
    // Red (done, but rolling for her partner) brings yellow's last token home.
    const end = applyMove(s, 0, 3, false, 'yellow');
    expect(s.finished).toBe(true);
    expect(s.ranks.slice(0, 2)).toEqual(['red', 'yellow']);
    expect(end.at(-1)).toMatchObject({ type: 'gameOver' });
    expect(winnersOf(s)).toEqual(['red', 'yellow']);
    // Credit for the home runs goes to red, who moved.
    expect(statsOf(s, 'red').homeRuns).toBe(1);
  });

  it('an awards pass over a shared game still works (stats belong to whoever moved)', () => {
    const s = withQueue(shared(), [2]);
    place(s, { red: [H, H, H, H], yellow: [H, H, H, H - 2] });
    s.ranks = ['red'];
    applyMove(s, 0, 3, false, 'yellow');
    expect(() => gameAwards(s)).not.toThrow();
  });
});

describe('turn sharing: bots', () => {
  it('a bot plays its partner\'s token when that is the better move', () => {
    const s = withQueue(shared(), [3]);
    // Red has one token a step from home; yellow's token can capture green's with the 3.
    place(s, { red: [H - 1, H, H, H], yellow: [20, BASE, BASE, BASE], green: [36, BASE, BASE, BASE] });
    s.turn.queue = [3];
    const best = chooseMove(s)!;
    expect(best.color).toBe('yellow');
    const applied = applyMove(s, best.dieIndex, best.tokenId, best.lap === true, best.color);
    expect(applied.some((e) => e.type === 'capture')).toBe(true);
  });

  it('four bots with turn sharing play whole games to the end, with the board kept consistent', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let n = seed;
      const dice = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff), (n >> 8) % 6) + 1;
      const s = shared({ first: seed % 4 });
      for (let step = 0; step < 6000 && !s.finished; step++) {
        if (s.turn.phase === 'rolling') applyRoll(s, dice());
        else {
          const m = chooseMove(s)!;
          applyMove(s, m.dieIndex, m.tokenId, m.lap === true, m.color);
        }
        for (const c of COLORS) expect(s.tokens[c]).toHaveLength(4);
      }
      expect(s.finished).toBe(true);
      const w = winnersOf(s);
      expect(w).toHaveLength(2);
      for (const c of w) expect(s.tokens[c].every((p) => p === H)).toBe(true);
    }
  });
});

describe('turn sharing over the network', () => {
  let t: TestServer;
  const clients: TestClient[] = [];
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await t?.close();
  });

  it('the host ticks it (clearing ready); it reaches the game only in Team-up; the partner\'s token is moved by naming its colour', async () => {
    t = await startTestServer();
    const alice = await client(t, 'alice');
    const bob = await client(t, 'bob');
    clients.push(alice, bob);
    const lobbyId = await createLobby(alice);
    await bob.emit('lobby:join', { lobbyId, password: 'pw' });
    await bob.emit('lobby:color', { color: 'yellow' });
    await bob.emit('lobby:ready', { ready: true });
    expect(await bob.emit('lobby:share', { share: true })).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(await alice.emit('lobby:share', { share: 'yes' })).toEqual({ ok: false, error: 'BAD_PAYLOAD' });
    expect(await alice.emit('lobby:share', { share: true })).toEqual({ ok: true });
    const lobby = () => t.server.ctx.lobbies.toPublic(t.server.ctx.lobbies.get(lobbyId)!) as PublicLobby;
    expect(lobby().share).toBe(true);
    expect(lobby().members.find((m) => m.userId === bob.userId)!.ready).toBe(false);
    expect(t.server.ctx.lobbies.summaries()[0].share).toBe(false); // classic mode: not shown
    await alice.emit('lobby:mode', { teams: true });
    expect(t.server.ctx.lobbies.summaries()[0].share).toBe(true);
    expect(await alice.emit('lobby:share', { share: true })).toEqual({ ok: true }); // unchanged

    await bob.emit('lobby:ready', { ready: true });
    await alice.emit('lobby:fillBots', {});
    const first = alice.nextState();
    expect(await alice.emit('lobby:start', {})).toEqual({ ok: true });
    const { state } = await first;
    expect(state.share).toBe(true);
    const g = t.server.ctx.games.get(state.id)!;
    g.tokens.red = [BASE, BASE, BASE, BASE];
    g.tokens.yellow = [20, BASE, BASE, BASE];
    Object.assign(g.turn, { seat: 0, phase: 'moving', queue: [3], bonus: 0 });
    const intent = (extra: object) => ({ gameId: g.id, version: g.version, actionId: crypto.randomUUID(), dieIndex: 0, tokenId: 0, ...extra });
    // Red has no token to move with a 3, and yellow's needs its colour named.
    expect((await alice.emit('game:move', intent({ color: 'green' }))).ok).toBe(false);
    expect((await alice.emit('game:move', intent({ color: 'purple' }))).ok).toBe(false);
    expect(await alice.emit('game:move', intent({ color: 'yellow' }))).toEqual({ ok: true });
    expect(g.tokens.yellow[0]).toBe(23);
    expect(g.tokens.red[0]).toBe(BASE);
  });

  it('a lobby without the box ticked plays plain Team-up', async () => {
    t = await startTestServer();
    const alice = await client(t, 'alice');
    clients.push(alice);
    const lobbyId = await createLobby(alice);
    await alice.emit('lobby:mode', { teams: true });
    await alice.emit('lobby:fillBots', {});
    const first = alice.nextState();
    expect(await alice.emit('lobby:start', {})).toEqual({ ok: true });
    expect((await first).state.share).toBeUndefined();
    void lobbyId;
  });
});
