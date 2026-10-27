import type { RTCIceServerConfig, VoiceJoined, VoiceSignalIn } from '../shared/protocol.js';
import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, type VoiceState } from '../shared/types.js';
import { emit } from './net.js';

export type PeerStatus = 'connecting' | 'connected' | 'failed';

const MAX_KBPS = VOICE_BITRATES[VOICE_BITRATES.length - 1];
const ICE_GATHER_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 1500;

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
}

/**
 * Voice chat for one lobby: a full mesh of audio-only WebRTC connections (at most 3 peers).
 * Every lobby member is in it from joining the lobby until leaving it, through matches and
 * results. The newcomer always sends the offers, so two phones never offer to each other at once.
 */
class VoiceClient {
  /** The lobby whose channel we are in, or are joining. */
  lobbyId: string | null = null;
  joined = false;
  joining = false;
  muted = false;
  /** False when the microphone is blocked or missing: we still listen, and show as muted. */
  micAvailable = true;
  /** Last reason joining failed (server side), so the UI can offer a retry. */
  error: string | null = null;
  bitrateKbps = DEFAULT_VOICE_BITRATE;
  private myId = 0;
  private stream: MediaStream | null = null;
  private iceServers: RTCIceServerConfig[] = [];
  private peers = new Map<number, Peer>();
  private listeners = new Set<() => void>();
  private audioBox: HTMLElement | null = null;

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
      await this.acquireMic();
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
      this.error = null;
      this.joined = true;
      this.iceServers = r.data!.iceServers;
      this.bitrateKbps = r.data!.state.bitrateKbps;
      this.applyMute();
      // The server remembers mute across rejoins; make it match what this phone is doing.
      const me = r.data!.state.participants.find((p) => p.userId === myId);
      if (me && me.muted !== this.silent) void emit('voice:mute', { lobbyId, muted: this.silent });
      for (const p of r.data!.state.participants) if (p.userId !== myId) void this.call(p.userId);
      return null;
    } finally {
      this.joining = false;
      this.notify();
    }
  }

  private async acquireMic(): Promise<void> {
    if (this.stream?.getAudioTracks().some((t) => t.readyState === 'live')) return;
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

  async leave(tellServer = true): Promise<void> {
    const lobbyId = this.lobbyId;
    const wasJoined = this.joined;
    this.lobbyId = null;
    this.joined = false;
    this.error = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.stopStream();
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

  async setBitrate(lobbyId: string, kbps: number): Promise<string | null> {
    const r = await emit('voice:bitrate', { lobbyId, kbps });
    return r.ok ? null : r.error;
  }

  /** Server's view of the channel: drop peers that left, apply a new quality setting. */
  onState(state: VoiceState): void {
    if (state.lobbyId !== this.lobbyId) return;
    if (state.bitrateKbps !== this.bitrateKbps) {
      this.bitrateKbps = state.bitrateKbps;
      for (const p of this.peers.values()) void this.applyBitrate(p.pc);
    }
    const present = new Set(state.participants.map((p) => p.userId));
    for (const id of [...this.peers.keys()]) if (!present.has(id)) this.closePeer(id);
    this.notify();
  }

  async onSignal(sig: VoiceSignalIn): Promise<void> {
    if (!this.joined || sig.lobbyId !== this.lobbyId) return;
    if (sig.kind === 'offer') {
      // A (re)offer always starts a fresh connection with that player.
      this.closePeer(sig.from);
      const peer = this.createPeer(sig.from);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription({ type: 'answer', sdp: setOpusBitrate(answer.sdp ?? '', MAX_KBPS) });
      await iceGathered(peer.pc);
      if (this.peers.get(sig.from) === peer) this.signal(sig.from, 'answer', peer.pc.localDescription!.sdp);
    } else {
      const peer = this.peers.get(sig.from);
      if (peer?.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
    }
  }

  /** After a socket reconnect the server has dropped us from the channel: rejoin and re-call. */
  async onReconnect(): Promise<void> {
    if (this.lobbyId) await this.restart();
  }

  private async restart(): Promise<void> {
    const lobbyId = this.lobbyId!;
    this.joined = false;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    await this.join(lobbyId, this.myId);
  }

  private async call(userId: number): Promise<void> {
    const peer = this.createPeer(userId);
    // Listen-only (no microphone): still ask to receive their audio.
    if (!this.stream) peer.pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription({ type: 'offer', sdp: setOpusBitrate(offer.sdp ?? '', MAX_KBPS) });
    await iceGathered(peer.pc);
    if (this.peers.get(userId) === peer) this.signal(userId, 'offer', peer.pc.localDescription!.sdp);
  }

  private signal(to: number, kind: 'offer' | 'answer', sdp: string): void {
    if (this.lobbyId) void emit('voice:signal', { lobbyId: this.lobbyId, to, kind, sdp });
  }

  private createPeer(userId: number): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    for (const track of this.stream?.getAudioTracks() ?? []) pc.addTrack(track, this.stream!);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    this.box().appendChild(audio);
    const peer: Peer = { pc, audio, status: 'connecting' };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(userId) !== peer) return;
      const s = pc.connectionState;
      peer.status = s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : 'connecting';
      if (s === 'connected') void this.applyBitrate(pc);
      // One side (the lower id) redials after a failure; the other just accepts the new offer.
      if (s === 'failed' && this.myId < userId) {
        setTimeout(() => {
          if (this.joined && this.peers.get(userId) === peer) {
            this.closePeer(userId);
            void this.call(userId);
          }
        }, RETRY_DELAY_MS);
      }
      this.notify();
    };
    this.peers.set(userId, peer);
    void this.applyBitrate(pc);
    this.notify();
    return peer;
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
