import type { Color, GameEvent, LobbySummary, PublicGameState, PublicLobby, VoiceState } from './types.js';

/** Every socket call is acknowledged with one of these. */
export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

export interface RollIntent { gameId: string; version: number; actionId: string }
export interface MoveIntent extends RollIntent { dieIndex: number; tokenId: number }

export interface ClientToServer {
  'lobby:list': (p: Record<string, never>, ack: (r: Ack<LobbySummary[]>) => void) => void;
  'lobby:create': (p: { createPassword: string; name: string; password: string }, ack: (r: Ack<PublicLobby>) => void) => void;
  'lobby:join': (p: { lobbyId: string; password: string }, ack: (r: Ack<PublicLobby>) => void) => void;
  'lobby:leave': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  'lobby:ready': (p: { ready: boolean }, ack: (r: Ack) => void) => void;
  'lobby:color': (p: { color: Color }, ack: (r: Ack) => void) => void;
  'lobby:addBot': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  'lobby:removeBot': (p: { color: Color }, ack: (r: Ack) => void) => void;
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
  'voice:signal': (p: VoiceSignalOut, ack: (r: Ack) => void) => void;
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

/** WebRTC offer/answer relayed through the server. `sdp` carries the full description (ICE gathered). */
export interface VoiceSignalOut {
  lobbyId: string;
  to: number;
  kind: string;
  sdp: string;
}

export interface VoiceSignalIn {
  lobbyId: string;
  from: number;
  kind: 'offer' | 'answer';
  sdp: string;
}

export interface Hello {
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
  'game:state': (u: GameUpdate) => void;
  'session:revoked': () => void;
  'voice:state': (s: VoiceState) => void;
  'voice:signal': (s: VoiceSignalIn) => void;
}

type FieldType = 'string' | 'int' | 'bool' | 'color';
export type Schema = Record<string, { type: FieldType; max?: number; min?: number }>;

const COLOR_SET = new Set(['red', 'green', 'yellow', 'blue']);

/**
 * Strict payload check: every field must be present with the right type, and unknown
 * fields are rejected, so a client cannot smuggle in a die value or a destination.
 */
export function matchesSchema(payload: unknown, schema: Schema): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== Object.keys(schema).length) return false;
  for (const key of keys) {
    const rule = schema[key];
    if (!rule) return false;
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
  lobbyJoin: { lobbyId: { type: 'string', max: 64 }, password: { type: 'string', max: 64 } },
  lobbyReady: { ready: { type: 'bool' } },
  lobbyColor: { color: { type: 'color' } },
  lobbyKick: { userId: { type: 'int', min: 1 } },
  roll: { gameId: { type: 'string', max: 64 }, version: { type: 'int' }, actionId: { type: 'string', min: 8, max: 64 } },
  move: {
    gameId: { type: 'string', max: 64 },
    version: { type: 'int' },
    actionId: { type: 'string', min: 8, max: 64 },
    dieIndex: { type: 'int', max: 2 },
    tokenId: { type: 'int', max: 3 },
  },
  gameRef: { gameId: { type: 'string', max: 64 } },
  voiceRef: { lobbyId: { type: 'string', max: 64 } },
  voiceMute: { lobbyId: { type: 'string', max: 64 }, muted: { type: 'bool' } },
  voiceBitrate: { lobbyId: { type: 'string', max: 64 }, kbps: { type: 'int', min: 16, max: 64 } },
  voiceSignal: {
    lobbyId: { type: 'string', max: 64 },
    to: { type: 'int', min: 1 },
    kind: { type: 'string', min: 5, max: 6 },
    sdp: { type: 'string', min: 1, max: 12_000 },
  },
} satisfies Record<string, Schema>;
