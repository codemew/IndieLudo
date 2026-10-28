import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RTCRtpHeaderExtensionParameters, type RTCRtpTransceiver, type RtpPacket } from 'werift';
import { MAX_VOICE_PEERS, type VoiceSlot } from '../shared/types.js';
import type { SfuConfig } from './config.js';
import { AppError } from './errors.js';

/** Audio from everyone else in a full lobby: one receive slot per other person. */
export const SLOTS = MAX_VOICE_PEERS - 1;
/** One 20 ms Opus frame at 48 kHz: the timestamp step when a slot switches to another speaker. */
const FRAME_TICKS = 960;
/** A phone that hasn't connected by then is dropped (it asks again). */
const CONNECT_TIMEOUT_MS = 15_000;

const CODECS = {
  audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: 'minptime=10;useinbandfec=1;usedtx=1' })],
  video: [],
};
/**
 * Each packet carries its speaker's loudness (RFC 6464), set by the sending phone and passed on
 * untouched: the listening phones read it for the talking animation without decoding anything.
 */
const HEADER_EXTENSIONS = { audio: [new RTCRtpHeaderExtensionParameters({ id: 1, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' })], video: [] };

interface Slot {
  transceiver: RTCRtpTransceiver;
  track: MediaStreamTrack;
  /** Whose voice this slot carries, or null while free. */
  owner: number | null;
  /** The next packet starts a new speaker: keep sequence numbers and timestamps running on. */
  switched: boolean;
}

interface Member {
  userId: number;
  pc: RTCPeerConnection;
  slots: Slot[];
  connected: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface VoiceServerOptions {
  config: SfuConfig;
  log?: (msg: string) => void;
  /** Tells a phone which receive slot (by mid) carries whose voice. */
  onSlots?: (lobbyId: string, userId: number, slots: VoiceSlot[]) => void;
  /** A phone's connection to the voice server came up or went down. */
  onLink?: (lobbyId: string, userId: number, connected: boolean) => void;
}

/**
 * The built-in voice server (an SFU). Each phone in a lobby's voice chat has one WebRTC
 * connection to it, over UDP: the phone sends its microphone once, and gets everyone else's
 * voice back on fixed receive slots. So a phone uploads one stream however many people are
 * talking, every phone can reach it (it is the game server), and a reconnect is one connection.
 *
 * Audio is passed on as it comes: no decoding or mixing. A phone sends nothing while its owner
 * is quiet (the voice gate), so a silent channel costs nothing.
 */
export class VoiceServer {
  private rooms = new Map<string, Map<number, Member>>();

  constructor(private opts: VoiceServerOptions) {}

  get enabled(): boolean {
    return this.opts.config.enabled;
  }

  /**
   * A phone (re)joins: any older connection of theirs is replaced. Returns the server's offer
   * (its candidates included) and the slot map.
   */
  async join(lobbyId: string, userId: number): Promise<{ sdp: string; slots: VoiceSlot[] }> {
    if (!this.enabled) throw new AppError('SFU_OFF', 409);
    this.leave(lobbyId, userId);
    const { portMin, portMax, announcedIp } = this.opts.config;
    const pc = new RTCPeerConnection({
      codecs: CODECS,
      headerExtensions: HEADER_EXTENSIONS,
      bundlePolicy: 'max-bundle',
      icePortRange: [portMin, portMax],
      iceAdditionalHostAddresses: announcedIp ? [announcedIp] : undefined,
      iceUseLinkLocalAddress: false,
    });
    const room = this.room(lobbyId);
    const member: Member = { userId, pc, slots: [], connected: false, timer: null };
    const mic = pc.addTransceiver('audio', { direction: 'recvonly' });
    mic.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => this.forward(lobbyId, member, rtp)));
    for (let i = 0; i < SLOTS; i++) {
      const track = new MediaStreamTrack({ kind: 'audio' });
      member.slots.push({ transceiver: pc.addTransceiver(track, { direction: 'sendonly' }), track, owner: null, switched: false });
    }
    pc.connectionStateChange.subscribe((s) => {
      if (room.get(userId) !== member) return;
      const up = s === 'connected';
      if (up === member.connected && s !== 'failed' && s !== 'closed') return;
      if (up) {
        member.connected = true;
        if (member.timer) clearTimeout(member.timer);
        member.timer = null;
        this.opts.onLink?.(lobbyId, userId, true);
      } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        if (member.connected) this.opts.onLink?.(lobbyId, userId, false);
        member.connected = false;
        if (s !== 'disconnected') this.leave(lobbyId, userId);
      }
    });
    room.set(userId, member);
    member.timer = setTimeout(() => !member.connected && this.leave(lobbyId, userId), CONNECT_TIMEOUT_MS);
    member.timer.unref?.();
    // Everyone already here gets a slot for the newcomer, and the newcomer one for each of them.
    for (const other of room.values()) {
      if (other === member) continue;
      this.give(member, other.userId);
      if (this.give(other, userId)) this.sendSlots(lobbyId, other);
    }
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const sub = pc.iceGatheringStateChange.subscribe((s) => s === 'complete' && (sub.unSubscribe(), resolve()));
      });
    }
    if (room.get(userId) !== member) throw new AppError('SFU_REPLACED', 409);
    return { sdp: pc.localDescription!.sdp, slots: this.slotsOf(member) };
  }

  async answer(lobbyId: string, userId: number, sdp: string): Promise<void> {
    const member = this.rooms.get(lobbyId)?.get(userId);
    if (!member) throw new AppError('NOT_IN_VOICE', 409);
    if (member.pc.signalingState !== 'have-local-offer') throw new AppError('SFU_STATE', 409);
    await member.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** The phone's late ICE candidates (optional: the server also learns them from its checks). */
  async candidate(lobbyId: string, userId: number, candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void> {
    const member = this.rooms.get(lobbyId)?.get(userId);
    if (!member?.pc.remoteDescription) return;
    await member.pc.addIceCandidate(candidate as never).catch(() => {});
  }

  isConnected(lobbyId: string, userId: number): boolean {
    return Boolean(this.rooms.get(lobbyId)?.get(userId)?.connected);
  }

  leave(lobbyId: string, userId: number): void {
    const room = this.rooms.get(lobbyId);
    const member = room?.get(userId);
    if (!room || !member) return;
    room.delete(userId);
    if (member.timer) clearTimeout(member.timer);
    void member.pc.close().catch(() => {});
    if (member.connected) this.opts.onLink?.(lobbyId, userId, false);
    for (const other of room.values()) {
      const slot = other.slots.find((s) => s.owner === userId);
      if (!slot) continue;
      slot.owner = null;
      this.sendSlots(lobbyId, other);
    }
    if (room.size === 0) this.rooms.delete(lobbyId);
  }

  /** Follows the voice channel: those who left it (or a restart, or voice turned off) are dropped. */
  sync(lobbyId: string, participants: readonly number[]): void {
    const room = this.rooms.get(lobbyId);
    if (!room) return;
    for (const userId of [...room.keys()]) if (!participants.includes(userId)) this.leave(lobbyId, userId);
  }

  close(lobbyId: string): void {
    for (const userId of [...(this.rooms.get(lobbyId)?.keys() ?? [])]) this.leave(lobbyId, userId);
  }

  shutdown(): void {
    for (const lobbyId of [...this.rooms.keys()]) this.close(lobbyId);
  }

  /** Who is on each of this member's receive slots. */
  slotsOf(member: Member): VoiceSlot[] {
    return member.slots.map((s) => ({ mid: s.transceiver.mid ?? '', userId: s.owner }));
  }

  private room(lobbyId: string): Map<number, Member> {
    let room = this.rooms.get(lobbyId);
    if (!room) this.rooms.set(lobbyId, (room = new Map()));
    return room;
  }

  /** Puts `speaker` on a free slot of `member`. False if they already had one (or none is free). */
  private give(member: Member, speaker: number): boolean {
    if (member.slots.some((s) => s.owner === speaker)) return false;
    const slot = member.slots.find((s) => s.owner === null);
    if (!slot) return false;
    slot.owner = speaker;
    slot.switched = true;
    return true;
  }

  private sendSlots(lobbyId: string, member: Member): void {
    this.opts.onSlots?.(lobbyId, member.userId, this.slotsOf(member));
  }

  /** A packet of `from`'s voice: to the slot carrying them on everyone else's connection. */
  private forward(lobbyId: string, from: Member, rtp: RtpPacket): void {
    const room = this.rooms.get(lobbyId);
    if (!room || room.get(from.userId) !== from) return;
    for (const member of room.values()) {
      if (member === from || !member.connected) continue;
      const slot = member.slots.find((s) => s.owner === from.userId);
      if (!slot) continue;
      if (slot.switched) {
        slot.switched = false;
        slot.transceiver.sender.replaceRTP(rtp.header, false, FRAME_TICKS);
      }
      slot.track.writeRtp(rtp);
    }
  }
}
