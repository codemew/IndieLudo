import type { LocalRoute } from './ice.js';
import type { NetStats } from './net.js';
import type { Color, GameEvent, LobbySummary, OnlineUser, PublicGameState, PublicLobby, SwapEnd, SwapRequest, Turn, VoiceSlot, VoiceState } from './types.js';
import { ALL_COLORS, MAX_VOICE_PEERS } from './types.js';

/** Every socket call is acknowledged with one of these. */
export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

export interface RollIntent { gameId: string; version: number; actionId: string }
export interface MoveIntent extends RollIntent {
  dieIndex: number;
  tokenId: number;
  /** The token's colour, for a partner's token (turn sharing); absent means the player's own. */
  color?: Color;
  /** Go round the board again instead of into the home column; absent means head home. */
  lap?: boolean;
  /** Power ups: a thief turns into this colour's home column; absent means it stays on the track. */
  raid?: Color;
}

export interface ClientToServer {
  'lobby:list': (p: Record<string, never>, ack: (r: Ack<LobbySummary[]>) => void) => void;
  /** Who is online now (the Users tab); changes also arrive as `users:online`. */
  'users:list': (p: Record<string, never>, ack: (r: Ack<OnlineUser[]>) => void) => void;
  /** This phone's model, system and browser, from its client hints (Chromium browsers have them). */
  'device:info': (p: DeviceInfo, ack: (r: Ack) => void) => void;
  /** "Are you still there?" from the phone, after a network change: answered at once. */
  'net:probe': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  'lobby:create': (p: { createPassword: string; name: string; password: string }, ack: (r: Ack<PublicLobby>) => void) => void;
  /** `watch`: join without a seat, to watch (the only way into a lobby whose game is running, or whose seats are full). */
  'lobby:join': (p: { lobbyId: string; password: string; watch?: boolean }, ack: (r: Ack<PublicLobby>) => void) => void;
  'lobby:leave': (p: Record<string, never>, ack: (r: Ack) => void) => void;
  /** Host, between games: leave and close the lobby for everyone (they all go back home). */
  'lobby:close': (p: Record<string, never>, ack: (r: Ack) => void) => void;
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
  /** Host: Classic (false) or Team-up (true) for the next game. */
  'lobby:mode': (p: { teams: boolean }, ack: (r: Ack) => void) => void;
  /** Host: Team-up with turn sharing on or off (partners may move each other's tokens). */
  'lobby:share': (p: { share: boolean }, ack: (r: Ack) => void) => void;
  /** Host: 4, 5 or 6 seats (the board for the next game). */
  'lobby:size': (p: { size: number }, ack: (r: Ack) => void) => void;
  /** Host: the optional rules power ups and golden token on or off for the next game (either or both). */
  'lobby:rules': (p: { powerUps?: boolean; golden?: boolean }, ack: (r: Ack) => void) => void;
  'game:roll': (p: RollIntent, ack: (r: Ack) => void) => void;
  'game:move': (p: MoveIntent, ack: (r: Ack) => void) => void;
  /** Admins only (a test aid): the next roll of my seat comes up `value` (1 to 6; 0 = back to chance). */
  'game:force': (p: { gameId: string; value: number }, ack: (r: Ack) => void) => void;
  'game:resume': (p: { gameId: string }, ack: (r: Ack<PublicGameState>) => void) => void;
  'game:takeback': (p: { gameId: string }, ack: (r: Ack) => void) => void;
  /** Give up: you're out (ranked below everyone still playing) and watch the rest. */
  'game:surrender': (p: { gameId: string; actionId: string }, ack: (r: Ack) => void) => void;
  /** A wildcard entry: send home tokens (`tokens`, a bitmask of token ids) back to base. */
  'game:respawn': (p: { gameId: string; actionId: string; tokens: number }, ack: (r: Ack) => void) => void;
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
  /** Connect to the built-in voice server: it answers with its offer and the slot map. */
  /** `local`: offer local-network routes too, even if this phone doesn't qualify for them (the internet route failed). */
  'voice:sfuJoin': (p: { lobbyId: string; local?: boolean }, ack: (r: Ack<SfuOffer>) => void) => void;
  'voice:sfuAnswer': (p: { lobbyId: string; sdp: string }, ack: (r: Ack) => void) => void;
  /** Late ICE candidates from the phone, as JSON (a list of RTCIceCandidateInit). */
  'voice:sfuCand': (p: { lobbyId: string; sdp: string }, ack: (r: Ack) => void) => void;
}

/** What a phone says about itself; every field optional, plain text, short. */
export interface DeviceInfo {
  model?: string;
  platform?: string;
  platformVersion?: string;
  brand?: string;
  brandVersion?: string;
}

export interface SfuOffer {
  sdp: string;
  slots: VoiceSlot[];
}

