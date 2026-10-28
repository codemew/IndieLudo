import { go } from '../router.js';
import { play } from '../sound.js';
import { state, update } from '../store.js';
import { KEYS, storage } from '../storage.js';
import { gameAwards, playerStats, type Award } from '../../shared/awards.js';
import type { Color } from '../../shared/types.js';
import { $, esc } from '../ui.js';

const PLACES = ['1st', '2nd', '3rd', '4th'];

export function resultsScreen(root: HTMLElement): void {
  const g = state.game;
  if (!g) {
    queueMicrotask(() => go('home'));
    return;
  }
  const myColor = g.seats.find((s) => s.userId === state.user?.id)?.color;
  const iWon = g.ranks[0] === myColor;
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
        <li class="podium-row p-${color}" style="animation-delay:${200 + i * 140}ms">
          <span class="place">${PLACES[i]}</span>
          <span class="pchip-dot">${seat.controller === 'bot' ? '🤖' : esc(seat.username[0]?.toUpperCase() ?? '')}</span>
          <span class="podium-name">${esc(seat.username)}${color === myColor ? ' <em>you</em>' : ''}</span>
          <span class="podium-awards">${awardsOf(color).map((a) => `<span title="${a.title}">${a.icon}</span>`).join('')}</span>
          ${i === 0 ? '<span class="crown">👑</span>' : ''}
        </li>`;
    })
    .join('');
  const winner = g.seats.find((s) => s.color === g.ranks[0]);
  root.innerHTML = `
    <div class="results">
      ${iWon ? `<div class="confetti">${Array.from({ length: 28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>` : ''}
      <div class="big-emoji">${iWon ? '🏆' : '🎲'}</div>
      <h2>${iWon ? 'You won!' : `${esc(winner?.username ?? 'Someone')} wins`}</h2>
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

const STAT_COLUMNS = [
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
        <span class="aw-icon">${a.icon}</span>
        <span class="aw-text"><b>${a.title}</b>${a.key === 'machoHome' ? '<small class="aw-sub">moustached tokens brought home</small>' : ''}<span>${a.colors.map((c) => `<span class="aw-who n-${c}">${nameOf(c)}</span>`).join(' ')}</span></span>
        ${a.key === 'firstBlood' ? '' : `<span class="aw-val">${a.value}</span>`}
      </li>`,
    )
    .join('');
  const best = Object.fromEntries(STAT_COLUMNS.map((col) => [col.key, Math.max(...order.map((c) => statsOf(c)[col.key] ?? 0))]));
  const statRows = order
    .map(
      (c) => `
      <tr class="p-${c}">
        <th scope="row"><span class="st-dot"></span>${nameOf(c)}${statsOf(c).firstBlood ? ' <span title="First blood">🩸</span>' : ''}</th>
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
