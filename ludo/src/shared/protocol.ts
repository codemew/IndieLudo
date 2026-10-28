import type { NetStats } from './net.js';
import type { Color, GameEvent, LobbySummary, PublicGameState, PublicLobby, SwapEnd, SwapRequest, VoiceState } from './types.js';

/** Every socket call is acknowledged with one of these. */
export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

export interface RollIntent { gameId: string; version: number; actionId: string }
export interface MoveIntent extends RollIntent {
  dieIndex: number;
  tokenId: number;
  /** Go round the board again instead of into the home column; absent means head home. */
  lap?: boolean;
}

export interface ClientToServer {
  'lobby:list': (p: Record<string, never>, ack: (r: Ack<LobbySummary[]>) => void) => void;
  'lobby:create': (p: { createPassword: string; name: string; password: string }, ack: (r: Ack<PublicLobby>) => void) => void;
  /** `watch`: join without a seat, to watch (the only way into a lobby whose game is running, or whose seats are full). */
  'lobby:join': (p: { lobbyId: string; password: string; watch?: boolean }, ack: (r: Ack<PublicLobby>) => void) => void;
  'lobby:leave': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  'lobby:ready': (p: { ready: boolean }, ack: (r: Ack) => void) => void;
  'lobby:color': (p: { color: Color }, ack: (r: Ack) => void) => void;
  /** Ask whoever is on `color` to swap colours (a bot swaps at once). */
  'lobby:swapAsk': (p: { color: Color }, ack: (r: Ack<{ swapped: boolean }>) => void) => void;
  'lobby:swapAnswer': (p: { from: number; accept: boolean }, ack: (r: Ack) => void) => void;
  'lobby:swapCancel': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  /** Adds a bot on the seat tapped (`color`); without one, on a random free seat. */
  'lobby:addBot': (p: { color?: Color }, ack: (r: Ack) => void) => void;
  'lobby:removeBot': (p: { color: Color }, ack: (r: Ack) => void) => void;
  /** Host: a bot on every open seat. */
  'lobby:fillBots': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  /** Give up your seat and watch instead. */
  'lobby:spectate': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  /** A spectator takes an open seat. */
  'lobby:sit': (p: { color: Color }, ack: (r: Ack) => void) => void;
  'lobby:kick': (p: { userId: number }, ack: (r: Ack) => void) => void;
  'lobby:start': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  'game:roll': (p: RollIntent, ack: (r: Ack) => void) => void;
  'game:move': (p: MoveIntent, ack: (r: Ack) => void) => void;
  'game:resume': (p: { gameId: string }, ack: (r: Ack<PublicGameState>) => void) => void;
  'game:takeback': (p: { gameId: string }, ack: (r: Ack) => void) => void;
  'voice:get': (p: { lobbyId: string }, ack: (r: Ack<VoiceState>) => void) => void;
  'voice:join': (p: { lobbyId: string }, ack: (r: Ack<VoiceJoined>) => void) => void;
  'voice:leave': (p: { lobbyId: string }, ack: (r: Ack) => void) => void;
  'voice:mute': (p: { lobbyId: string; muted: boolean }, ack: (r: Ack) => void) => void;
  'voice:bitrate': (p: { lobbyId: string; kbps: number }, ack: (r: Ack) => void) => void;
  'voice:enabled': (p: { lobbyId: string; enabled: boolean }, ack: (r: Ack) => void) => void;
  'voice:reboot': (p: { lobbyId: string }, ack: (r: Ack) => void) => void;
  'voice:signal': (p: VoiceSignalOut, ack: (r: Ack) => void) => void;
  /** Relayed voice for links that can't connect directly: a few Opus frames, for one or more players. */
  'voice:frames': (p: VoiceFramesOut) => void;
}

export interface VoiceJoined {
  state: VoiceState;
  iceServers: RTCIceServerConfig[];
}

/** Same shape as the browser's RTCIceServer, declared here so the server needs no DOM types. */
export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * WebRTC signalling relayed through the server. Of each pair of phones only the one with the
 * lower user id sends offers; the other sends a `ring` (no SDP) to ask for one. `call` ties an
 * answer to the offer it answers, so a late answer to an abandoned offer is ignored.
 * `sdp` carries the description with the candidates gathered so far; candidates found later
 * (slow STUN on cellular, a relay) follow as `cand`, a JSON list of RTCIceCandidateInit.
 */
export type VoiceSignalKind = 'offer' | 'answer' | 'ring' | 'cand';

export interface VoiceSignalOut {
  lobbyId: string;
  to: number;
  kind: string;
  call: number;
  sdp: string;
}

export interface VoiceSignalIn {
  lobbyId: string;
  from: number;
  kind: VoiceSignalKind;
  call: number;
  sdp: string;
}

/**
 * Voice through the game server, for pairs of phones that can't connect directly (for example
 * a phone on Jio mobile data and one on IPv4-only Wi-Fi). Each frame is 20 ms of Opus audio.
 */
