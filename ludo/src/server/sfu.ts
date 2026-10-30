import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RTCRtpHeaderExtensionParameters, type RTCRtpTransceiver, type RtpPacket } from 'werift';
import { internetFirst, isLocalAddress, isLocalCandidate, rankCandidate, scrubRelated } from '../shared/ice.js';
import type { RTCIceServerConfig } from '../shared/protocol.js';
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
  /** Local-network routes allowed for this phone (it qualifies, or the internet route failed). */
  local: boolean;
}

export interface VoiceServerOptions {
  config: SfuConfig;
  /** STUN servers the server uses to find its own public address (voice.iceServers; TURN ones are skipped). */
  iceServers?: RTCIceServerConfig[];
  log?: (msg: string) => void;
  /** Tells a phone which receive slot (by mid) carries whose voice. */
  onSlots?: (lobbyId: string, userId: number, slots: VoiceSlot[]) => void;
  /** A phone's connection to the voice server came up or went down. */
  onLink?: (lobbyId: string, userId: number, connected: boolean) => void;
  /** The server dropped a phone's link (it broke or never connected): the phone should redo it now. */
  onGone?: (lobbyId: string, userId: number) => void;
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
  /** The public address internet phones reach this server at, learnt from how they connect (see learnPublicAddress). */
  private learnt: string | null = null;

  constructor(private opts: VoiceServerOptions) {}

  get enabled(): boolean {
    return this.opts.config.enabled;
  }

  /** The address announced to phones for the internet route: the configured one, or the one learnt. */
  get publicAddress(): string | null {
    return this.opts.config.announcedIp || this.learnt;
  }

  /**
   * The public IPv4 address a phone on the internet used to reach the game server (the Host it
   * connected to, resolved). With the router forwarding the voice ports too, that is where
   * internet phones reach the voice server, more reliably than what a STUN server reports.
   */
  learnPublicAddress(address: string): void {
    if (!isLocalAddress(address) && /^\d+\.\d+\.\d+\.\d+$/.test(address) && address !== this.learnt) {
      this.learnt = address;
      this.opts.log?.(`[voice] internet phones reach this server at ${address}`);
    }
  }

  /**
   * A phone (re)joins: any older connection of theirs is replaced. Returns the server's offer
   * (its candidates included) and the slot map. Routes go internet first; without `local`, the
   * local-network ones are left out both ways, so only the internet route can connect.
   */
  async join(lobbyId: string, userId: number, opts: { local?: boolean } = {}): Promise<{ sdp: string; slots: VoiceSlot[] }> {
    if (!this.enabled) throw new AppError('SFU_OFF', 409);
    this.leave(lobbyId, userId);
    const { portMin, portMax } = this.opts.config;
    const announced = this.publicAddress;
    const stun = (this.opts.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => /^stun:/i.test(u));
    const pc = new RTCPeerConnection({
      codecs: CODECS,
      headerExtensions: HEADER_EXTENSIONS,
      bundlePolicy: 'max-bundle',
      iceServers: stun.map((urls) => ({ urls })),
      icePortRange: [portMin, portMax],
      iceAdditionalHostAddresses: announced ? [announced] : undefined,
      iceUseLinkLocalAddress: false,
    });
    const room = this.room(lobbyId);
    const member: Member = { userId, pc, slots: [], connected: false, timer: null, local: Boolean(opts.local) };
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
        if (s !== 'disconnected') this.drop(lobbyId, userId);
      }
    });
    room.set(userId, member);
    member.timer = setTimeout(() => !member.connected && this.drop(lobbyId, userId), CONNECT_TIMEOUT_MS);
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
    return { sdp: internetFirst(pc.localDescription!.sdp, member.local), slots: this.slotsOf(member) };
  }

  async answer(lobbyId: string, userId: number, sdp: string): Promise<void> {
    const member = this.rooms.get(lobbyId)?.get(userId);
    if (!member) throw new AppError('NOT_IN_VOICE', 409);
    if (member.pc.signalingState !== 'have-local-offer') throw new AppError('SFU_STATE', 409);
    await member.pc.setRemoteDescription({ type: 'answer', sdp: internetFirst(sdp, member.local) });
  }

  /** The phone's late ICE candidates (optional: the server also learns them from its checks). */
  async candidate(lobbyId: string, userId: number, candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void> {
    const member = this.rooms.get(lobbyId)?.get(userId);
    if (!member?.pc.remoteDescription) return;
    if (!member.local && isLocalCandidate(candidate.candidate)) return;
    await member.pc.addIceCandidate({ ...candidate, candidate: rankCandidate(member.local ? candidate.candidate : scrubRelated(candidate.candidate)) } as never).catch(() => {});
  }

  /** Whether this phone's link allows local-network routes. */
  allowsLocal(lobbyId: string, userId: number): boolean {
    return Boolean(this.rooms.get(lobbyId)?.get(userId)?.local);
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

  /** The link broke on the server's side: drop it and tell the phone, which reconnects at once. */
  drop(lobbyId: string, userId: number): void {
    if (!this.rooms.get(lobbyId)?.has(userId)) return;
    this.leave(lobbyId, userId);
    this.opts.onGone?.(lobbyId, userId);
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
