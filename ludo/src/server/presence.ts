import type { OnlineDevice, OnlineUser, OnlineWhere } from '../shared/types.js';
import { describeDevice, type ClientHints } from './device.js';

interface Connection {
  userId: number;
  sessionId: number;
  userAgent: string;
  ip: string;
  since: number;
  hints?: ClientHints;
}

export interface PresenceOptions {
  /** The player's name, avatar and whether they show their phones; undefined for a deleted user. */
  userOf: (userId: number) => { username: string; avatar: string; showDevice: boolean } | undefined;
  /** Where the player is (a lobby, a game, watching, or home). */
  whereOf: (userId: number) => OnlineWhere;
  /** The ISP for an address ('' when unknown). */
  ispOf: (ip: string) => string;
  now?: () => number;
}

/**
 * Who is online, for the Users tab: every open connection with the phone it comes from. A player
 * with two phones shows both; two connections from one signed-in phone (a reload) count once.
 */
export class Presence {
  private conns = new Map<string, Connection>();
  private readonly now: () => number;

  constructor(private opts: PresenceOptions) {
    this.now = opts.now ?? Date.now;
  }

  add(socketId: string, c: { userId: number; sessionId: number; userAgent: string; ip: string }): void {
    this.conns.set(socketId, { ...c, since: this.now() });
  }

  /** What the phone said about itself (client hints); replaces what it said before. */
  setHints(socketId: string, hints: ClientHints): void {
    const c = this.conns.get(socketId);
    if (c) c.hints = hints;
  }

  remove(socketId: string): void {
    this.conns.delete(socketId);
  }

  isOnline(userId: number): boolean {
    for (const c of this.conns.values()) if (c.userId === userId) return true;
    return false;
  }

  /** Everyone online, longest online first. Phones are left out for players who hide them. */
  list(): OnlineUser[] {
    const byUser = new Map<number, Connection[]>();
    for (const c of this.conns.values()) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
    const out: OnlineUser[] = [];
    for (const [id, conns] of byUser) {
      const user = this.opts.userOf(id);
      if (!user) continue;
      const entry: OnlineUser = {
        id,
        username: user.username,
        ...(user.avatar ? { avatar: user.avatar } : {}),
        since: Math.min(...conns.map((c) => c.since)),
        where: this.opts.whereOf(id),
      };
      if (user.showDevice) entry.devices = this.devicesOf(conns);
      else entry.hidden = true;
      out.push(entry);
    }
    return out.sort((a, b) => a.since - b.since || a.id - b.id);
  }

  /** One per signed-in phone (session): its newest connection, which has the freshest hints. */
  private devicesOf(conns: Connection[]): OnlineDevice[] {
    const bySession = new Map<number, Connection>();
    for (const c of conns) {
      const prev = bySession.get(c.sessionId);
      if (!prev || c.since >= prev.since || (!prev.hints && c.hints)) bySession.set(c.sessionId, c);
    }
    return [...bySession.values()].map((c) => ({ ...describeDevice(c.userAgent, c.hints), isp: this.opts.ispOf(c.ip) }));
  }
}
