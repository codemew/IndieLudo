// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkReport, VoiceReport } from '../../../src/client/voice.js';
import { click, flush, modalButton, setupDom, toasts } from './harness.js';

vi.mock('../../../src/client/net.js', () => import('./fakeNet.js'));
const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    joined: true,
    joining: false,
    enabled: true,
    micAvailable: true,
    muted: false,
    error: null as string | null,
    bitrateKbps: 6,
    linked: { connected: 1, total: 1 },
    sfuCount: 1,
    relayedCount: 0,
    get silent() {
      return this.muted || !this.micAvailable;
    },
    report: vi.fn(async (): Promise<any> => null),
    join: vi.fn(async (): Promise<string | null> => 'NOT_IN_VOICE'),
    rejoin: vi.fn(async (): Promise<string | null> => null),
    reboot: vi.fn(async (): Promise<string | null> => null),
    setEnabled: vi.fn(async (): Promise<string | null> => null),
    setBitrate: vi.fn(async (): Promise<string | null> => null),
    setMuted: vi.fn(async (m: boolean) => void (fake.muted = m)),
    retryMic: vi.fn(async () => false),
    peerStatus: vi.fn(() => 'connecting'),
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    changed() {
      for (const fn of listeners) fn();
    },
  };
});
vi.mock('../../../src/client/voice.js', () => ({ voice: fake }));

let ui: typeof import('../../../src/client/voiceUi.js');
let store: typeof import('../../../src/client/store.js');
beforeAll(async () => {
  setupDom();
  store = await import('../../../src/client/store.js');
  ui = await import('../../../src/client/voiceUi.js');
});
beforeEach(() => {
  document.getElementById('toasts')!.innerHTML = '';
  Object.assign(fake, { joined: true, joining: false, enabled: true, micAvailable: true, muted: false, error: null, linked: { connected: 1, total: 1 }, sfuCount: 1, relayedCount: 0 });
  store.update({
    user: { id: 1, username: 'alice' },
    lobby: { id: 'L', name: 'Fam', hostId: 1, status: 'waiting', members: [{ color: 'red', userId: 1, username: 'alice', isBot: false, ready: true, connected: true }, { color: 'green', userId: 2, username: 'bob', isBot: false, ready: true, connected: true }], spectators: [{ userId: 3, username: 'zed', connected: true }], gameId: null, teams: false },
    voice: { lobbyId: 'L', enabled: true, epoch: 0, bitrateKbps: 12, participants: [{ userId: 1, muted: false }, { userId: 2, muted: true }] },
  });
});

const mount = () => {
  const p = ui.voicePanel();
  document.body.appendChild(p.el);
  return p;
};
const status = (p: { el: HTMLElement }) => p.el.querySelector('.voice-status')!.textContent;

describe('the mute button', () => {
  it('follows the voice state and acts on a tap', async () => {
    const b = document.createElement('button');
    const off = ui.bindMuteButton(b);
    expect(b.getAttribute('aria-label')).toBe('Mute myself');
    b.click();
    await flush();
    expect(fake.setMuted).toHaveBeenCalledWith(true);
    fake.changed();
    expect(b.getAttribute('aria-label')).toBe('Unmute myself');
    fake.micAvailable = false;
    fake.changed();
    expect(b.getAttribute('aria-label')).toBe('Microphone blocked, tap to allow it');
    b.click();
    await flush();
    expect(toasts().at(-1)).toContain('Microphone access is blocked');
    fake.joined = false;
    fake.changed();
    expect(b.getAttribute('aria-label')).toBe('Voice chat not connected, tap to retry');
    b.click();
    await flush();
    expect(fake.join).toHaveBeenCalledWith('L', 1);
    fake.joining = true;
    fake.changed();
    expect(b.getAttribute('aria-label')).toBe('Connecting voice chat');
    fake.enabled = false;
    fake.joining = false;
    fake.changed();
    expect(b.getAttribute('aria-label')).toBe('The host turned voice chat off');
    b.click();
    expect(toasts().at(-1)).toBe('The host turned voice chat off.');
    off();
  });

  it('badges: muted or talking, connecting while the link comes up', () => {
    expect(ui.voiceBadge(null)).toBe('');
    expect(ui.voiceBadge(9)).toBe('');
    expect(ui.voiceBadge(1)).toContain('vc-on');
    expect(ui.voiceBadge(2)).toContain('vc-muted vc-connecting');
  });
});

