import crypto from 'node:crypto';
import type { RTCIceServerConfig } from '../shared/protocol.js';
import type { TurnConfig } from './config.js';

/**
 * A short-lived TURN login for one player, in the standard shared-secret scheme ("TURN REST
 * API", coturn's use-auth-secret): username = "<expiry>:<id>", password = HMAC-SHA1(secret,
 * username). The relay checks it with the same secret; the secret itself never leaves the server.
 */
export function turnLogin(turn: TurnConfig, userId: number, now = Date.now()): RTCIceServerConfig {
  const expiry = Math.floor(now / 1000) + (turn.ttlSec ?? 12 * 3600);
  const username = `${expiry}:ludo${userId}`;
  const credential = crypto.createHmac('sha1', turn.secret).update(username).digest('base64');
  return { urls: turn.urls, username, credential };
}

/** Everything a player's phone needs to connect voice: the configured servers plus their relay login. */
export function iceServersFor(voice: { iceServers: RTCIceServerConfig[]; turn?: TurnConfig | null }, userId: number): RTCIceServerConfig[] {
  return voice.turn ? [...voice.iceServers, turnLogin(voice.turn, userId)] : voice.iceServers;
}
