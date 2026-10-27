import type { RTCIceServerConfig, VoiceJoined, VoiceSignalIn, VoiceSignalKind } from '../shared/protocol.js';
import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, type VoiceState } from '../shared/types.js';
import { emit } from './net.js';

export type PeerStatus = 'connecting' | 'connected' | 'failed';

const MAX_KBPS = VOICE_BITRATES[VOICE_BITRATES.length - 1];
const ICE_GATHER_TIMEOUT_MS = 3000;
/** How often the watchdog checks every link. */
const WATCHDOG_MS = 2000;
/** A link that isn't connected after this long (or has failed for RETRY_MS) is redialled. */
const STALL_MS = 12_000;
const RETRY_MS = 1500;

/**
 * Lets the remote Opus encoder go up to `kbps` and turns on in-band FEC. The live quality
 * setting is applied separately per sender (setParameters), so it can change without
 * renegotiating; this only sets the ceiling.
 */
export function setOpusBitrate(sdp: string, kbps: number): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const bps = kbps * 1000;
  const lines = sdp.split('\r\n');
  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (fmtpIdx >= 0) {
    const params = new Map(
      lines[fmtpIdx]
        .slice(`a=fmtp:${pt} `.length)
        .split(';')
        .filter(Boolean)
        .map((kv) => kv.trim().split('=') as [string, string]),
    );
    params.set('maxaveragebitrate', String(bps));
    params.set('useinbandfec', '1');
    lines[fmtpIdx] = `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  } else {
    const rtpIdx = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    lines.splice(rtpIdx + 1, 0, `a=fmtp:${pt} maxaveragebitrate=${bps};useinbandfec=1`);
  }
  return lines.join('\r\n');
}

/** Resolves once ICE gathering is done (or after a cap), so one offer/answer carries every candidate. */
function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  status: PeerStatus;
  /** Ties an answer to our offer, or our answer to their offer. */
  call: number;
  /** When the link last stopped being connected (or was created). */
  since: number;
}

/**
 * Voice chat for one lobby: a full mesh of audio-only WebRTC connections (at most 3 peers).
 * Every lobby member is in it from joining the lobby until leaving it, through matches and
 * results, unless the host turns it off.
 *
 * Who dials whom is fixed: of each pair, the phone with the lower user id sends the offer and
 * the other only answers, or sends a "ring" to ask for a fresh offer. So two phones never
 * offer to each other at once. That used to happen when several phones reconnected together,
 * and left pairs that couldn't hear each other. A watchdog redials any link that stays down.
 */
class VoiceClient {
  /** The lobby whose channel we are in, or are joining. */
  lobbyId: string | null = null;
  joined = false;
  joining = false;
  muted = false;
  /** False when the microphone is blocked or missing: we still listen, and show as muted. */
  micAvailable = true;
  /** False while the host has turned voice chat off for this lobby. */
  enabled = true;
  /** Last reason joining failed (server side), so the UI can offer a retry. */
  error: string | null = null;
  bitrateKbps = DEFAULT_VOICE_BITRATE;
  /** Called with the channel state from a join reply (broadcasts reach the store directly). */
  onServerState: ((s: VoiceState) => void) | null = null;
  /** Called when the host restarts or toggles the channel, so the UI can say so. */
  onNotice: ((msg: string) => void) | null = null;
  private myId = 0;
  private epoch = 0;
  private others = new Set<number>();
  private stream: MediaStream | null = null;
  private iceServers: RTCIceServerConfig[] = [];
  private peers = new Map<number, Peer>();
  /** When we last rang each higher-id member, so a stuck link is rung at most once per STALL_MS. */
  private rangAt = new Map<number, number>();
  private seq = Math.floor(Math.random() * 1e9);
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private audioBox: HTMLElement | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    // A tap anywhere lets audio that the browser refused to autoplay start.
    document.addEventListener('pointerdown', () => this.resumeAudio(), { capture: true });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.check());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Muted by choice, or because there is no microphone to send. */
  get silent(): boolean {
    return this.muted || !this.micAvailable;
  }

  peerStatus(userId: number): PeerStatus | null {
    return this.peers.get(userId)?.status ?? null;
  }

  /** How many of the other members we have a working audio link with. */
  get linked(): { connected: number; total: number } {
    let connected = 0;
    for (const id of this.others) if (this.peers.get(id)?.status === 'connected') connected++;
    return { connected, total: this.others.size };
  }

  /** Joins the lobby's channel. Without a microphone we still join, listen-only. */
  async join(lobbyId: string, myId: number): Promise<string | null> {
    if ((this.joined && this.lobbyId === lobbyId) || this.joining) return null;
    if (this.joined) await this.leave();
    if (typeof RTCPeerConnection === 'undefined') {
      this.error = 'NO_MIC_SUPPORT';
      this.notify();
      return this.error;
    }
    this.lobbyId = lobbyId;
    this.myId = myId;
    this.joining = true;
    this.notify();
    try {
      if (this.enabled) await this.acquireMic();
      const r = await emit<VoiceJoined>('voice:join', { lobbyId });
      if (this.lobbyId !== lobbyId) {
        // Left the lobby while joining.
        if (r.ok) void emit('voice:leave', { lobbyId });
        return null;
      }
      if (!r.ok) {
        this.error = r.error;
        return r.error;
      }
      const state = r.data!.state;
      this.error = null;
      this.iceServers = r.data!.iceServers;
      this.bitrateKbps = state.bitrateKbps;
      this.epoch = state.epoch;
      this.enabled = state.enabled;
      this.onServerState?.(state);
      if (!state.enabled) {
        // The host has voice off: don't hold the microphone.
        this.stopStream();
        return null;
      }
      this.joined = true;
      this.applyMute();
      // The server remembers mute across rejoins; make it match what this phone is doing.
      const me = state.participants.find((p) => p.userId === myId);
      if (me && me.muted !== this.silent) void emit('voice:mute', { lobbyId, muted: this.silent });
      this.others = new Set(state.participants.map((p) => p.userId).filter((id) => id !== myId));
      for (const id of this.others) this.connect(id);
      this.startWatchdog();
      return null;
    } finally {
      this.joining = false;
      this.notify();
    }
  }

  private async acquireMic(): Promise<void> {
    if (this.stream?.getAudioTracks().some((t) => t.readyState === 'live')) return;
    this.stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micAvailable = false;
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      this.micAvailable = true;
    } catch {
      this.stream = null;
      this.micAvailable = false;
    }
  }

  /** From a tap after the microphone was blocked: ask again, then redial everyone with audio. */
  async retryMic(): Promise<boolean> {
    await this.acquireMic();
    this.notify();
    if (!this.micAvailable) return false;
    this.muted = false;
    if (this.lobbyId) await this.restart();
    return true;
  }

  /** "Rejoin voice": a fresh microphone and fresh connections to everyone. */
  async rejoin(): Promise<string | null> {
    if (!this.lobbyId || this.joining) return null;
    this.stopStream();
    this.resumeAudio();
    return this.restart();
  }

  async leave(tellServer = true): Promise<void> {
    const lobbyId = this.lobbyId;
    const wasJoined = this.joined;
    this.lobbyId = null;
    this.enabled = true;
    this.error = null;
    this.teardown();
    this.notify();
    if (tellServer && wasJoined && lobbyId) await emit('voice:leave', { lobbyId });
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.micAvailable) return;
    this.muted = muted;
    this.applyMute();
    this.notify();
    if (this.joined && this.lobbyId) await emit('voice:mute', { lobbyId: this.lobbyId, muted });
  }

  /** Host only (the server checks). */
  async setBitrate(lobbyId: string, kbps: number): Promise<string | null> {
    const r = await emit('voice:bitrate', { lobbyId, kbps });
    return r.ok ? null : r.error;
  }

  /** Host only: turn the lobby's voice chat off or back on. */
  async setEnabled(lobbyId: string, enabled: boolean): Promise<string | null> {
    const r = await emit('voice:enabled', { lobbyId, enabled });
    return r.ok ? null : r.error;
  }

  /** Host only: everyone drops their connections and joins again. */
  async reboot(lobbyId: string): Promise<string | null> {
    const r = await emit('voice:reboot', { lobbyId });
    return r.ok ? null : r.error;
  }

  /** Server's view of the channel: follow the host's settings, drop peers that left, redial newcomers. */
  onState(state: VoiceState): void {
    if (state.lobbyId !== this.lobbyId) return;
    if (state.bitrateKbps !== this.bitrateKbps) {
      this.bitrateKbps = state.bitrateKbps;
      for (const p of this.peers.values()) void this.applyBitrate(p.pc);
    }
    if (!state.enabled) {
      if (this.enabled) this.onNotice?.('The host turned voice chat off');
      this.enabled = false;
      this.teardown();
      this.notify();
      return;
    }
    if (!this.enabled) {
      this.enabled = true;
      this.onNotice?.('The host turned voice chat on');
    }
    if (this.joining) return;
    if (state.epoch !== this.epoch && this.joined) {
      this.onNotice?.('Voice chat restarted by the host');
      void this.restart();
      return;
    }
    // Not in the channel although we should be (voice turned back on, the host restarted it,
    // or the server dropped us): join again.
    if (!this.joined || !state.participants.some((p) => p.userId === this.myId)) {
      if (this.error !== 'NO_MIC_SUPPORT') void this.restart();
      return;
    }
    this.others = new Set(state.participants.map((p) => p.userId).filter((id) => id !== this.myId));
    for (const id of [...this.peers.keys()]) if (!this.others.has(id)) this.closePeer(id);
    this.notify();
  }

  async onSignal(sig: VoiceSignalIn): Promise<void> {
    if (!this.joined || sig.lobbyId !== this.lobbyId) return;
    if (sig.kind === 'ring') {
      // They (re)joined or lost us: dial them afresh. Only the lower id dials.
      if (this.myId < sig.from) {
        this.closePeer(sig.from);
        void this.call(sig.from);
      }
    } else if (sig.kind === 'offer') {
      if (this.myId < sig.from) return; // we are the dialler for this pair; they'll get our offer
      // A new offer always replaces whatever link we had with that player.
      this.closePeer(sig.from);
      const peer = this.createPeer(sig.from, sig.call);
      try {
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription({ type: 'answer', sdp: setOpusBitrate(answer.sdp ?? '', MAX_KBPS) });
        await iceGathered(peer.pc);
        if (this.peers.get(sig.from) === peer) this.signal(sig.from, 'answer', sig.call, peer.pc.localDescription!.sdp);
      } catch {
        this.markFailed(sig.from, peer);
      }
    } else {
      const peer = this.peers.get(sig.from);
      // Only the answer to our current offer; one to an offer we already gave up on is stale.
      if (!peer || peer.call !== sig.call || peer.pc.signalingState !== 'have-local-offer') return;
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      } catch {
        this.markFailed(sig.from, peer);
      }
    }
  }

  /** After a socket reconnect the server has dropped us from the channel: rejoin and re-call. */
  async onReconnect(): Promise<void> {
    if (this.lobbyId) await this.restart();
  }

  private async restart(): Promise<string | null> {
    const lobbyId = this.lobbyId;
    if (!lobbyId || this.joining) return null;
    this.joined = false;
    this.closeAllPeers();
    return this.join(lobbyId, this.myId);
  }

  /** Sets up the link with one member: dial them, or ask them to dial us. */
  private connect(userId: number): void {
    if (this.myId < userId) {
      this.closePeer(userId);
      void this.call(userId);
    } else {
      this.rangAt.set(userId, Date.now());
      this.signal(userId, 'ring', 0, '');
    }
  }

  private async call(userId: number): Promise<void> {
    const peer = this.createPeer(userId, ++this.seq);
    try {
      // Listen-only (no microphone): still ask to receive their audio.
      if (!this.stream) peer.pc.addTransceiver('audio', { direction: 'recvonly' });
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: setOpusBitrate(offer.sdp ?? '', MAX_KBPS) });
      await iceGathered(peer.pc);
      if (this.peers.get(userId) === peer) this.signal(userId, 'offer', peer.call, peer.pc.localDescription!.sdp);
    } catch {
      this.markFailed(userId, peer);
    }
  }

  private signal(to: number, kind: VoiceSignalKind, call: number, sdp: string): void {
    if (this.lobbyId) void emit('voice:signal', { lobbyId: this.lobbyId, to, kind, call, sdp });
  }

  private createPeer(userId: number, call: number): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    for (const track of this.stream?.getAudioTracks() ?? []) pc.addTrack(track, this.stream!);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    this.box().appendChild(audio);
    const peer: Peer = { pc, audio, status: 'connecting', call, since: Date.now() };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(userId) !== peer) return;
      const s = pc.connectionState;
      const status: PeerStatus = s === 'connected' ? 'connected' : s === 'failed' || s === 'closed' ? 'failed' : 'connecting';
      if (status !== 'connected' && peer.status === 'connected') peer.since = Date.now();
      if (status === 'failed' && peer.status !== 'failed') peer.since = Date.now();
      peer.status = status;
      if (status === 'connected') {
        void this.applyBitrate(pc);
        void audio.play().catch(() => {});
      }
      this.notify();
    };
    this.peers.set(userId, peer);
    void this.applyBitrate(pc);
    this.notify();
    return peer;
  }

  private markFailed(userId: number, peer: Peer): void {
    if (this.peers.get(userId) !== peer) return;
    peer.status = 'failed';
    peer.since = Date.now();
    this.notify();
  }

  private startWatchdog(): void {
    if (!this.watchdog) this.watchdog = setInterval(() => this.check(), WATCHDOG_MS);
  }

  /**
   * Repairs what reconnects can leave behind: links that never connected or broke (redial or
   * ring), a microphone the phone took away while in the background (rejoin), and audio the
   * browser didn't start.
   */
  private check(): void {
    if (!this.joined || this.joining) return;
    if (this.stream && !this.stream.getAudioTracks().some((t) => t.readyState === 'live') && document.visibilityState === 'visible') {
      void this.rejoin();
      return;
    }
    const now = Date.now();
    for (const id of this.others) {
      const peer = this.peers.get(id);
      // close() fires no state event, so a link closed under us still reads as connected.
      if (peer && peer.pc.connectionState === 'closed' && peer.status !== 'failed') this.markFailed(id, peer);
      const stuck = !peer || (peer.status === 'failed' && now - peer.since > RETRY_MS) || (peer.status !== 'connected' && now - peer.since > STALL_MS);
      if (!stuck) continue;
      if (this.myId < id) {
        this.closePeer(id);
        void this.call(id);
      } else if (now - (this.rangAt.get(id) ?? 0) > STALL_MS) {
        this.rangAt.set(id, now);
        this.signal(id, 'ring', 0, '');
      }
    }
    this.resumeAudio();
  }

  /** Starts any incoming audio the browser left paused (autoplay rules after a reconnect). */
  resumeAudio(): void {
    for (const p of this.peers.values()) if (p.audio.srcObject && p.audio.paused) void p.audio.play().catch(() => {});
  }

  /** Caps every outgoing audio stream at the shared quality setting. */
  private async applyBitrate(pc: RTCPeerConnection): Promise<void> {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.bitrateKbps * 1000;
      try {
        await sender.setParameters(params);
      } catch {
        /* not negotiated yet; applied again once connected */
      }
    }
  }

  private applyMute(): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !this.muted;
  }

  /** Drops every connection and the microphone; we are out of the channel. */
  private teardown(): void {
    this.joined = false;
    this.closeAllPeers();
    this.stopStream();
    this.others.clear();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private closeAllPeers(): void {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.rangAt.clear();
  }

  private closePeer(userId: number): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }

  private stopStream(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  private box(): HTMLElement {
    if (!this.audioBox) {
      this.audioBox = document.createElement('div');
      this.audioBox.hidden = true;
      document.body.appendChild(this.audioBox);
    }
    return this.audioBox;
  }
}

export const voice = new VoiceClient();