export const RELAY_LIMITS = {
  /** Frames per message (about 60 ms of audio is sent at a time). */
  maxFrames: 8,
  maxFrameBytes: 1500,
  maxTargets: 3,
  /** Messages per second, with a burst allowance; separate from the game's flood limit. */
  perSecond: 30,
  burst: 60,
} as const;

export interface VoiceFramesOut {
  lobbyId: string;
  to: number[];
  frames: ArrayBuffer[];
}

export interface VoiceFramesIn {
  lobbyId: string;
  from: number;
  frames: ArrayBuffer[];
}

export interface Hello {
  /** The version the server is running, so a phone on an older build can offer to update. */
  appVersion: string;
  user: { id: number; username: string };
  lobby: PublicLobby | null;
  game: PublicGameState | null;
}

export interface GameUpdate {
  state: PublicGameState;
  /** Absent for plain resyncs, which the client renders without animation. */
  events?: GameEvent[];
}

export interface ServerToClient {
  hello: (h: Hello) => void;
  'lobby:list': (l: LobbySummary[]) => void;
  'lobby:state': (l: PublicLobby | null) => void;
  /** Someone asks you to swap colours. */
  'lobby:swapRequest': (r: SwapRequest) => void;
  /** A swap request you made or received is over. */
  'lobby:swapEnded': (e: { from: number; to: number; how: SwapEnd }) => void;
  /** The lobby you are in was closed by an admin; a `lobby:state` null follows. */
  'lobby:closed': (info: { byAdmin: boolean }) => void;
  'game:state': (u: GameUpdate) => void;
  'session:revoked': () => void;
  'voice:state': (s: VoiceState) => void;
  /** Server-timed ping; the client just acknowledges. */
  'net:ping': (ack: () => void) => void;
  /** Every few seconds: each lobby member's ping and signal bars. */
  'net:stats': (s: NetStats) => void;
  'voice:signal': (s: VoiceSignalIn) => void;
  'voice:frames': (f: VoiceFramesIn) => void;
}

type FieldType = 'string' | 'int' | 'bool' | 'color';
export type Schema = Record<string, { type: FieldType; max?: number; min?: number; optional?: boolean }>;

const COLOR_SET = new Set(['red', 'green', 'yellow', 'blue']);

/**
 * Strict payload check: every field must be present with the right type, and unknown
 * fields are rejected, so a client cannot smuggle in a die value or a destination.
 */
export function matchesSchema(payload: unknown, schema: Schema): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const [key, rule] of Object.entries(schema)) if (!rule.optional && !(key in obj)) return false;
  for (const key of keys) {
    if (!Object.hasOwn(schema, key)) return false;
    const rule = schema[key];
    const v = obj[key];
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string' || v.length > (rule.max ?? 256) || v.length < (rule.min ?? 0)) return false;
        break;
      case 'int':
        if (!Number.isSafeInteger(v) || (v as number) < (rule.min ?? 0) || (v as number) > (rule.max ?? Number.MAX_SAFE_INTEGER)) return false;
        break;
      case 'bool':
        if (typeof v !== 'boolean') return false;
        break;
      case 'color':
        if (typeof v !== 'string' || !COLOR_SET.has(v)) return false;
        break;
    }
  }
  return true;
}

export const SCHEMAS = {
  empty: {},
  lobbyCreate: { createPassword: { type: 'string', max: 128 }, name: { type: 'string', min: 1, max: 32 }, password: { type: 'string', min: 1, max: 64 } },
  lobbyJoin: { lobbyId: { type: 'string', max: 64 }, password: { type: 'string', max: 64 }, watch: { type: 'bool', optional: true } },
  lobbyReady: { ready: { type: 'bool' } },
  lobbyColor: { color: { type: 'color' } },
  lobbyAddBot: { color: { type: 'color', optional: true } },
  lobbyKick: { userId: { type: 'int', min: 1 } },
  swapAnswer: { from: { type: 'int', min: 1 }, accept: { type: 'bool' } },
  roll: { gameId: { type: 'string', max: 64 }, version: { type: 'int' }, actionId: { type: 'string', min: 8, max: 64 } },
  move: {
    gameId: { type: 'string', max: 64 },
    version: { type: 'int' },
    actionId: { type: 'string', min: 8, max: 64 },
    dieIndex: { type: 'int', max: 2 },
    tokenId: { type: 'int', max: 3 },
    lap: { type: 'bool', optional: true },
  },
  gameRef: { gameId: { type: 'string', max: 64 } },
  voiceRef: { lobbyId: { type: 'string', max: 64 } },
  voiceMute: { lobbyId: { type: 'string', max: 64 }, muted: { type: 'bool' } },
  voiceBitrate: { lobbyId: { type: 'string', max: 64 }, kbps: { type: 'int', min: 6, max: 48 } },
  voiceEnabled: { lobbyId: { type: 'string', max: 64 }, enabled: { type: 'bool' } },
  voiceSignal: {
    lobbyId: { type: 'string', max: 64 },
    to: { type: 'int', min: 1 },
    kind: { type: 'string', min: 4, max: 6 },
    call: { type: 'int' },
    sdp: { type: 'string', max: 12_000 },
  },
} satisfies Record<string, Schema>;
