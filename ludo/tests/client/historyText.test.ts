// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { durationText, matchCard, matchTags, whenText } from '../../src/client/history.js';
import type { MatchSummary } from '../../src/shared/types.js';

describe('the match history list', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();

  it('says when a match ended and how long it took, as people say it', () => {
    expect(whenText(new Date(2026, 10, 8, 9, 5).getTime(), now)).toMatch(/^Today, /);
    expect(whenText(new Date(2026, 10, 7, 23, 50).getTime(), now)).toMatch(/^Yesterday, /);
    expect(whenText(new Date(2026, 10, 2, 8, 0).getTime(), now)).not.toMatch(/2026/);
    expect(whenText(new Date(2025, 11, 30, 8, 0).getTime(), now)).toMatch(/2025/);
    expect([durationText(20_000), durationText(4 * 60_000), durationText(65 * 60_000)]).toEqual(['1 min', '4 min', '1 h 05 min']);
  });

  it('tags the mode and rules, and marks my place, the winners and the awards on a card', () => {
    expect(matchTags({ board: 6, players: 5, teams: false, powerUps: true, golden: true, botBattle: true })).toEqual([
      '🎲 Classic',
      '👥 5 players · 6-player board',
      '⚡ Power ups',
      '👑 Golden',
      '🤖 Bot battle',
    ]);
    const m: MatchSummary = {
      id: 'm1',
      startedAt: now - 30 * 60_000,
      endedAt: now - 10 * 60_000,
      board: 4,
      players: [
        {
          color: 'green',
          username: 'bob <b>',
          userId: 2,
          bot: false,
          place: 1,
          won: true,
          awards: [{ key: 'captures', icon: '⚔️', title: 'Most tokens captured' }],
        },
        {
          color: 'red',
          username: 'alice',
          userId: 1,
          bot: false,
          place: 2,
          won: false,
          left: true,
          awards: [{ key: 'risks', icon: '🔘', title: 'Balls of steel' }],
        },
        { color: 'yellow', username: 'Bot Yellow', userId: null, bot: true, place: 3, won: false, surrendered: true, awards: [] },
      ],
    };
    document.body.innerHTML = `<ul>${matchCard(m, 1, now)}</ul>`;
    const rows = [...document.querySelectorAll('.mp')];
    expect(rows.map((r) => r.querySelector('.mp-place')!.textContent)).toEqual(['1st', '2nd', '3rd']);
    expect(rows[0].classList.contains('won')).toBe(true);
    expect(rows[0].querySelector('.pn-text')!.textContent).toBe('bob <b>'); // escaped, not markup
    expect(rows[1].classList.contains('mine')).toBe(true);
    expect(rows[1].querySelector('[title^="Left"]')).not.toBeNull();
    expect(rows[1].querySelector('.steel-ball')).not.toBeNull();
    expect(rows[2].querySelector('.pchip-dot')!.textContent).toBe('🤖');
    expect(document.querySelector('.match-open')!.getAttribute('aria-label')).toMatch(/bob <b> won, you played\. Open the match$/);
    expect(document.querySelector('.match-len')!.textContent).toContain('20 min');
  });
});
