export type Color = 'red' | 'green' | 'yellow' | 'blue';

/** Clockwise turn order; also the order seats are stored in a game. */
export const COLORS: readonly Color[] = ['red', 'green', 'yellow', 'blue'];

/** Consecutive turns a player may miss (timer ran out) before a bot takes the seat. */
/** How long every phone shows the "first blood" banner; the server waits this out before bots and timers carry on. */
export const FIRST_BLOOD_MS = 1800;
export const MAX_MISSED_TURNS = 5;

export type Controller = 'human' | 'bot' | 'takeover';

export interface Seat {
  color: Color;
  userId: number | null;
  username: string;
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
}

export type GameEvent =
  | { type: 'roll'; color: Color; value: number; queue: number[] }
  | { type: 'penalty'; color: Color; queue: number[] }
  | { type: 'move'; color: Color; tokenId: number; from: number; to: number; die: number }
  | { type: 'capture'; color: Color; victim: Color; tokenId: number; from: number; firstBlood?: true }
  | { type: 'home'; color: Color; tokenId: number }
  | { type: 'rank'; color: Color; rank: number }
  | { type: 'noMoves'; color: Color; discarded: number[] }
  | { type: 'bonus'; color: Color }
  | { type: 'turn'; color: Color }
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
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  /** Games this player has won (humans only), shown beside the name. Filled in when the lobby is sent. */
  wins?: number;
}

export type LobbyStatus = 'waiting' | 'playing';

/**
 * Voice quality steps (kbps) for the per-lobby setting, each double the last. 6 is the floor:
 * browsers refuse an Opus cap below 6 kbps.
 */
export const VOICE_BITRATES = [6, 12, 24, 48] as const;
export const DEFAULT_VOICE_BITRATE = 24;

/** Who is in a lobby's voice channel. Shared with every member of the lobby. */
export interface VoiceState {
  lobbyId: string;
  /** False while the host has turned voice chat off for the lobby. */
  enabled: boolean;
  /** Bumped when the host restarts the channel; every member then reconnects from scratch. */
  epoch: number;
  bitrateKbps: number;
  participants: { userId: number; muted: boolean }[];
}

export interface PublicLobby {
  id: string;
  name: string;
  hostId: number;
  status: LobbyStatus;
  members: LobbyMember[];
  gameId: string | null;
}

export interface LobbySummary {
  id: string;
  name: string;
  hostName: string;
  status: LobbyStatus;
  players: number;
}

/** What the admin panel shows per lobby. */
export interface AdminLobby extends LobbySummary {
  createdAt: number;
  members: { username: string; isBot: boolean; connected: boolean }[];
}