describe('the voice panel', () => {
  it('status lines for each state', () => {
    const p = mount();
    expect(status(p)).toBe('Talking with 1 player (all via the voice server).');
    Object.assign(fake, { linked: { connected: 1, total: 3 }, sfuCount: 1, relayedCount: 1 });
    fake.changed();
    expect(status(p)).toBe('Connected to 1 of 3 (1 via the voice server, 1 through the game server)… fixing the rest.');
    Object.assign(fake, { linked: { connected: 2, total: 2 }, sfuCount: 0, relayedCount: 0 });
    fake.changed();
    expect(status(p)).toBe('Talking with both players.');
    Object.assign(fake, { linked: { connected: 0, total: 0 } });
    fake.changed();
    expect(status(p)).toBe('In voice chat. Nobody else is here yet.');
    Object.assign(fake, { joined: false, error: 'MIC_DENIED' });
    fake.changed();
    expect(status(p)).toContain('Not in voice chat: Microphone access is blocked');
    Object.assign(fake, { joining: true });
    fake.changed();
    expect(status(p)).toBe('Connecting to voice chat…');
    Object.assign(fake, { enabled: false });
    fake.changed();
    expect(status(p)).toBe('Voice chat is off for everyone.');
    p.el.remove();
    fake.changed(); // a panel no longer on the page unhooks itself
  });

  it('host controls: rejoin, restart (asked first), turn off and on, quality', async () => {
    const p = mount();
    const btn = (label: string) => [...p.el.querySelectorAll<HTMLButtonElement>('.voice-actions .btn')].find((b) => b.textContent!.includes(label))!;
    btn('Rejoin voice').click();
    await flush();
    expect(toasts()).toContain('Rejoined voice chat');
    fake.rejoin.mockResolvedValueOnce('VOICE_DISABLED');
    btn('Rejoin voice').click();
    await flush();
    expect(toasts().at(-1)).toBe('The host turned voice chat off.');
    btn('Restart for everyone').click();
    await flush(10);
    modalButton('Restart');
    await flush(10);
    expect(fake.reboot).toHaveBeenCalledWith('L');
    btn('Turn off').click();
    await flush();
    expect(fake.setEnabled).toHaveBeenCalledWith('L', false);
    fake.enabled = false;
    fake.changed();
    btn('Turn on').click();
    await flush();
    expect(fake.setEnabled).toHaveBeenLastCalledWith('L', true);
    fake.enabled = true;
    fake.changed();
    expect(p.el.querySelector('.segmented button.on')!.getAttribute('data-kbps')).toBe('12');
    click('.segmented button[data-kbps="24"]', p.el);
    await flush();
    expect(fake.setBitrate).toHaveBeenCalledWith('L', 24);
    expect(toasts().at(-1)).toBe('Voice quality: 24 kbps');
    fake.setBitrate.mockResolvedValueOnce('INVALID_BITRATE');
    click('.segmented button[data-kbps="48"]', p.el);
    await flush();
    expect(toasts().at(-1)).toBe('Pick 6, 12, 24 or 48 kbps.');
    p.destroy();
  });

  it('not the host: only Rejoin, and the quality is locked', () => {
    store.update({ user: { id: 2, username: 'bob' } });
    const p = mount();
    expect([...p.el.querySelectorAll('.voice-actions .btn')].map((b) => b.textContent!.trim())).toEqual(['Rejoin voice']);
    expect(p.el.querySelector('.voice-quality')!.classList.contains('locked')).toBe(true);
    expect(p.el.querySelector('.voice-quality p')!.textContent).toBe('Only the host can change this.');
    p.destroy();
  });
});

