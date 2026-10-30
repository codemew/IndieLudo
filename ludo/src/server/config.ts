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
  /**
   * STUN/TURN servers handed to browsers for voice chat. LAN-only play needs none.
   * `turn` is a TURN relay using a shared secret (coturn's use-auth-secret, and most hosted
   * TURN services): each player gets a login that expires, and the secret never leaves the server.
   * `localMaxPingMs`: voice goes over the internet first; a phone also offers local-network
   * routes only if it is on IPv4 with a ping below this (it is then probably on the same network
   * as the server), or once the internet route has failed.
   */
  voice: { iceServers: RTCIceServerConfig[]; turn?: TurnConfig | null; sfu?: SfuConfig; localMaxPingMs: number };
  /** Not in config.json: directory for generated certificates. */
  certDir: string;
}

/**
 * The built-in voice server: every phone sends its voice to the game server once, over UDP, and
 * the server passes it on to everyone else in the lobby (see sfu.ts).
 */
export interface SfuConfig {
  enabled: boolean;
  /** UDP ports for voice, one per phone in a voice chat. Forward this range on the router to play over the internet. */
  portMin: number;
  portMax: number;
  /**
   * The address phones outside the home network reach this server at (the router's public IP).
   * Empty: found automatically with the STUN servers in `voice.iceServers`.
   */
  announcedIp: string;
}

export const DEFAULT_SFU: SfuConfig = { enabled: true, portMin: 40000, portMax: 40099, announcedIp: '' };

export interface TurnConfig {
  /** e.g. ["turn:203.0.113.5:3478", "turn:203.0.113.5:3478?transport=tcp"] */
  urls: string | string[];
  secret: string;
  /** How long a login stays valid; default 12 hours. */
  ttlSec?: number;
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
  voice: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], sfu: DEFAULT_SFU, localMaxPingMs: 40 },
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
    voice: { ...base.voice, ...over.voice, sfu: { ...DEFAULT_SFU, ...base.voice.sfu, ...over.voice?.sfu } },
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
  ['LUDO_TURN_URLS', (c, v) => (c.voice = { ...c.voice, turn: { secret: '', ...c.voice?.turn, urls: v.split(',').map((u) => u.trim()) } })],
  ['LUDO_VOICE_SFU', (c, v) => (c.voice = { ...c.voice, sfu: { ...DEFAULT_SFU, ...c.voice?.sfu, enabled: v !== 'false' && v !== '0' } })],
  ['LUDO_VOICE_PORTS', (c, v) => {
    const [min, max] = v.split('-').map((x) => Number(x.trim()));
    c.voice = { ...c.voice, sfu: { ...DEFAULT_SFU, ...c.voice?.sfu, portMin: min, portMax: max ?? min } };
  }],
  ['LUDO_VOICE_IP', (c, v) => (c.voice = { ...c.voice, sfu: { ...DEFAULT_SFU, ...c.voice?.sfu, announcedIp: v.trim() } })],
  ['LUDO_VOICE_LOCAL_PING_MS', (c, v) => (c.voice = { ...c.voice, localMaxPingMs: Number(v) })],
  ['LUDO_TURN_SECRET', (c, v) => (c.voice = { ...c.voice, turn: { urls: [], ...c.voice?.turn, secret: v } })],
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
  if (!Number.isFinite(c.voice.localMaxPingMs) || c.voice.localMaxPingMs < 0) errors.push('voice.localMaxPingMs must be a non-negative number of milliseconds');
  const sfu = c.voice.sfu;
  if (sfu) {
    const port = (p: number) => Number.isInteger(p) && p >= 1024 && p <= 65535;
    if (!port(sfu.portMin) || !port(sfu.portMax) || sfu.portMax < sfu.portMin) errors.push('voice.sfu.portMin/portMax must be a UDP port range between 1024 and 65535');
    if (sfu.announcedIp && !/^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+$/i.test(sfu.announcedIp)) errors.push('voice.sfu.announcedIp must be an IP address');
  }
  const turn = c.voice.turn;
  if (turn) {
    const urls = Array.isArray(turn.urls) ? turn.urls : [turn.urls];
    if (!urls.length || !urls.every((u) => typeof u === 'string' && /^turns?:/.test(u))) errors.push('voice.turn.urls must be turn: or turns: URLs');
    if (typeof turn.secret !== 'string' || turn.secret.length < 8) errors.push('voice.turn.secret must be at least 8 characters');
    if (turn.ttlSec !== undefined && !(Number.isFinite(turn.ttlSec) && turn.ttlSec >= 60)) errors.push('voice.turn.ttlSec must be at least 60');
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
