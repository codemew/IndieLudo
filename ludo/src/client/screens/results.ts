import { go } from '../router.js';
import { play } from '../sound.js';
import { state, update } from '../store.js';
import { KEYS, storage } from '../storage.js';
import { gameAwards, playerStats, type Award } from '../../shared/awards.js';
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
      return `
        <li class="podium-row p-${color}${g.teams ? ' team-row' : ''}" style="animation-delay:${200 + i * 140}ms">
          <span class="place">${g.teams ? (winners.includes(color) ? '1st' : '2nd') : PLACES[i]}</span>
          <span class="pchip-dot">${seat.controller === 'bot' ? '🤖' : esc(seat.username[0]?.toUpperCase() ?? '')}</span>
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
      ${matchStats(g.ranks, awards, nameOf, (c) => playerStats(g, c))}
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
  return `
    <section class="match-stats">
      ${awards.length ? `<h3>Awards</h3><ul class="awards">${awardRows}</ul>` : ''}
      <h3>Match stats</h3>
      <table class="stats-table">
        <thead><tr><th></th>${STAT_COLUMNS.map((col) => `<th scope="col" title="${col.label}">${col.icon}<small>${col.label}</small></th>`).join('')}</tr></thead>
        <tbody>${statRows}</tbody>
      </table>
    </section>`;
}
