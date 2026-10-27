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
  /** True when the user is a human member of this lobby. Bots never are. */
  isMember: (lobbyId: string, userId: number) => boolean;
  onChange?: (state: VoiceState) => void;
}

/**
 * One voice channel per lobby, kept for the lobby's whole life: waiting room, matches and
 * results. Audio flows peer to peer (WebRTC); the server only tracks who is in each channel,
 * their self-reported mute state and the shared quality setting, and relays offers/answers.
 */
export class VoiceManager {
  private channels = new Map<string, Channel>();

  constructor(private opts: VoiceManagerOptions) {}

  state(lobbyId: string): VoiceState {
    const ch = this.channels.get(lobbyId);
    return {
      lobbyId,
      bitrateKbps: ch?.bitrateKbps ?? DEFAULT_VOICE_BITRATE,
      participants: ch ? [...ch.members].map(([userId, m]) => ({ userId, muted: m.muted })) : [],
    };
  }

  /** The channel state, for members of the lobby only. */
  stateFor(lobbyId: string, userId: number): VoiceState {
    this.requirePlayer(lobbyId, userId);
    return this.state(lobbyId);
  }

  private channel(lobbyId: string): Channel {
    let ch = this.channels.get(lobbyId);
    if (!ch) {
      ch = { bitrateKbps: DEFAULT_VOICE_BITRATE, members: new Map() };
      this.channels.set(lobbyId, ch);
    }
    return ch;
  }

  private requirePlayer(lobbyId: string, userId: number): void {
    if (!this.opts.isMember(lobbyId, userId)) throw new AppError('NOT_IN_LOBBY', 403);
  }

  join(lobbyId: string, userId: number, socketId: string): VoiceState {
    this.requirePlayer(lobbyId, userId);
    const ch = this.channel(lobbyId);
    const existing = ch.members.get(userId);
    ch.members.set(userId, { muted: existing?.muted ?? false, socketId });
    return this.changed(lobbyId);
  }

  leave(lobbyId: string, userId: number): void {
    const ch = this.channels.get(lobbyId);
    if (!ch?.members.delete(userId)) return;
    this.changed(lobbyId);
  }

  setMuted(lobbyId: string, userId: number, muted: boolean): void {
    const member = this.channels.get(lobbyId)?.members.get(userId);
    if (!member) throw new AppError('NOT_IN_VOICE', 409);
    if (member.muted === muted) return;
    member.muted = muted;
    this.changed(lobbyId);
  }

  /** Any member of the lobby may change the quality. */
  setBitrate(lobbyId: string, userId: number, kbps: number): void {
    this.requirePlayer(lobbyId, userId);
    if (!(VOICE_BITRATES as readonly number[]).includes(kbps)) throw new AppError('INVALID_BITRATE');
    const ch = this.channel(lobbyId);
    if (ch.bitrateKbps === kbps) return;
    ch.bitrateKbps = kbps;
    this.changed(lobbyId);
  }

  /** Socket to forward a signal to, or an error unless both ends are in the channel. */
  relayTarget(lobbyId: string, from: number, to: number): string {
    const ch = this.channels.get(lobbyId);
    const target = ch?.members.get(to);
    if (!ch?.members.has(from) || !target || from === to) throw new AppError('NOT_IN_VOICE', 409);
    return target.socketId;
  }

  /** A socket went away: its user leaves every channel it joined through that socket. */
  dropSocket(socketId: string): void {
    for (const [lobbyId, ch] of this.channels) {
      for (const [userId, m] of ch.members) {
        if (m.socketId === socketId) {
          ch.members.delete(userId);
          this.changed(lobbyId);
        }
      }
    }
  }

  /** The lobby closed. */
  close(lobbyId: string): void {
    const ch = this.channels.get(lobbyId);
    if (!ch) return;
    this.channels.delete(lobbyId);
    if (ch.members.size) this.opts.onChange?.(this.state(lobbyId));
  }

  private changed(lobbyId: string): VoiceState {
    const ch = this.channels.get(lobbyId);
    const state = this.state(lobbyId);
    // Forget empty channels, but keep a non-default quality choice for the lobby.
    if (ch && ch.members.size === 0 && ch.bitrateKbps === DEFAULT_VOICE_BITRATE) this.channels.delete(lobbyId);
    this.opts.onChange?.(state);
    return state;
  }
}
