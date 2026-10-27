import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, type VoiceState } from '../shared/types.js';
import { AppError } from './errors.js';

interface Member {
  muted: boolean;
  /** The socket that joined; signals for this member go only there. */
  socketId: string;
}

interface Channel {
  bitrateKbps: number;
  members: Map<number, Member>;
}

export interface VoiceManagerOptions {
  /** True when the user is a human player seated in this (running) game. Bots never are. */
  isPlayer: (gameId: string, userId: number) => boolean;
  onChange?: (state: VoiceState) => void;
}

/**
 * Per-game voice channels. Audio flows peer to peer (WebRTC); the server only tracks who is
 * in each channel, their self-reported mute state and the shared quality setting, and relays
 * offers/answers between members.
 */
export class VoiceManager {
  private channels = new Map<string, Channel>();

  constructor(private opts: VoiceManagerOptions) {}

  state(gameId: string): VoiceState {
    const ch = this.channels.get(gameId);
    return {
      gameId,
      bitrateKbps: ch?.bitrateKbps ?? DEFAULT_VOICE_BITRATE,
      participants: ch ? [...ch.members].map(([userId, m]) => ({ userId, muted: m.muted })) : [],
    };
  }

  /** The channel state, for players of the game only. */
  stateFor(gameId: string, userId: number): VoiceState {
    this.requirePlayer(gameId, userId);
    return this.state(gameId);
  }

  private channel(gameId: string): Channel {
    let ch = this.channels.get(gameId);
    if (!ch) {
      ch = { bitrateKbps: DEFAULT_VOICE_BITRATE, members: new Map() };
      this.channels.set(gameId, ch);
    }
    return ch;
  }

  private requirePlayer(gameId: string, userId: number): void {
    if (!this.opts.isPlayer(gameId, userId)) throw new AppError('NOT_IN_GAME', 403);
  }

  join(gameId: string, userId: number, socketId: string): VoiceState {
    this.requirePlayer(gameId, userId);
    const ch = this.channel(gameId);
    const existing = ch.members.get(userId);
    ch.members.set(userId, { muted: existing?.muted ?? false, socketId });
    return this.changed(gameId);
  }

  leave(gameId: string, userId: number): void {
    const ch = this.channels.get(gameId);
    if (!ch?.members.delete(userId)) return;
    this.changed(gameId);
  }

  setMuted(gameId: string, userId: number, muted: boolean): void {
    const member = this.channels.get(gameId)?.members.get(userId);
    if (!member) throw new AppError('NOT_IN_VOICE', 409);
    if (member.muted === muted) return;
    member.muted = muted;
    this.changed(gameId);
  }

  /** Any player in the game may change the quality, joined to voice or not. */
  setBitrate(gameId: string, userId: number, kbps: number): void {
    this.requirePlayer(gameId, userId);
    if (!(VOICE_BITRATES as readonly number[]).includes(kbps)) throw new AppError('INVALID_BITRATE');
    const ch = this.channel(gameId);
    if (ch.bitrateKbps === kbps) return;
    ch.bitrateKbps = kbps;
    this.changed(gameId);
  }

  /** Socket to forward a signal to, or an error unless both ends are in the channel. */
  relayTarget(gameId: string, from: number, to: number): string {
    const ch = this.channels.get(gameId);
    const target = ch?.members.get(to);
    if (!ch?.members.has(from) || !target || from === to) throw new AppError('NOT_IN_VOICE', 409);
    return target.socketId;
  }

  /** A socket went away: its user leaves every channel it joined through that socket. */
  dropSocket(socketId: string): void {
    for (const [gameId, ch] of this.channels) {
      for (const [userId, m] of ch.members) {
        if (m.socketId === socketId) {
          ch.members.delete(userId);
          this.changed(gameId);
        }
      }
    }
  }

  /** The game ended or was abandoned. */
  close(gameId: string): void {
    const ch = this.channels.get(gameId);
    if (!ch) return;
    this.channels.delete(gameId);
    if (ch.members.size) this.opts.onChange?.(this.state(gameId));
  }

  private changed(gameId: string): VoiceState {
    const ch = this.channels.get(gameId);
    const state = this.state(gameId);
    // Forget empty channels, but keep a non-default quality choice for the game.
    if (ch && ch.members.size === 0 && ch.bitrateKbps === DEFAULT_VOICE_BITRATE) this.channels.delete(gameId);
    this.opts.onChange?.(state);
    return state;
  }
}
