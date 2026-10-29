import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, type VoiceState } from '../shared/types.js';
import { AppError } from './errors.js';

interface Member {
  muted: boolean;
  /** Connected to the built-in voice server. */
  sfu: boolean;
  /** The socket that joined; signals for this member go only there. */
  socketId: string;
}

interface Channel {
  enabled: boolean;
  epoch: number;
  bitrateKbps: number;
  members: Map<number, Member>;
}

export interface VoiceManagerOptions {
  /** True when the user is a human member of this lobby. Bots never are. */
  isMember: (lobbyId: string, userId: number) => boolean;
  /** True when the user hosts this lobby: only the host can change settings or restart the channel. */
  isHost: (lobbyId: string, userId: number) => boolean;
  onChange?: (state: VoiceState) => void;
}

/**
 * One voice channel per lobby, kept for the lobby's whole life: waiting room, matches and
 * results. Audio flows peer to peer (WebRTC); the server only tracks who is in each channel,
 * their self-reported mute state and the host's settings, and relays signalling.
 */
export class VoiceManager {
  private channels = new Map<string, Channel>();

  constructor(private opts: VoiceManagerOptions) {}

  state(lobbyId: string): VoiceState {
    const ch = this.channels.get(lobbyId);
    return {
      lobbyId,
      enabled: ch?.enabled ?? true,
      epoch: ch?.epoch ?? 0,
      bitrateKbps: ch?.bitrateKbps ?? DEFAULT_VOICE_BITRATE,
      participants: ch ? [...ch.members].map(([userId, m]) => ({ userId, muted: m.muted, ...(m.sfu && { sfu: true }) })) : [],
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
      ch = { enabled: true, epoch: 0, bitrateKbps: DEFAULT_VOICE_BITRATE, members: new Map() };
      this.channels.set(lobbyId, ch);
    }
    return ch;
  }

  private requirePlayer(lobbyId: string, userId: number): void {
    if (!this.opts.isMember(lobbyId, userId)) throw new AppError('NOT_IN_LOBBY', 403);
  }

  private requireHost(lobbyId: string, userId: number): void {
    this.requirePlayer(lobbyId, userId);
    if (!this.opts.isHost(lobbyId, userId)) throw new AppError('NOT_HOST', 403);
  }

  /** While the host has voice turned off this only returns the state (enabled: false). */
  join(lobbyId: string, userId: number, socketId: string): VoiceState {
    this.requirePlayer(lobbyId, userId);
    const ch = this.channel(lobbyId);
    if (!ch.enabled) return this.state(lobbyId);
    const existing = ch.members.get(userId);
    // A rejoin (network change, reconnect) keeps the voice-server flag until that link itself
    // changes, so the others don't start dialling directly while this phone reconnects.
    ch.members.set(userId, { muted: existing?.muted ?? false, sfu: existing?.sfu ?? false, socketId });
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

  /** Only the host may change the quality. */
  setBitrate(lobbyId: string, userId: number, kbps: number): void {
    this.requireHost(lobbyId, userId);
    if (!(VOICE_BITRATES as readonly number[]).includes(kbps)) throw new AppError('INVALID_BITRATE');
    const ch = this.channel(lobbyId);
    if (ch.bitrateKbps === kbps) return;
    ch.bitrateKbps = kbps;
    this.changed(lobbyId);
  }

  /** Host only: turning voice off empties the channel; turning it on lets everyone rejoin. */
  setEnabled(lobbyId: string, userId: number, enabled: boolean): void {
    this.requireHost(lobbyId, userId);
    const ch = this.channel(lobbyId);
    if (ch.enabled === enabled) return;
    ch.enabled = enabled;
    ch.members.clear();
    this.changed(lobbyId);
  }

  /**
   * Host only: empties the channel and bumps its epoch. Every member's phone sees the new
   * epoch, drops all its connections and joins again from scratch.
   */
  reboot(lobbyId: string, userId: number): void {
    this.requireHost(lobbyId, userId);
    const ch = this.channel(lobbyId);
    if (!ch.enabled) throw new AppError('VOICE_DISABLED', 409);
    ch.epoch++;
    ch.members.clear();
    this.changed(lobbyId);
  }

  /** True while the user is in the lobby's voice channel. */
  isIn(lobbyId: string, userId: number): boolean {
    return Boolean(this.channels.get(lobbyId)?.members.has(userId));
  }

  /** Their voice-server connection came up or went down. */
  setSfu(lobbyId: string, userId: number, sfu: boolean): void {
    const member = this.channels.get(lobbyId)?.members.get(userId);
    if (!member || member.sfu === sfu) return;
    member.sfu = sfu;
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

  /** Channels (and their settings) live until the lobby closes. */
  private changed(lobbyId: string): VoiceState {
    const state = this.state(lobbyId);
    this.opts.onChange?.(state);
    return state;
  }
}
