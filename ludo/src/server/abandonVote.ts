import { AppError } from './errors.js';
import type { AbandonVote, AbandonVoteEnd } from '../shared/types.js';

/** How long the players have to answer a vote to abandon a game. */
export const ABANDON_VOTE_MS = 45_000;

export interface AbandonVoteOptions {
  /** The vote changed (someone answered), or started: send it to the game. */
  onChange: (vote: AbandonVote) => void;
  /** The vote is over: passed, refused (with who said no), expired, or cancelled (the game ended, or the vote lost its voters). */
  onEnd: (gameId: string, end: AbandonVoteEnd) => void;
  /** Everyone said yes: abandon the game. */
  onPass: (gameId: string) => void;
  durationMs?: number;
  now?: () => number;
}

interface Running {
  vote: AbandonVote;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Votes to abandon a game: the host asks, every player in the game (people only: bots don't vote)
 * answers. Everyone yes and the game is abandoned (no winner, no match history); one no, or time
 * running out, and it goes on. One vote per game at a time.
 */
export class AbandonVotes {
  private votes = new Map<string, Running>();
  private readonly now: () => number;

  constructor(private opts: AbandonVoteOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(gameId: string): AbandonVote | undefined {
    return this.votes.get(gameId)?.vote;
  }

  /** The host starts one; their own answer is yes if they play. With no other voter it passes at once. */
  start(gameId: string, host: { userId: number; username: string }, voters: { userId: number; username: string }[]): AbandonVote {
    if (this.votes.has(gameId)) throw new AppError('VOTE_RUNNING');
    const ms = this.opts.durationMs ?? ABANDON_VOTE_MS;
    const vote: AbandonVote = {
      gameId,
      startedBy: host.userId,
      startedByName: host.username,
      endsAt: this.now() + ms,
      voters: voters.map((v) => ({ ...v, vote: v.userId === host.userId ? true : null })),
    };
    const timer = setTimeout(() => this.end(gameId, { how: 'expired' }), ms);
    timer.unref?.();
    this.votes.set(gameId, { vote, timer });
    this.settle(gameId);
    return vote;
  }

  answer(gameId: string, userId: number, yes: boolean): void {
    const running = this.votes.get(gameId);
    if (!running) throw new AppError('NO_VOTE');
    const voter = running.vote.voters.find((v) => v.userId === userId);
    if (!voter) throw new AppError('NOT_A_VOTER', 403);
    if (voter.vote !== null) throw new AppError('ALREADY_VOTED');
    voter.vote = yes;
    if (!yes) return this.end(gameId, { how: 'refused', by: voter.username });
    this.settle(gameId);
  }

  /** A player left the game for good (a bot plays on): they no longer vote. */
  dropVoter(gameId: string, userId: number): void {
    const running = this.votes.get(gameId);
    if (!running || !running.vote.voters.some((v) => v.userId === userId)) return;
    running.vote.voters = running.vote.voters.filter((v) => v.userId !== userId);
    this.settle(gameId);
  }

  /** The game ended some other way (won, closed): the vote goes with it. */
  cancel(gameId: string): void {
    if (this.votes.has(gameId)) this.end(gameId, { how: 'cancelled' });
  }

  shutdown(): void {
    for (const r of this.votes.values()) clearTimeout(r.timer);
    this.votes.clear();
  }

  /** Passes once everyone has said yes; otherwise tells everyone where it stands. */
  private settle(gameId: string): void {
    const running = this.votes.get(gameId)!;
    if (running.vote.voters.every((v) => v.vote === true)) {
      this.end(gameId, { how: 'passed' });
      this.opts.onPass(gameId);
      return;
    }
    this.opts.onChange(running.vote);
  }

  private end(gameId: string, end: AbandonVoteEnd): void {
    const running = this.votes.get(gameId);
    if (!running) return;
    clearTimeout(running.timer);
    this.votes.delete(gameId);
    this.opts.onEnd(gameId, end);
  }
}
