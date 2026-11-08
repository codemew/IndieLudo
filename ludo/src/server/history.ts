import { gameAwards } from '../shared/awards.js';
import { winnersOf } from '../shared/rules.js';
import type { GameState, MatchSummary } from '../shared/types.js';
import type { DB } from './db.js';

/** How many matches one page of the history holds, at most. */
export const HISTORY_PAGE = 20;

/**
 * The match history: every finished game kept in the database, newest first, with each player's
 * place and awards. A game that was dropped because its lobby closed is left out: only a game that
 * ended ranks every seat.
 */
export class MatchHistory {
  constructor(private db: DB) {}

  /**
   * One page of matches that ended before `before` (ms; omitted for the newest). `userId`: only
   * that player's matches (also the ones they left before the end).
   */
  list(opts: { before?: number; limit?: number; userId?: number } = {}): { matches: MatchSummary[]; more: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? HISTORY_PAGE, 50));
    const mine = opts.userId !== undefined;
    const rows = this.db
      .prepare(
        `SELECT state_json, updated_at FROM games
         WHERE finished = 1 AND updated_at < ? AND json_array_length(state_json, '$.ranks') = json_array_length(state_json, '$.seats')
         ${mine ? `AND EXISTS (SELECT 1 FROM json_each(state_json, '$.seats') WHERE json_extract(value, '$.userId') = ? OR json_extract(value, '$.leftBy') = ?)` : ''}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...[opts.before ?? Number.MAX_SAFE_INTEGER, ...(mine ? [opts.userId!, opts.userId!] : []), limit + 1]) as {
      state_json: string;
      updated_at: number;
    }[];
    return { matches: rows.slice(0, limit).map((r) => summarize(JSON.parse(r.state_json) as GameState, r.updated_at)), more: rows.length > limit };
  }

  /** A whole finished match, for its page (podium, awards, stats, dice luck); undefined if there is none. */
  get(id: string): (GameState & { endedAt: number }) | undefined {
    const row = this.db.prepare('SELECT state_json, updated_at FROM games WHERE id = ? AND finished = 1').get(id) as
      { state_json: string; updated_at: number } | undefined;
    if (!row) return undefined;
    const state = JSON.parse(row.state_json) as GameState;
    if (state.ranks.length !== state.seats.length) return undefined;
    // The power-up shuffle seed is the server's own, even after the game.
    delete state.orbSeed;
    return { ...state, endedAt: row.updated_at };
  }
}

export function summarize(state: GameState, endedAt: number): MatchSummary {
  const winners = winnersOf(state);
  const awards = gameAwards(state);
  return {
    id: state.id,
    startedAt: state.createdAt,
    endedAt,
    board: state.board ?? 4,
    ...(state.teams && { teams: true as const }),
    ...(state.share && { share: true as const }),
    ...(state.powerUps && { powerUps: true as const }),
    ...(state.golden && { golden: true as const }),
    ...(state.botBattle && { botBattle: true as const }),
    players: state.ranks.map((color, i) => {
      const seat = state.seats.find((s) => s.color === color)!;
      const left = seat.leftBy !== undefined;
      return {
        color,
        username: seat.username,
        ...(seat.avatar && { avatar: seat.avatar }),
        bot: seat.controller === 'bot' && !left,
        userId: seat.userId ?? seat.leftBy ?? null,
        place: state.teams ? (winners.includes(color) ? 1 : 2) : i + 1,
        won: winners.includes(color),
        ...(state.surrendered?.includes(color) && { surrendered: true as const }),
        ...(left && { left: true as const }),
        awards: awards.filter((a) => a.colors.includes(color)).map((a) => ({ key: a.key, icon: a.icon, title: a.title })),
      };
    }),
  };
}
