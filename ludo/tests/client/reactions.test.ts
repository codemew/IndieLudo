import { describe, expect, it } from 'vitest';
import { COUNTED } from '../../src/shared/awards.js';
import { REACTIONS, pickReaction, type ReactionKind } from '../../src/client/reactions.js';

describe('token reactions', () => {
  it('has at least three reactions for each moment', () => {
    for (const kind of Object.keys(REACTIONS) as ReactionKind[]) expect(REACTIONS[kind].length).toBeGreaterThanOrEqual(3);
  });

  it('no face or animation is used twice, nor the three-sixes 😩 or an award icon', () => {
    const all = Object.values(REACTIONS).flat();
    expect(new Set(all.map((r) => r.face)).size).toBe(all.length);
    expect(new Set(all.map((r) => r.anim)).size).toBe(all.length);
    const elsewhere = ['😩', '🩸', ...COUNTED.map((a) => a.icon)];
    for (const r of all) expect(elsewhere).not.toContain(r.face);
  });

  it('never repeats the last reaction, and every one can come up', () => {
    for (const kind of Object.keys(REACTIONS) as ReactionKind[]) {
      const seen = new Set<string>();
      let last: string | undefined;
      for (let i = 0; i < 200; i++) {
        const r = pickReaction(kind, last);
        expect(r.anim).not.toBe(last);
        seen.add(r.anim);
        last = r.anim;
      }
      expect(seen.size).toBe(REACTIONS[kind].length);
    }
  });
});

describe('moustache drawing', () => {
  it('has nothing at 0 kills, a distinct shape for levels 1 to 4, and stops growing after that', async () => {
    const { moustacheSvg } = await import('../../src/client/moustache.js');
    expect(moustacheSvg(0)).toBe('');
    const shapes = [1, 2, 3, 4].map((l) => moustacheSvg(l));
    for (const svg of shapes) {
      expect(svg).toContain('class="tok-stache"');
      expect(svg.match(/class="mh"/g)).toHaveLength(2); // two halves that twitch and flap
    }
    expect(new Set(shapes).size).toBe(4);
    expect(moustacheSvg(7)).toBe(moustacheSvg(4));
  });
});
