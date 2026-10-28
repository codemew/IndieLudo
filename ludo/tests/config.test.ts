import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DEFAULTS, loadConfig, mergeConfig, validateConfig } from '../src/server/config.js';

const EXAMPLE = resolve('config.example.json');
const ENV = ['LUDO_CONFIG', 'LUDO_PORT', 'LUDO_DB_PATH', 'LUDO_LOBBY_CREATE_PASSWORD', 'LUDO_ADMIN_PASSWORD', 'LUDO_HTTPS', 'LUDO_HTTPS_PORT', 'LUDO_CERT_PATH', 'LUDO_KEY_PATH', 'LUDO_TRUST_PROXY', 'LUDO_TURN_URLS', 'LUDO_TURN_SECRET'];

describe('loadConfig', () => {
  let dir: string;
  let cwd: string;
  let warn: MockInstance<typeof console.warn>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ludo-config-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    warn.mockRestore();
  });

  it('on first run copies config.example.json to config.json, and warns about the default passwords', () => {
    copyFileSync(EXAMPLE, 'config.example.json');
    const c = loadConfig();
    expect(existsSync('config.json')).toBe(true);
    expect(readFileSync('config.json', 'utf8')).toBe(readFileSync(EXAMPLE, 'utf8'));
    expect(c.lobbyCreatePassword).toBe('change-me');
    expect(warn.mock.calls.map((a) => String(a[0])).join('\n')).toMatch(/Created .*config\.json[\s\S]*lobbyCreatePassword is still the default[\s\S]*adminPassword is still the default/);
  });

  it('with no config file and no example it refuses to start without the two passwords', () => {
    expect(() => loadConfig()).toThrow(/lobbyCreatePassword is required[\s\S]*adminPassword is required/);
    expect(existsSync('config.json')).toBe(false);
    process.env.LUDO_LOBBY_CREATE_PASSWORD = 'a';
    process.env.LUDO_ADMIN_PASSWORD = 'b';
    expect(loadConfig()).toEqual({ ...DEFAULTS, lobbyCreatePassword: 'a', adminPassword: 'b' });
  });

  it('reads the file named by LUDO_CONFIG, merging nested sections over the defaults', () => {
    writeFileSync('mine.json', JSON.stringify({ lobbyCreatePassword: 'abc', adminPassword: 'def', https: { port: 4443 }, gate: { maxFailsPerIp: 9 } }));
    process.env.LUDO_CONFIG = 'mine.json';
    const c = loadConfig();
    expect(c.lobbyCreatePassword).toBe('abc');
    expect(c.https).toEqual({ ...DEFAULTS.https, port: 4443 });
    expect(c.gate).toEqual({ ...DEFAULTS.gate, maxFailsPerIp: 9 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('environment variables override the file', () => {
    writeFileSync('config.json', JSON.stringify({ port: 1, adminPassword: 'from-file' }));
    Object.assign(process.env, {
      LUDO_PORT: '8080',
      LUDO_DB_PATH: '/srv/ludo.db',
      LUDO_LOBBY_CREATE_PASSWORD: 'env-create',
      LUDO_ADMIN_PASSWORD: 'env-admin',
      LUDO_HTTPS: 'false',
      LUDO_HTTPS_PORT: '9443',
      LUDO_CERT_PATH: '/c.pem',
      LUDO_KEY_PATH: '/k.pem',
      LUDO_TRUST_PROXY: '1',
      LUDO_TURN_URLS: 'turn:a.example:3478, turns:b.example:5349',
      LUDO_TURN_SECRET: 'long-enough-secret',
    });
    const c = loadConfig();
    expect(c).toMatchObject({ port: 8080, dbPath: '/srv/ludo.db', lobbyCreatePassword: 'env-create', adminPassword: 'env-admin', trustProxy: true });
    expect(c.https).toMatchObject({ enabled: false, port: 9443, certPath: '/c.pem', keyPath: '/k.pem' });
    expect(c.voice.turn).toEqual({ urls: ['turn:a.example:3478', 'turns:b.example:5349'], secret: 'long-enough-secret' });
  });

  it('LUDO_HTTPS keeps https on for anything but "false" or "0"', () => {
    writeFileSync('config.json', JSON.stringify({ lobbyCreatePassword: 'a', adminPassword: 'b' }));
    for (const [v, on] of [['true', true], ['1', true], ['0', false], ['false', false]] as const) {
      process.env.LUDO_HTTPS = v;
      expect(loadConfig().https.enabled).toBe(on);
    }
  });

  it('refuses to start on an invalid config, listing every problem and the file', () => {
    writeFileSync('config.json', JSON.stringify({ lobbyCreatePassword: '', port: -1, https: { certPath: '/c.pem' } }));
    expect(() => loadConfig()).toThrow(/Invalid config \(.*config\.json\)[\s\S]*lobbyCreatePassword is required[\s\S]*port must be a non-negative number[\s\S]*certPath and https.keyPath must be set together/);
  });

  it('a broken JSON file is an error, not a silent fallback to defaults', () => {
    writeFileSync('config.json', '{ "port": 3000,');
    expect(() => loadConfig()).toThrow(SyntaxError);
  });
});

describe('validateConfig', () => {
  const ok = mergeConfig(DEFAULTS, { lobbyCreatePassword: 'a', adminPassword: 'b' });

  it('accepts the defaults once the two passwords are set', () => {
    expect(validateConfig(DEFAULTS)).toEqual(['lobbyCreatePassword is required', 'adminPassword is required']);
    expect(validateConfig(ok)).toEqual([]);
  });

  it('rejects ice servers without urls, and a short TURN lifetime', () => {
    const c = mergeConfig(ok, { voice: { iceServers: [{} as never], turn: { urls: ['turn:x:3478'], secret: 'long-enough', ttlSec: 10 } } });
    expect(validateConfig(c)).toEqual(['voice.iceServers must be a list of { "urls": "stun:…" } objects', 'voice.turn.ttlSec must be at least 60']);
  });
});
