import type { BoardSize } from './board.js';

export type Color = 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'orange';

/** The 4-player board's colours, clockwise (turn order). Other boards: boardOf(n).colors. */
export const COLORS: readonly Color[] = ['red', 'green', 'yellow', 'blue'];
/** Every seat colour there is: the 5-player board adds purple, the 6-player board orange too. */
export const ALL_COLORS: readonly Color[] = ['red', 'green', 'yellow', 'blue', 'purple', 'orange'];

/** Team-up (4-player board only) partners sit diagonally opposite: red with yellow, green with blue. */
export const TEAMMATE: Readonly<Partial<Record<Color, Color>>> = { red: 'yellow', yellow: 'red', green: 'blue', blue: 'green' };

/** How long every phone shows the "first blood" banner; the server waits this out before bots and timers carry on. */
export const FIRST_BLOOD_MS = 1800;
/** How long the phones show a surrender (tokens sliding home, the white flag going up). */
export const SURRENDER_MS = 1400;
/** How long the phones show a wildcard entry (the banner, the token flying from home back to base). */
export const WILDCARD_MS = 2400;
/** A wildcard entry of several tokens sends them off one after another, this far apart. */
export const WILDCARD_STAGGER_MS = 180;
/** Consecutive turns a player may miss (timer ran out) before a bot takes the seat. */
export const MAX_MISSED_TURNS = 5;

/**
 * A bot battle (every seat a bot, people only watching) runs at full speed: no "thinking"
 * pause, and every animation and pause plays at this fraction of its normal length.
 */
export const BOT_BATTLE_TEMPO = 0.4;

/** How many people can watch a lobby's games without a seat. */
export const MAX_SPECTATORS = 4;
/** Seats the biggest board has. A lobby has as many seats as its board (4, 5 or 6). */
export const MAX_SEATS = 6;
/** Everyone a lobby's voice chat must carry at once: every seat and every spectator. */
export const MAX_VOICE_PEERS = MAX_SEATS + MAX_SPECTATORS;

export type Controller = 'human' | 'bot' | 'takeover';

export interface Seat {
  color: Color;
  userId: number | null;
  username: string;
  /** The player's avatar id (shared/avatars.ts); absent or '' shows their initial. */
  avatar?: string;
  controller: Controller;
  connected: boolean;
  /** Consecutive missed turns; MAX_MISSED_TURNS hands the seat to a takeover bot. */
  timeouts: number;
}

export type TurnPhase = 'rolling' | 'moving';

export interface Turn {
  /** Index into GameState.seats. */
  seat: number;
  phase: TurnPhase;
  /** Rolled dice not yet spent, in roll order. */
  queue: number[];
  /** Sixes rolled in the current rolling sequence. */
  sixes: number;
  /** Bonus rolls earned by captures and by tokens reaching home, granted once the queue is spent. */
  bonus: number;
  /** Epoch ms when the server will act for this seat; 0 while the server is already playing it. */
  deadline: number;
  /** The player's timer ran out, so the server plays the rest of this turn for them. */
  auto: boolean;
}

export interface GameState {
  id: string;
  lobbyId: string;
  version: number;
  seats: Seat[];
  /** Progress per token, indexed by token id 0..3. See board.ts for the scale. */
  tokens: Record<Color, number[]>;
  turn: Turn;
  /** Colours in finishing order. */
  ranks: Color[];
  finished: boolean;
  createdAt: number;
  /** True once anyone has captured: the first capture of a game is "first blood". Games saved before this existed lack it. */
  firstBlood?: boolean;
  /** Per-player match stats for the results screen, counted by the rules engine. */
  stats?: Partial<Record<Color, PlayerStats>>;
  /** Captures made by each token since it last left base; its moustache grows with them (heft.ts). */
  kills?: Partial<Record<Color, number[]>>;
  /** Every seat was a bot when the game started: it plays at BOT_BATTLE_TEMPO. */
  botBattle?: boolean;
  /** Players who gave up, in the order they did. They're skipped, and rank below everyone still playing. */
  surrendered?: Color[];
  /**
   * The one extra lap each token gets (0 or 1): going round again past its home turn, or a
   * wildcard entry from home back to base. Given back if it is captured on that second lap.
   */
  extraLaps?: Partial<Record<Color, number[]>>;
  /** Team-up: diagonal partners (TEAMMATE) play together and win together. */
  teams?: boolean;
  /** The 5- or 6-player board; absent means the 4-player one (and every game saved before the others existed). */
  board?: 5 | 6;
}

/** How fast a game's animations and pauses run: 1 normally, faster in a bot battle. */
export function tempoOf(state: Pick<GameState, 'botBattle'>): number {
  return state.botBattle ? BOT_BATTLE_TEMPO : 1;
}

export interface PlayerStats {
  /** Squares moved in total (leaving base counts as one). */
  cells: number;
  /** Opponent tokens sent back to base. */
  captures: number;
  /** Sixes rolled, including ones lost to the three-sixes penalty. */
  sixes: number;
  /** Captures of a player who had captured you and you hadn't paid back yet. */
  revenges: number;
  /** Tokens brought home while wearing a moustache (with at least one capture). Missing in older games. */
  machoHome?: number;
  /** Clean-shaven tokens that grew a moustache (made their first capture since leaving base); fewest wins "Baby face". Missing in older games. */
  staches?: number;
  /** Every arrival home: a token sent back by a wildcard entry that gets home again counts twice. */
  homeRuns?: number;
  /** Risks taken, for "Balls of steel": laps taken round again plus wildcard entries. */
  risks?: number;
  /** Team-up: teammates' tokens captured, for "Backstabber". Not counted as captures. */
  friendlyFire?: number;
  firstBlood: boolean;
  /** Captures each opponent has made on you that you haven't avenged yet. */
  owed: Partial<Record<Color, number>>;
}

