import type { GameState, MatchPlayer, MatchSummary } from '../shared/types.js';
import { avatarFace } from '../shared/avatars.js';
import { api } from './api.js';
import { go } from './router.js';
import { awardIcon } from './screens/results.js';
import { state } from './store.js';
import { KEYS, storage } from './storage.js';
import { esc, toast } from './ui.js';

const PLACES = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** A match from the history opened on its own page (screens/match.ts). */
export let openedMatch: (GameState & { endedAt: number }) | null = null;

/** Fetches a whole match and opens its page. */
export async function openMatch(id: string): Promise<void> {
  try {
    const { match } = await api<{ match: GameState & { endedAt: number } }>('GET', `/history/${encodeURIComponent(id)}`);
    openedMatch = match;
    go('match');
  } catch {
    toast("Couldn't open that match.", 'error');
  }
}

/** "Today, 10:42", "Yesterday, 18:05", "Sat 7 Nov, 10:42" (with the year when it isn't this one). */
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`;
}

/** How long a match took: "4 min", "1 h 05 min". */
export function durationText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** The mode and rules of a match, as short tags. */
export function matchTags(m: {
  board: number;
  players: number;
  teams?: boolean;
  share?: boolean;
  powerUps?: boolean;
  golden?: boolean;
  botBattle?: boolean;
}): string[] {
  return [
    m.teams ? `🤝 Team-up${m.share ? ' · sharing' : ''}` : '🎲 Classic',
    `👥 ${m.players} players${m.board > 4 ? ` · ${m.board}-player board` : ''}`,
    ...(m.powerUps ? ['⚡ Power ups'] : []),
    ...(m.golden ? ['👑 Golden'] : []),
    ...(m.botBattle ? ['🤖 Bot battle'] : []),
  ];
}

function playerRow(p: MatchPlayer, me: number | undefined, teams: boolean): string {
  const mine = me !== undefined && p.userId === me;
  return `
    <li class="mp p-${p.color}${p.won ? ' won' : ''}${mine ? ' mine' : ''}">
      <span class="mp-place">${teams ? (p.won ? '1st' : '2nd') : PLACES[p.place - 1]}</span>
      <span class="pchip-dot${p.avatar && !p.bot ? ' has-avatar' : ''}" aria-hidden="true">${p.bot ? '🤖' : esc(avatarFace(p.avatar, p.username))}</span>
      <span class="mp-name"><span class="pn-text">${esc(p.username)}</span>${mine ? '<em>you</em>' : ''}${p.surrendered ? '<span title="Surrendered">🏳️</span>' : ''}${p.left ? '<span title="Left the game; a bot played on">🚪</span>' : ''}</span>
      <span class="mp-awards">${p.awards.map((a) => `<span title="${esc(a.title)}">${awardIcon({ key: a.key as never, icon: a.icon })}</span>`).join('')}</span>
      ${p.won ? '<span class="crown" title="Winner">👑</span>' : ''}
    </li>`;
}

export function matchCard(m: MatchSummary, me: number | undefined, now = Date.now()): string {
  const winners = m.players.filter((p) => p.won).map((p) => p.username);
  const iPlayed = me !== undefined && m.players.some((p) => p.userId === me);
  const iWon = iPlayed && m.players.some((p) => p.userId === me && p.won);
  const label = `${whenText(m.endedAt, now)}: ${winners.join(' and ')} won${iPlayed ? (iWon ? ', you won' : ', you played') : ''}. Open the match`;
  return `
    <li class="match-card${iWon ? ' i-won' : ''}" data-id="${esc(m.id)}">
      <button class="match-open" aria-label="${esc(label)}">
        <span class="match-head">
          <span class="match-when">${esc(whenText(m.endedAt, now))}</span>
          <span class="match-len">⏱ ${durationText(m.endedAt - m.startedAt)}</span>
        </span>
        <span class="match-tags">${matchTags({ ...m, players: m.players.length })
          .map((t) => `<span class="badge">${t}</span>`)
          .join('')}</span>
        <ol class="match-players">${m.players.map((p) => playerRow(p, me, Boolean(m.teams))).join('')}</ol>
      </button>
    </li>`;
}

type Scope = 'all' | 'mine';

/**
 * The History tab: every finished match (or only mine), newest first, 20 at a time with a button for
 * more. Each card shows when, how long, the mode and rules, and every player's place and awards;
 * tapping one opens it whole (dice luck and stats too).
 */
export class HistoryPanel {
  private scope: Scope = storage.get(KEYS.historyScope) === 'mine' ? 'mine' : 'all';
  private matches: MatchSummary[] = [];
  private more = false;
  private loading = false;
  /** Bumped on every fresh load, so a slow older answer doesn't land on top of a newer one. */
  private ticket = 0;

  constructor(private panel: HTMLElement) {
    panel.innerHTML = `
      <div class="section-title"><h3>Match history</h3></div>
      <div class="mode-switch history-scope" role="radiogroup" aria-label="Whose matches">
        <button class="mode-opt" data-scope="all" role="radio">Everyone</button>
        <button class="mode-opt" data-scope="mine" role="radio">Mine</button>
      </div>
      <ul class="match-list" id="match-list" aria-live="polite"></ul>
      <button class="btn btn-ghost" id="history-more" hidden>Show older matches</button>`;
    panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((b) => {
      b.onclick = () => {
        if (this.scope === b.dataset.scope) return;
        this.scope = b.dataset.scope as Scope;
        storage.set(KEYS.historyScope, this.scope);
        void this.load();
      };
    });
    panel.querySelector<HTMLButtonElement>('#history-more')!.onclick = () => void this.load(true);
    panel.querySelector('#match-list')!.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.match-card');
      if (card) void openMatch(card.dataset.id!);
    });
  }

  /** The newest page again (each time the tab is opened); `older`: the next page after what is shown. */
  async load(older = false): Promise<void> {
    if (older && (this.loading || !this.more)) return;
    const ticket = ++this.ticket;
    this.loading = true;
    if (!older) {
      this.matches = [];
      this.more = false;
    }
    this.paint();
    const before = older ? this.matches.at(-1)?.endedAt : undefined;
    try {
      const r = await api<{ matches: MatchSummary[]; more: boolean }>(
        'GET',
        `/history?${new URLSearchParams({ ...(this.scope === 'mine' && { mine: '1' }), ...(before !== undefined && { before: String(before) }) })}`,
      );
      if (ticket !== this.ticket) return;
      this.matches = older ? [...this.matches, ...r.matches] : r.matches;
      this.more = r.more;
    } catch {
      if (ticket !== this.ticket) return;
      toast("Couldn't load the match history.", 'error');
    }
    this.loading = false;
    this.paint();
  }

  private paint(): void {
    const me = state.user?.id;
    this.panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((b) => {
      const on = b.dataset.scope === this.scope;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    const list = this.panel.querySelector<HTMLElement>('#match-list')!;
    const now = Date.now();
    list.innerHTML = this.matches.length
      ? this.matches.map((m) => matchCard(m, me, now)).join('')
      : `<li class="empty"><p class="muted">${this.loading ? 'Loading…' : this.scope === 'mine' ? "You haven't finished a match yet." : 'No matches have been finished yet.'}</p></li>`;
    const moreBtn = this.panel.querySelector<HTMLButtonElement>('#history-more')!;
    moreBtn.hidden = !this.more;
    moreBtn.disabled = this.loading;
    moreBtn.textContent = this.loading && this.matches.length ? 'Loading…' : 'Show older matches';
  }
}
