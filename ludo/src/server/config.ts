import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RTCIceServerConfig } from '../shared/protocol.js';

export interface Config {
  port: number;
  dbPath: string;
  lobbyCreatePassword: string;
  adminPassword: string;
  turnTimeoutSec: number;
  disconnectGraceSec: number;
  maxLobbies: number;
  lobbyIdleCloseSec: number;
  https: {
    enabled: boolean;
    port: number;
    httpRedirectPort: number;
    certPath: string;
    keyPath: string;
    autoSelfSigned: boolean;
  };
  trustProxy: boolean;
  gate: { maxFailsPerIp: number; globalFailRotateThreshold: number };
  /** STUN/TURN servers handed to browsers for voice chat. LAN-only play needs none. */
  voice: { iceServers: RTCIceServerConfig[] };
  /** Not in config.json: directory for generated certificates. */
  certDir: string;
}

export const DEFAULT_PASSWORDS = ['change-me', 'change-me-too'];

export const DEFAULTS: Config = {
  port: 3000,
  dbPath: './data/ludo.db',
  lobbyCreatePassword: '',
  adminPassword: '',
  turnTimeoutSec: 30,
  disconnectGraceSec: 60,
  maxLobbies: 50,
  lobbyIdleCloseSec: 600,
  https: { enabled: true, port: 3443, httpRedirectPort: 3000, certPath: '', keyPath: '', autoSelfSigned: true },
  trustProxy: false,
  gate: { maxFailsPerIp: 5, globalFailRotateThreshold: 50 },
  voice: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  certDir: './data/certs',
};

export type ConfigOverrides = Partial<Omit<Config, 'https' | 'gate' | 'voice'>> & {
  https?: Partial<Config['https']>;
  gate?: Partial<Config['gate']>;
  voice?: Partial<Config['voice']>;
};

export function mergeConfig(base: Config, over: ConfigOverrides): Config {
  return {
    ...base,
    ...over,
    https: { ...base.https, ...over.https },
    gate: { ...base.gate, ...over.gate },
    voice: { ...base.voice, ...over.voice },
  };
}

const ENV_MAP: [string, (c: ConfigOverrides, v: string) => void][] = [
  ['LUDO_PORT', (c, v) => (c.port = Number(v))],
  ['LUDO_DB_PATH', (c, v) => (c.dbPath = v)],
  ['LUDO_LOBBY_CREATE_PASSWORD', (c, v) => (c.lobbyCreatePassword = v)],
  ['LUDO_ADMIN_PASSWORD', (c, v) => (c.adminPassword = v)],
  ['LUDO_HTTPS', (c, v) => (c.https = { ...c.https, enabled: v !== 'false' && v !== '0' })],
  ['LUDO_HTTPS_PORT', (c, v) => (c.https = { ...c.https, port: Number(v) })],
  ['LUDO_CERT_PATH', (c, v) => (c.https = { ...c.https, certPath: v })],
  ['LUDO_KEY_PATH', (c, v) => (c.https = { ...c.https, keyPath: v })],
  ['LUDO_TRUST_PROXY', (c, v) => (c.trustProxy = v === 'true' || v === '1')],
];

export function validateConfig(c: Config): string[] {
  const errors: string[] = [];
  if (!c.lobbyCreatePassword) errors.push('lobbyCreatePassword is required');
  if (!c.adminPassword) errors.push('adminPassword is required');
  for (const [k, v] of Object.entries({
    port: c.port,
    'https.port': c.https.port,
    'https.httpRedirectPort': c.https.httpRedirectPort,
    turnTimeoutSec: c.turnTimeoutSec,
    disconnectGraceSec: c.disconnectGraceSec,
    maxLobbies: c.maxLobbies,
    lobbyIdleCloseSec: c.lobbyIdleCloseSec,
    'gate.maxFailsPerIp': c.gate.maxFailsPerIp,
    'gate.globalFailRotateThreshold': c.gate.globalFailRotateThreshold,
  })) {
    if (!Number.isFinite(v) || v < 0) errors.push(`${k} must be a non-negative number`);
  }
  if (Boolean(c.https.certPath) !== Boolean(c.https.keyPath)) errors.push('https.certPath and https.keyPath must be set together');
  const ice = c.voice.iceServers;
  const validUrls = (u: unknown) => typeof u === 'string' || (Array.isArray(u) && u.every((x) => typeof x === 'string'));
  if (!Array.isArray(ice) || !ice.every((s) => s && typeof s === 'object' && validUrls(s.urls))) {
    errors.push('voice.iceServers must be a list of { "urls": "stun:…" } objects');
  }
  return errors;
}

/** Loads config.json (copying the example on first run), applies env overrides and validates. */
export function loadConfig(path = process.env.LUDO_CONFIG ?? 'config.json'): Config {
  const file = resolve(path);
  if (!existsSync(file)) {
    const example = resolve('config.example.json');
    if (existsSync(example)) {
      copyFileSync(example, file);
      console.warn(`[config] Created ${file} from config.example.json. Edit the passwords before sharing the game.`);
    }
  }
  const fromFile: ConfigOverrides = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const fromEnv: ConfigOverrides = {};
  for (const [name, apply] of ENV_MAP) {
    const v = process.env[name];
    if (v !== undefined) apply(fromEnv, v);
  }
  const config = mergeConfig(mergeConfig(DEFAULTS, fromFile), fromEnv);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid config (${file}):\n  - ${errors.join('\n  - ')}`);
  for (const key of ['lobbyCreatePassword', 'adminPassword'] as const) {
    if (DEFAULT_PASSWORDS.includes(config[key])) console.warn(`[config] WARNING: ${key} is still the default value. Change it in ${file}.`);
  }
  return config;
}