export interface LegalMove {
  dieIndex: number;
  die: number;
  tokenId: number;
  from: number;
  to: number;
  /** Opponent tokens this move would send back to base. */
  captures: { color: Color; tokenId: number }[];
  /** Goes round the board a second time instead of turning into the home column. */
  lap?: true;
}

export type GameEvent =
  | { type: 'roll'; color: Color; value: number; queue: number[] }
  | { type: 'penalty'; color: Color; queue: number[] }
  /** `kills`: the moving token's captures so far, which set how heavily it hops. */
  | { type: 'move'; color: Color; tokenId: number; from: number; to: number; die: number; kills?: number }
  /** `friendly`: the victim is the capturer's teammate (Team-up): the capturer's moustache shrinks a level instead of growing. */
  | { type: 'capture'; color: Color; victim: Color; tokenId: number; from: number; firstBlood?: true; friendly?: true }
  | { type: 'home'; color: Color; tokenId: number }
  | { type: 'rank'; color: Color; rank: number }
  | { type: 'noMoves'; color: Color; discarded: number[] }
  | { type: 'bonus'; color: Color }
  | { type: 'turn'; color: Color }
  /** `from`: where each of their tokens was; the ones not home go back to base under a white flag. */
  | { type: 'surrender'; color: Color; from: number[] }
  /** A wildcard entry: these tokens go from home back to base. `unranked`: the place a finished player gave up for it. */
  | { type: 'respawn'; color: Color; tokenIds: number[]; unranked?: number }
  | { type: 'gameOver'; ranks: Color[] };

/** Snapshot sent to clients: the full public state plus the server's legal moves. */
export interface PublicGameState extends GameState {
  legalMoves: LegalMove[];
  serverNow: number;
}

export interface LobbyMember {
  color: Color;
  userId: number | null;
  username: string;
  avatar?: string;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  /** Games this player has won (humans only), shown beside the name. Filled in when the lobby is sent. */
  wins?: number;
}

/** Someone in a lobby without a seat: they watch its games (and are in its voice chat). */
export interface LobbySpectator {
  userId: number;
  username: string;
  avatar?: string;
  connected: boolean;
  wins?: number;
}

export type LobbyStatus = 'waiting' | 'playing';

/**
 * Voice quality steps (kbps) for the per-lobby setting, each double the last. 6 is the floor:
 * browsers refuse an Opus cap below 6 kbps.
 */
export const VOICE_BITRATES = [6, 12, 24, 48] as const;
/** New lobbies start at the lowest step: least mobile data, and speech stays clear. The host can raise it. */
export const DEFAULT_VOICE_BITRATE = 6;

/** Who is in a lobby's voice channel. Shared with every member of the lobby. */
export interface VoiceState {
  lobbyId: string;
  /** False while the host has turned voice chat off for the lobby. */
  enabled: boolean;
  /** Bumped when the host restarts the channel; every member then reconnects from scratch. */
  epoch: number;
  bitrateKbps: number;
  /** `sfu`: connected to the built-in voice server, so it carries their voice to everyone else who is. */
  participants: { userId: number; muted: boolean; sfu?: boolean }[];
}

/** One receive slot on a phone's voice-server connection: whose voice its track (by mid) carries. */
export interface VoiceSlot {
  mid: string;
  userId: number | null;
}

/** How long a colour-swap request waits for an answer. */
export const SWAP_REQUEST_MS = 20_000;

/** One player asking another to swap seat colours in the lobby. */
export interface SwapRequest {
  lobbyId: string;
  from: number;
  fromName: string;
  to: number;
  /** The asker's colour now; the one the other player would get. */
  fromColor: Color;
  /** The other player's colour now; the one the asker wants. */
  toColor: Color;
  expiresAt: number;
}

export type SwapEnd = 'accepted' | 'declined' | 'cancelled' | 'expired';

export interface PublicLobby {
  id: string;
  name: string;
  hostId: number;
  status: LobbyStatus;
  members: LobbyMember[];
  spectators: LobbySpectator[];
  gameId: string | null;
  /** Team-up: the next game is 2v2, diagonal partners. */
  teams: boolean;
  /** Seats, and so the board the next game is played on. */
  size: BoardSize;
}

export interface LobbySummary {
  id: string;
  name: string;
  hostName: string;
  status: LobbyStatus;
  /** Seats taken (players and bots). */
  players: number;
  /** People watching without a seat. */
  watching: number;
  /** Team-up lobby. */
  teams: boolean;
  /** Seats (the board): 4, 5 or 6. */
  size: BoardSize;
}

/** What the admin panel shows per lobby. */
export interface AdminLobby extends LobbySummary {
  createdAt: number;
  members: { username: string; isBot: boolean; connected: boolean; watching?: boolean }[];
}
