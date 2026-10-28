import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingText, signalBars } from '../../src/client/netUi.js';
import { state } from '../../src/client/store.js';

describe('signal bars and ping beside each player', () => {
  afterEach(() => {
    state.net = null;
  });
  const net = (players: { userId: number; pingMs: number | null; bars: 0 | 1 | 2 | 3 | 4 }[]) => (state.net = { lobbyId: 'l1', players } as typeof state.net);

  it('show the measured ping and the matching strength', () => {
    net([{ userId: 1, pingMs: 42, bars: 4 }]);
    expect(pingText(1)).toBe('<span class="ping sig-4">42ms</span>');
    const bars = signalBars(1);
    expect(bars).toContain('class="sig sig-4"');
    expect(bars).toContain('aria-label="excellent signal, 42 ms"');
    expect(bars.match(/<i><\/i>/g)).toHaveLength(4);
  });

  it('a player with no reply yet shows a dash and no signal', () => {
    net([{ userId: 2, pingMs: null, bars: 0 }]);
    expect(pingText(2)).toBe('<span class="ping sig-0">—</span>');
    expect(signalBars(2)).toContain('aria-label="no signal"');
  });

  it('nothing for bots, unknown players, or before the first measurement', () => {
    expect(signalBars(1)).toBe('');
    net([{ userId: 1, pingMs: 10, bars: 4 }]);
    expect(signalBars(null)).toBe('');
    expect(pingText(null)).toBe('');
    expect(pingText(99)).toBe('');
  });
});

describe('updateAvailable', () => {
  afterEach(() => {
    state.serverVersion = null;
    vi.unstubAllGlobals();
  });

  it('only when the server says it runs a different build than this page', async () => {
    vi.stubGlobal('__APP_VERSION__', '2.2.0');
    const { updateAvailable } = await import('../../src/client/update.js');
    expect(updateAvailable()).toBe(false); // not heard from the server yet: "Checking…"
    state.serverVersion = '2.2.0';
    expect(updateAvailable()).toBe(false); // "✓ Up to date", button disabled
    state.serverVersion = '2.3.0';
    expect(updateAvailable()).toBe(true); // "⟳ Update now"
  });
});
