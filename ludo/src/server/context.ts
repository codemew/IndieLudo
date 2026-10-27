import type { Config } from './config.js';
import type { DB } from './db.js';
import type { GameManager } from './gameManager.js';
import type { Gate } from './gate.js';
import type { LobbyManager } from './lobbies.js';
import type { DeviceService, SessionService } from './sessions.js';
import type { UserService } from './users.js';

/** Services shared by the HTTP API, the admin routes and the socket layer. */
export interface Ctx {
  config: Config;
  db: DB;
  users: UserService;
  devices: DeviceService;
  sessions: SessionService;
  gate: Gate;
  lobbies: LobbyManager;
  games: GameManager;
  /** Disconnects the sockets of revoked sessions (wired up by the socket layer). */
  kickSessions: (sessionIds: number[]) => void;
  kickUser: (userId: number) => void;
}