describe('voice details', () => {
  const routes = (r: Partial<LinkReport['mine']> = {}) => ({ host: 0, mdns: 0, srflx: 0, relay: 0, v4: 0, v6: 0, ...r });
  const link = (over: Partial<LinkReport>): LinkReport => ({
    userId: 2,
    status: 'connecting',
    forSec: 4,
    role: 'dial',
    ice: 'checking/complete',
    gotReply: true,
    late: { sent: 1, got: 2 },
    relay: { sending: false, heard: false, framesIn: 0 },
    sfu: false,
    route: null,
    stream: null,
    mine: routes({ host: 1, srflx: 1, v4: 2 }),
    theirs: routes({ host: 1, srflx: 1, v4: 2 }),
    via: null,
    audioKbIn: 0,
    ...over,
  });
  const report = (links: LinkReport[], over: Partial<VoiceReport> = {}): VoiceReport => ({
    myId: 1,
    mic: true,
    denoise: true,
    sending: false,
    iceServers: 1,
    signalError: 'offer to 2: TOO_LARGE',
    game: { transport: 'polling' },
    server: { status: 'connected', forSec: 75, connects: 2, route: { protocol: 'UDP', local: { address: '192.168.2.5', port: 5000, type: 'host', protocol: 'udp', family: 'IPv4', network: 'wifi' }, remote: { address: '203.0.113.7', port: 40001, type: 'host', protocol: 'udp', family: 'IPv4' }, rttMs: 12 }, stream: { kbpsIn: 10, kbpsOut: 8, lossPct: 0, jitterMs: 3, codec: 'opus 48 kHz', packetsIn: 1, packetsOut: 1 }, local: false },
    localRoute: { ok: false, why: 'ping 85 ms' },
    events: [{ at: Date.now(), what: 'network changed' }],
    links,
    ...over,
  });

  it('explains each link in plain words, and copies a report', async () => {
    const cases: [Partial<LinkReport>, RegExp][] = [
      [{ sfu: true, status: 'connected' }, /Through the voice server, over UDP/],
      [{ relay: { sending: true, heard: true, framesIn: 40 } }, /Going through the game server:/],
      [{ relay: { sending: true, heard: false, framesIn: 0 } }, /waiting for their audio/],
      [{ status: 'connected', via: 'relay → host', route: { protocol: 'UDP', local: null, remote: null, rttMs: null } }, /through a TURN relay/],
      [{ status: 'connected', via: 'srflx → srflx', route: { protocol: 'TCP', local: null, remote: null, rttMs: 9 } }, /over the internet, over TCP because UDP is blocked/],
      [{ status: 'connected', via: 'host → host' }, /directly on the local network\./],
      [{ gotReply: false, role: 'dial' }, /hasn't answered our call yet/],
      [{ gotReply: false, role: 'answer' }, /Waiting for their phone to call us/],
      [{ theirs: routes() }, /listed no way to reach it/],
      [{ mine: routes() }, /This phone found no way to be reached/],
      [{ mine: routes({ srflx: 1, v6: 1 }), theirs: routes({ srflx: 1, v4: 1 }) }, /No common route: this phone can only be reached over IPv6/],
      [{ mine: routes({ host: 2, mdns: 1, v4: 1 }), theirs: routes({ host: 1, v4: 1 }) }, /Only local-network routes on both sides/],
      [{}, /none got through/],
    ];
    fake.report.mockImplementation(async () => report(cases.map(([over], i) => link({ userId: i === 0 ? 2 : 3 + i, ...over }))));
    const p = mount();
    click('[data-act=toggle]', p.el);
    await flush(20);
    const body = p.el.querySelector('.vd-body')!;
    const text = body.textContent!.replace(/\s+/g, ' ');
    for (const [, want] of cases) expect(text).toMatch(want);
    expect(text).toContain('HTTP long-polling over TCP');
    expect(text).toContain('connected for 1 min 15 s · reconnected 1×');
    expect(text).toContain('Local network route · not used: internet only (ping 85 ms)');
    expect(text).toContain('last signalling error: offer to 2: TOO_LARGE');
    expect(text).toContain('Offered routes · you: 1 local, 1 internet [IPv4 2]');
    expect(text).toContain('late routes ↑1 ↓2');
    expect(text).toContain('Game-server relay (TCP): sending on · 40 frames received');
    expect(text).toContain('bob ·');
    expect(text).toContain('Recent:');
    const clip = (writeText: () => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    clip(async () => {});
    click('[data-act=copy]', p.el);
    await flush(10);
    expect(toasts()).toContain('Voice report copied');
    clip(async () => Promise.reject(new Error('no')));
    click('[data-act=copy]', p.el);
    await flush(10);
    expect(toasts().at(-1)).toContain("Couldn't copy here");
    click('[data-act=toggle]', p.el);
    expect(body.hasAttribute('hidden')).toBe(true);
    fake.report.mockImplementation(async () => report([], { server: { ...report([]).server, status: 'off' }, game: { transport: null }, mic: false, signalError: null, events: [] }));
    click('[data-act=toggle]', p.el);
    await flush(20);
    expect(body.textContent).toContain('Nobody else is in voice chat.');
    expect(body.textContent).toContain('off on this server');
    p.destroy();
  });
});
