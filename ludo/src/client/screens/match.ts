import { winnersOf } from '../../shared/rules.js';
import { durationText, matchTags, openedMatch, whenText } from '../history.js';
import { go } from '../router.js';
import { state } from '../store.js';
import { KEYS, storage } from '../storage.js';
import { $, esc } from '../ui.js';
import { bindStatTabs, matchSummary, myColorIn } from './results.js';

/**
 * One match from the match history, whole: when and how long, the mode and rules, the podium with
 * everyone's place and awards, the awards, and the match stats and dice luck.
 */
export function matchScreen(root: HTMLElement): void {
  const g = openedMatch;
  if (!g) {
    queueMicrotask(() => go('home'));
    return;
  }
  const myColor = myColorIn(g, state.user?.id);
  const winners = winnersOf(g);
  const names = winners.map((c) => esc(g.seats.find((s) => s.color === c)?.username ?? 'Someone'));
  const iWon = Boolean(myColor && winners.includes(myColor));
  const heading = iWon ? (g.teams ? 'Your team won' : 'You won') : `${names.join(' & ')} won`;
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Back to the match history">‹</button>
      <div class="topbar-title">
        <div class="eyebrow">Match history</div>
        <div class="lobby-name">${esc(whenText(g.endedAt))}</div>
      </div>
      <span class="topbar-spacer"></span>
    </header>
    <div class="results match-page">
      <div class="big-emoji">${iWon ? '🏆' : g.botBattle ? '🤖' : '🎲'}</div>
      <h2>${heading}</h2>
      <p class="match-tags center">${[...matchTags({ board: g.board ?? 4, players: g.seats.length, teams: g.teams, share: g.share, powerUps: g.powerUps, golden: Boolean(g.golden), botBattle: g.botBattle }), `⏱ ${durationText(g.endedAt - g.createdAt)}`].map((t) => `<span class="badge">${t}</span>`).join('')}</p>
      ${matchSummary(g, myColor)}
    </div>`;
  $(root, '#back').onclick = () => {
    storage.set(KEYS.homeTab, 'history');
    go('home');
  };
  bindStatTabs(root);
}