export interface VoiceJoined {
  state: VoiceState;
  iceServers: RTCIceServerConfig[];
  /** The built-in voice server is on: connect to it (voice:sfuJoin) first. */
  sfu?: boolean;
  /** Whether this phone may offer local-network routes (IPv4 and a low ping), and why: voice goes internet first. */
  local?: LocalRoute;
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
  /** Everyone else in a full lobby (4 seats + 4 spectators − you). */
  maxTargets: MAX_VOICE_PEERS - 1,
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
  /** `canCreate`: this account may create lobbies without the creation password (it entered it once). */
  user: { id: number; username: string; avatar?: string; canCreate?: boolean };
  lobby: PublicLobby | null;
  game: PublicGameState | null;
}

export interface GameUpdate {
  state: PublicGameState;
  /** Absent for plain resyncs, which the client renders without animation. */
  events?: GameEvent[];
}

/**
 * A roll that only grew the queue (the same player rolls again or moves next), sent to everyone
 * but the roller instead of the whole state: about a tenth of the bytes. The phone applies it to
 * the state it has; the next full update (the move) brings everything else, legal moves included.
 */
export interface RollUpdate {
  id: string;
  version: number;
  serverNow: number;
  turn: Turn;
  events: GameEvent[];
}

export interface ServerToClient {
  hello: (h: Hello) => void;
  'lobby:list': (l: LobbySummary[]) => void;
  /** Everyone online, sent when it changes (someone comes or goes, moves, renames, switches phones). */
  'users:online': (l: OnlineUser[]) => void;
  'lobby:state': (l: PublicLobby | null) => void;
  /** Someone asks you to swap colours. */
  'lobby:swapRequest': (r: SwapRequest) => void;
  /** A swap request you made or received is over. */
  'lobby:swapEnded': (e: { from: number; to: number; how: SwapEnd }) => void;
  /** The lobby you are in was closed by an admin or by its host; a `lobby:state` null follows. */
  'lobby:closed': (info: { byAdmin: boolean; byHost?: boolean }) => void;
  'game:state': (u: GameUpdate) => void;
  'game:roll': (u: RollUpdate) => void;
  /** To an admin's own phone only: the forced roll that was set (or is used up: null). */
  'game:forced': (u: { gameId: string; value: number | null }) => void;
  'session:revoked': () => void;
  'voice:state': (s: VoiceState) => void;
  /** Server-timed ping; the client just acknowledges. */
  'net:ping': (ack: () => void) => void;
  /** Every few seconds: each lobby member's ping and signal bars. */
  'net:stats': (s: NetStats) => void;
  'voice:signal': (s: VoiceSignalIn) => void;
  'voice:frames': (f: VoiceFramesIn) => void;
  /** Which of your voice-server receive slots carries whose voice (sent when it changes). */
  'voice:slots': (s: { lobbyId: string; slots: VoiceSlot[] }) => void;
  /** The voice server lost your link (it broke on its side): reconnect it now. */
  'voice:sfuGone': (s: { lobbyId: string }) => void;
}

type FieldType = 'string' | 'int' | 'bool' | 'color';
export type Schema = Record<string, { type: FieldType; max?: number; min?: number; optional?: boolean }>;

const COLOR_SET = new Set<string>(ALL_COLORS);

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
  deviceInfo: {
    model: { type: 'string', max: 64, optional: true },
    platform: { type: 'string', max: 32, optional: true },
    platformVersion: { type: 'string', max: 32, optional: true },
    brand: { type: 'string', max: 48, optional: true },
    brandVersion: { type: 'string', max: 32, optional: true },
  },
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
    color: { type: 'color', optional: true },
    lap: { type: 'bool', optional: true },
    raid: { type: 'color', optional: true },
  },
  gameRef: { gameId: { type: 'string', max: 64 } },
  gameForce: { gameId: { type: 'string', max: 64 }, value: { type: 'int', min: 0, max: 6 } },
  surrender: { gameId: { type: 'string', max: 64 }, actionId: { type: 'string', min: 8, max: 64 } },
  respawn: { gameId: { type: 'string', max: 64 }, actionId: { type: 'string', min: 8, max: 64 }, tokens: { type: 'int', min: 1, max: 15 } },
  lobbyMode: { teams: { type: 'bool' } },
  lobbyShare: { share: { type: 'bool' } },
  lobbyRules: { powerUps: { type: 'bool', optional: true }, golden: { type: 'bool', optional: true } },
  lobbySize: { size: { type: 'int', min: 4, max: 6 } },
  sfuJoin: { lobbyId: { type: 'string', max: 64 }, local: { type: 'bool', optional: true } },
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
  sfuSdp: { lobbyId: { type: 'string', max: 64 }, sdp: { type: 'string', min: 1, max: 14_000 } },
} satisfies Record<string, Schema>;
