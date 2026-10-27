import { go } from '../router.js';
import { play } from '../sound.js';
import { state, update } from '../store.js';
import { KEYS, storage } from '../storage.js';
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
  const rows = g.ranks
    .map((color, i) => {
      const seat = g.seats.find((s) => s.color === color)!;
      return `
        <li class="podium-row p-${color}" style="animation-delay:${200 + i * 140}ms">
          <span class="place">${PLACES[i]}</span>
          <span class="pchip-dot">${seat.controller === 'bot' ? '🤖' : esc(seat.username[0]?.toUpperCase() ?? '')}</span>
          <span class="podium-name">${esc(seat.username)}${color === myColor ? ' <em>you</em>' : ''}</span>
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
