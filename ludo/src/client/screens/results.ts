import { go } from '../router.js';
import { play } from '../sound.js';
import { state, update } from '../store.js';
import { KEYS, storage } from '../storage.js';
import { gameAwards, playerStats, type Award } from '../../shared/awards.js';
import { avatarFace } from '../../shared/avatars.js';
import { rollCounts, rollShares } from '../../shared/rolls.js';
import { winnersOf } from '../../shared/rules.js';
import type { Color } from '../../shared/types.js';
import { $, esc } from '../ui.js';

const PLACES = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

export function resultsScreen(root: HTMLElement): void {
  const g = state.game;
  if (!g) {
    queueMicrotask(() => go('home'));
    return;
  }
  const myColor = g.seats.find((s) => s.userId === state.user?.id)?.color;
  const winners = winnersOf(g);
  const iWon = Boolean(myColor && winners.includes(myColor));
  const awards = gameAwards(g);
  const awardsOf = (c: Color) => awards.filter((a) => a.colors.includes(c));
  const nameOf = (c: Color) => {
    const seat = g.seats.find((s) => s.color === c)!;
    return `${esc(seat.username)}${c === myColor ? ' <em>you</em>' : ''}`;
  };
  const rows = g.ranks
    .map((color, i) => {
      const seat = g.seats.find((s) => s.color === color)!;
      // Only a seat that was a bot all along gets the 🤖: one a bot took over for a player who left
      // (the game chips show 🤖 while it plays) is shown as that player here, who finished where.
      return `
        <li class="podium-row p-${color}${g.teams ? ' team-row' : ''}" style="animation-delay:${200 + i * 140}ms">
          <span class="place">${g.teams ? (winners.includes(color) ? '1st' : '2nd') : PLACES[i]}</span>
          <span class="pchip-dot${seat.avatar && seat.controller !== 'bot' ? ' has-avatar' : ''}">${seat.controller === 'bot' ? '🤖' : esc(avatarFace(seat.avatar, seat.username))}</span>
          <span class="podium-who">
            <span class="podium-name"><span class="pn-text">${esc(seat.username)}</span>${color === myColor ? '<em>you</em>' : ''}${g.surrendered?.includes(color) ? '<span title="Surrendered">🏳️</span>' : ''}</span>
            ${awardsOf(color).length ? `<span class="podium-awards">${awardsOf(color).map((a) => `<span title="${a.title}">${awardIcon(a)}</span>`).join('')}</span>` : ''}
          </span>
          ${winners.includes(color) ? '<span class="crown">👑</span>' : ''}
        </li>`;
    })
    .join('');
  const names = winners.map((c) => esc(g.seats.find((s) => s.color === c)?.username ?? 'Someone'));
  const heading = g.teams ? (iWon ? 'Your team won!' : `${names.join(' & ')} win!`) : iWon ? 'You won!' : `${names[0] ?? 'Someone'} wins${g.botBattle ? ' the bot battle' : ''}`;
  root.innerHTML = `
    <div class="results">
      ${iWon ? `<div class="confetti">${Array.from({ length: 28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>` : ''}
      <div class="big-emoji">${iWon ? '🏆' : g.botBattle ? '🤖' : '🎲'}</div>
      <h2>${heading}</h2>
      <ol class="podium">${rows}</ol>
      ${matchStats(g.ranks, awards, nameOf, (c) => playerStats(g, c), (c) => rollCounts(g, c))}
      <div class="results-actions">
        ${state.lobby ? '<button class="btn btn-primary btn-xl" id="lobby">Back to lobby</button>' : ''}
        <button class="btn btn-ghost btn-xl" id="home">Home</button>
      </div>
    </div>`;
  if (iWon) play('win');
  const leave = (to: 'lobby' | 'home') => {
    storage.remove(KEYS.lastGame);
    update({ game: null });
    go(to);
  };
  root.querySelector<HTMLButtonElement>('#lobby')?.addEventListener('click', () => leave('lobby'));
  $(root, '#home').onclick = () => leave('home');
  bindStatTabs(root);
}

/** The tabs under the awards: a radio-like group (one Tab stop, arrow keys, Home/End) that shows one panel. */
function bindStatTabs(root: HTMLElement): void {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.stat-tab')];
  if (!tabs.length) return;
  const show = (tab: HTMLButtonElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(`#${t.getAttribute('aria-controls')}`);
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((t) => (t.onclick = () => show(t)));
  root.querySelector('.stat-tabs')?.addEventListener('keydown', (e) => {
    const at = tabs.findIndex((t) => t === document.activeElement);
    const key = (e as KeyboardEvent).key;
    const to: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 };
    if (at < 0 || !(key in to)) return;
    e.preventDefault();
    show(tabs[(to[key] + tabs.length) % tabs.length], true);
  });
}

/** A line under an award's title for the ones whose name doesn't say what counts. */
const AWARD_SUB: Partial<Record<Award['key'], string>> = {
  machoHome: 'moustached tokens brought home',
  babyFace: 'fewest moustaches grown · smooth as a baby',
  risks: 'extra laps + wildcard entries: the biggest risks taken',
  friendlyFire: 'teammates captured',
};

/** An award's icon. "Balls of steel" is a drawn steel ball: there is no emoji for one. */
export function awardIcon(a: Pick<Award, 'key' | 'icon'>): string {
  return a.key === 'risks' ? '<span class="steel-ball" role="img" aria-label="steel ball"></span>' : a.icon;
}

const STAT_COLUMNS = [
  // Every arrival home: a token back from a wildcard entry that made it home again counts twice.
  { key: 'homeRuns', icon: '🏠', label: 'Home' },
  { key: 'cells', icon: '👣', label: 'Cells' },
  { key: 'captures', icon: '⚔️', label: 'Captures' },
  { key: 'sixes', icon: '🎲', label: 'Sixes' },
  { key: 'revenges', icon: '😤', label: 'Revenges' },
  { key: 'machoHome', icon: '🥸', label: 'Macho' },
] as const;

/** Awards (best in each stat, first blood) and everyone's numbers, best of each column highlighted. */
function matchStats(
  order: Color[],
  awards: Award[],
  nameOf: (c: Color) => string,
  statsOf: (c: Color) => ReturnType<typeof playerStats>,
  rollsOf: (c: Color) => number[],
): string {
  const awardRows = awards
    .map(
      (a, i) => `
      <li class="award" style="animation-delay:${600 + i * 110}ms">
        <span class="aw-icon">${awardIcon(a)}</span>
        <span class="aw-text"><b>${a.title}</b>${AWARD_SUB[a.key] ? `<small class="aw-sub">${AWARD_SUB[a.key]}</small>` : ''}<span>${a.colors.map((c) => `<span class="aw-who n-${c}">${nameOf(c)}</span>`).join(' ')}</span></span>
        ${a.key === 'firstBlood' ? '' : `<span class="aw-val">${a.value}</span>`}
      </li>`,
    )
    .join('');
  const best = Object.fromEntries(STAT_COLUMNS.map((col) => [col.key, Math.max(...order.map((c) => statsOf(c)[col.key] ?? 0))]));
  const statRows = order
    .map(
      (c) => `
      <tr class="p-${c}">
        <th scope="row"><span class="st-dot"></span><span class="st-name">${nameOf(c)}</span>${statsOf(c).firstBlood ? ' <span title="First blood">🩸</span>' : ''}</th>
        ${STAT_COLUMNS.map((col) => {
          const v = statsOf(c)[col.key] ?? 0;
          return `<td class="${v > 0 && v === best[col.key] ? 'best' : ''}">${v}</td>`;
        }).join('')}
      </tr>`,
    )
    .join('');
  const statsTable = `
      <table class="stats-table">
        <thead><tr><th></th>${STAT_COLUMNS.map((col) => `<th scope="col" title="${col.label}">${col.icon}<small>${col.label}</small></th>`).join('')}</tr></thead>
        <tbody>${statRows}</tbody>
      </table>`;
  // Dice luck: how each player's rolls split over 1s…6s. Hidden for a game saved before rolls were counted.
  const counts = order.map((c) => rollsOf(c));
  const anyRolls = counts.some((n) => n.some((x) => x > 0));
  const oddsRows = order
    .map((c, i) => {
      const shares = rollShares(counts[i]);
      const total = counts[i].reduce((a, b) => a + b, 0);
      const top = Math.max(...shares);
      return `
      <tr class="p-${c}">
        <th scope="row"><span class="st-dot"></span><span class="st-name">${nameOf(c)}</span><small class="rolls-n">${total} roll${total === 1 ? '' : 's'}</small></th>
        ${shares.map((p, f) => `<td class="odds${total && p === top ? ' best' : ''}" style="--p:${p}" title="${counts[i][f]} of ${total} rolls"><span>${total ? `${p}%` : '–'}</span></td>`).join('')}
      </tr>`;
    })
    .join('');
  const oddsTable = `
      <table class="stats-table odds-table">
        <thead><tr><th></th>${[1, 2, 3, 4, 5, 6].map((f) => `<th scope="col">${f}s</th>`).join('')}</tr></thead>
        <tbody>${oddsRows}</tbody>
      </table>
      <p class="odds-note">How each player's rolls split over the numbers. A fair die gives about 17% each; the biggest share in a row is highlighted.</p>`;
  return `
    <section class="match-stats">
      ${awards.length ? `<h3>Awards</h3><ul class="awards">${awardRows}</ul>` : ''}
      ${
        anyRolls
          ? `<div class="stat-tabs" role="tablist" aria-label="Match numbers">
        <button class="stat-tab" role="tab" id="tab-stats" aria-selected="true" aria-controls="panel-stats">Match stats</button>
        <button class="stat-tab" role="tab" id="tab-odds" aria-selected="false" aria-controls="panel-odds" tabindex="-1">Dice luck</button>
      </div>
      <div role="tabpanel" id="panel-stats" aria-labelledby="tab-stats">${statsTable}</div>
      <div role="tabpanel" id="panel-odds" aria-labelledby="tab-odds" hidden>${oddsTable}</div>`
          : `<h3>Match stats</h3>${statsTable}`
      }
    </section>`;
}
