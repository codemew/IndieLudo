import type { Config } from './config.js';
import type { DB } from './db.js';
import type { GameManager } from './gameManager.js';
import type { Gate } from './gate.js';
import type { CreateAccess } from './hosts.js';
import type { MatchHistory } from './history.js';
import type { LobbyManager } from './lobbies.js';
import type { NetStatsTracker } from './netStats.js';
import type { Presence } from './presence.js';
import type { DeviceService, SessionService } from './sessions.js';
import type { UserService } from './users.js';
import type { VoiceServer } from './sfu.js';
import type { VoiceManager } from './voice.js';

/** Services shared by the HTTP API, the admin routes and the socket layer. */
export interface Ctx {
  /** package.json version of the running server. */
  appVersion: string;
  config: Config;
  db: DB;
  users: UserService;
  devices: DeviceService;
  sessions: SessionService;
  /** The creation password and the accounts remembered as hosts. */
  hosts: CreateAccess;
  history: MatchHistory;
  gate: Gate;
  lobbies: LobbyManager;
  games: GameManager;
  voice: VoiceManager;
  /** The built-in voice server (UDP). */
  sfu: VoiceServer;
  net: NetStatsTracker;
  /** Who is online and on what phone (the Users tab). */
  presence: Presence;
  /** Sends everyone the online list soon, if it changed (a name, an avatar, a lobby, a phone). */
  refreshPresence: () => void;
  /** Disconnects the sockets of revoked sessions (wired up by the socket layer). */
  kickSessions: (sessionIds: number[]) => void;
  kickUser: (userId: number) => void;
}
