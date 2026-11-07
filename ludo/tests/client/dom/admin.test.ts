// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, flush, modalButton, setupDom, toasts, topModal } from './harness.js';

vi.mock('../../../src/client/net.js', () => import('./fakeNet.js'));
const appMock = vi.hoisted(() => ({ entered: 0, signedOut: 0 }));
vi.mock('../../../src/client/app.js', () => ({
  enterApp: async () => void appMock.entered++,
  signOut: () => void appMock.signedOut++,
  showError: vi.fn(),
}));

const http: Record<string, (body: any) => [number, unknown]> = {};
const calls: string[] = [];
let router: typeof import('../../../src/client/router.js');
let store: typeof import('../../../src/client/store.js');
const DAY = 86_400_000;

beforeAll(async () => {
  setupDom();
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${String(url).split('?')[0]}`;
    calls.push(`${init.method} ${url}`);
    const h = http[key];
    if (!h) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    const [status, body] = h(init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(body), { status });
  }) as any;
  router = await import('../../../src/client/router.js');
  store = await import('../../../src/client/store.js');
  const { adminScreen } = await import('../../../src/client/screens/admin.js');
  router.register('admin', adminScreen);
  router.register('home', () => {});
  http['GET /api/admin/users'] = () => [200, [{ id: 1, username: 'alice', created_at: 0, last_seen: Date.now() - 30_000, games_played: 4, wins: 1 }, { id: 2, username: 'bob', created_at: 0, last_seen: Date.now() - 2 * DAY, games_played: 0, wins: 0 }]];
  http['GET /api/admin/lobbies'] = () => [200, [{ id: 'L1', name: 'Fam', hostName: 'alice', status: 'playing', players: 3, watching: 1, teams: true, createdAt: Date.now() - 3_600_000, members: [{ username: 'alice', isBot: false, connected: true }, { username: 'Bot Red', isBot: true, connected: true }, { username: 'zed', isBot: false, connected: false, watching: true }] }]];
  http['GET /api/admin/devices'] = () => [200, [{ id: 7, user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130', ip_first_seen: '192.168.2.5', verified_at: 0, last_seen: Date.now() - 7_200_000 }]];
  http['GET /api/admin/sessions'] = () => [200, [{ id: 9, user_id: 1, username: 'alice', device_id: 7, is_admin: 1, user_agent: 'Mozilla/5.0 (iPhone) CriOS/120', last_seen: Date.now() }, { id: 10, user_id: null, username: null, device_id: 8, is_admin: 1, user_agent: 'curl', last_seen: Date.now() }]];
  http['GET /api/admin/code'] = () => [200, { code: '123456' }];
  http['POST /api/admin/code/rotate'] = () => [200, { code: '654321' }];
  for (const k of ['DELETE /api/admin/users/2', 'DELETE /api/admin/lobbies/L1', 'DELETE /api/admin/devices/7', 'DELETE /api/admin/sessions/9', 'PATCH /api/admin/users/1', 'POST /api/admin/logout']) http[k] = () => [200, { ok: true }];
});

const panel = () => document.querySelector('#panel')!;
const tab = async (name: string) => {
  click(`.tabs button[data-tab=${name}]`);
  await flush(20);
};

beforeEach(() => {
  document.getElementById('toasts')!.innerHTML = '';
});

describe('the admin panel', () => {
  it('users: search, rename and delete', async () => {
    store.update({ user: { id: 1, username: 'alice' }, isAdmin: true });
    router.go('admin');
    await flush(20);
    expect(panel().textContent).toContain('2 users');
    expect(panel().textContent).toContain('1/4 wins');
    const search = panel().querySelector<HTMLInputElement>('.search')!;
    search.value = 'al';
    search.dispatchEvent(new Event('input'));
    await flush(350);
    expect(calls.some((c) => c.includes('/admin/users?q=al'))).toBe(true);
    click('li[data-id="1"] [data-act=rename]', panel());
    await flush(10);
    (topModal().querySelector('input') as HTMLInputElement).value = 'alicia';
    modalButton('Save');
    await flush(20);
    http['PATCH /api/admin/users/1'] = () => [409, { error: 'USERNAME_TAKEN' }];
    click('li[data-id="1"] [data-act=rename]', panel());
    await flush(10);
    modalButton('Save');
    await flush(20);
    expect(topModal().querySelector('.form-error')!.textContent).toBe('That name is taken.');
    modalButton('Cancel');
    click('li[data-id="2"] [data-act=delete]', panel());
    await flush(10);
    modalButton('Delete');
    await flush(30);
    expect(toasts()).toContain('User deleted');
  });

  it('lobbies, devices and sessions, each with its action', async () => {
    await tab('lobbies');
    expect(panel().textContent).toContain('Fam');
    expect(panel().textContent).toContain('🤖 Bot Red, 👀 zed (offline)');
    click('.chip-danger', panel());
    await flush(10);
    expect(topModal().textContent).toContain('the game in progress ends without a result');
    modalButton('Close lobby');
    await flush(30);
    expect(toasts()).toContain('Lobby closed');
    await tab('devices');
    expect(panel().textContent).toContain('Android 14 · Chrome');
    click('.chip-danger', panel());
    await flush(10);
    modalButton('Revoke');
    await flush(30);
    expect(toasts()).toContain('Device revoked');
    await tab('sessions');
    expect(panel().textContent).toContain('(admin only) 🛡️');
    expect(panel().textContent).toContain('iPhone · Chrome');
    click('li[data-id="9"] .chip-danger', panel());
    await flush(30);
    expect(toasts()).toContain('Session revoked');
  });

  it('the access code, regenerated', async () => {
    await tab('code');
    expect(document.querySelector('#code')!.textContent).toBe('123 456');
    click('#rotate');
    await flush(30);
    expect(document.querySelector('#code')!.textContent).toBe('654 321');
  });

  it("passwords: a lobby's join password, the creation password, and remembered hosts", async () => {
    // A lobby's join password, from its row in Lobbies.
    const sent: unknown[] = [];
    http['PATCH /api/admin/lobbies/L1'] = (b) => (sent.push(b), [200, { ok: true }]);
    await tab('lobbies');
    click('[data-act=password]', panel());
    await flush(10);
    expect(topModal().querySelector('h2')!.textContent).toBe('Password for "Fam"');
    modalButton('Save');
    await flush(10);
    expect(topModal().querySelector('.form-error')!.textContent).toBe('Type the new password.');
    topModal().querySelector<HTMLInputElement>('[name=password]')!.value = 'new-pw';
    modalButton('Save');
    await flush(30);
    expect(sent).toEqual([{ password: 'new-pw' }]);
    expect(toasts()).toContain('New password for Fam');

    // The creation password and the accounts that skip it.
    let info = { source: 'config', hosts: [{ userId: 1, username: 'alice', grantedAt: Date.now() - DAY }] };
    const puts: unknown[] = [];
    http['GET /api/admin/create-access'] = () => [200, info];
    http['PUT /api/admin/create-password'] = (b) => {
      puts.push(b);
      info = { source: b.password === null ? 'config' : 'admin', hosts: [] };
      return [200, info];
    };
    http['DELETE /api/admin/create-access/1'] = () => ((info = { ...info, hosts: [] }), [200, { ok: true }]);
    await tab('passwords');
    expect(panel().textContent).toContain('From config.json');
    expect(panel().textContent).toContain('Remembered hosts (1)');
    expect(panel().textContent).toContain('alice');
    expect(panel().querySelector('#use-config')).toBeNull();
    const form = panel().querySelector<HTMLFormElement>('#create-pw-form')!;
    const set = (a: string, b: string) => {
      form.querySelector<HTMLInputElement>('[name=pw]')!.value = a;
      form.querySelector<HTMLInputElement>('[name=pw2]')!.value = b;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    };
    set('abc', 'abc');
    expect(form.querySelector('.form-error')!.textContent).toBe('Use at least 4 characters.');
    set('secret', 'secreT');
    expect(form.querySelector('.form-error')!.textContent).toBe("The two don't match.");
    set('secret', 'secret');
    await flush(10);
    // alice is remembered, so it says she'll have to type it again.
    expect(topModal().textContent).toContain('The 1 remembered host will need to type the new one once.');
    modalButton('Change');
    await flush(30);
    expect(puts).toEqual([{ password: 'secret' }]);
    expect(toasts()).toContain('Creation password changed');
    expect(panel().textContent).toContain('Set here in the admin panel');
    expect(panel().textContent).toContain('Remembered hosts (0)');
    // Back to config.json's.
    click('#use-config', panel());
    await flush(10);
    modalButton('Use config.json');
    await flush(30);
    expect(puts.at(-1)).toEqual({ password: null });
    expect(panel().textContent).toContain('From config.json');

    // Forgetting one account.
    info = { source: 'config', hosts: [{ userId: 1, username: 'alice', grantedAt: Date.now() }] };
    await tab('code');
    await tab('passwords');
    click('li[data-id="1"] .chip-danger', panel());
    await flush(30);
    expect(calls).toContain('DELETE /api/admin/create-access/1');
    expect(panel().textContent).toContain('Nobody yet.');
  });

  it('an expired admin session goes back home; other errors are shown', async () => {
    http['GET /api/admin/devices'] = () => [500, { error: 'INTERNAL' }];
    await tab('devices');
    expect(toasts()).toContain('Something went wrong (INTERNAL).');
    http['GET /api/admin/sessions'] = () => [401, { error: 'UNAUTHORIZED' }];
    await tab('sessions');
    await flush(30);
    expect(toasts()).toContain('Admin session ended');
    expect(router.currentScreen()).toBe('home');
  });

  it('admin without a player account: leaving signs out; the login dialog', async () => {
    store.update({ user: null, isAdmin: true });
    router.go('admin');
    await flush(20);
    click('#back');
    await flush(30);
    expect(appMock.signedOut).toBe(1);
    const { adminLoginDialog } = await import('../../../src/client/screens/admin.js');
    http['POST /api/admin/login'] = () => [403, { error: 'WRONG_PASSWORD' }];
    adminLoginDialog();
    await flush(10);
    modalButton('Log in');
    await flush(20);
    expect(topModal().querySelector('.form-error')!.textContent).toBe('Wrong admin password.');
    http['POST /api/admin/login'] = () => [200, { token: 'adm' }];
    modalButton('Log in');
    await flush(20);
    expect(appMock.entered).toBe(1);
    expect(localStorage.getItem('ludo.sessionToken')).toBe('adm');
  });
});
