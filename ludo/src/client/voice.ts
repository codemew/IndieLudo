import type { RTCIceServerConfig, SfuOffer, VoiceFramesIn, VoiceJoined, VoiceSignalIn, VoiceSignalKind } from '../shared/protocol.js';
import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, type VoiceSlot, type VoiceState } from '../shared/types.js';
import { MicChain, canDenoise, micConstraints } from './micChain.js';
import { emit, send } from './net.js';
import { RelayPlayer, RelaySender, relaySupport } from './voiceRelay.js';

export type PeerStatus = 'connecting' | 'connected' | 'failed';

const MAX_KBPS = VOICE_BITRATES[VOICE_BITRATES.length - 1];
const ICE_GATHER_TIMEOUT_MS = 3000;
/** How often the watchdog checks every link. */
const WATCHDOG_MS = 2000;
/** A link that isn't connected after this long (or has failed for RETRY_MS) is redialled. */
const STALL_MS = 12_000;
/** A link that hasn't connected directly for this long carries its voice through the game server. */
const RELAY_AFTER_MS = 8_000;
const RETRY_MS = 1500;
/** Plugging in or pairing a headset fires several devicechange events; act once they settle. */
const DEVICE_SETTLE_MS = 700;
/** With the voice server on, direct links wait this long for both phones to reach it first. */
const SFU_GRACE_MS = 6000;
/** A received voice level older than this means they stopped talking (nothing is sent in silence). */
const LEVEL_STALE_MS = 250;

/** Loudness 0..1 for the talking animation, from an amplitude 0..1: -60 dBFS → 0, -12 dBFS → 1. */
export function talkLevel(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(amplitude) + 60) / 48));
}

function micOptions(): MediaTrackConstraints {
  const supported = (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}) as Record<string, boolean | undefined>;
  return micConstraints(canDenoise(), supported);
}

/**
 * Which microphone to use after the audio devices changed: one that just appeared (Bluetooth
 * earphones connecting, a headset plugged in) is wanted right away; otherwise the system
 * default, which is also where audio falls back to when earphones go away.
 */
export function pickMicAfterChange(before: readonly string[], now: readonly { deviceId: string; kind: string }[]): string | null {
  const known = new Set(before);
  const added = now.find((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications' && !known.has(d.deviceId));
  return added?.deviceId ?? null;
}

/**
 * Lets the remote Opus encoder go up to `kbps`, turns on in-band FEC (rides out lost packets on
 * patchy mobile data) and DTX: while someone isn't talking their phone sends a tiny packet every
 * 400 ms instead of full audio every 20 ms, which saves most of the data in a game. The live quality
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
    params.set('usedtx', '1');
    lines[fmtpIdx] = `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
  } else {
    const rtpIdx = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    lines.splice(rtpIdx + 1, 0, `a=fmtp:${pt} maxaveragebitrate=${bps};useinbandfec=1;usedtx=1`);
  }
  return lines.join('\r\n');
}

/** How each side said it could be reached, from the a=candidate lines of an SDP. */
export interface RouteSummary {
  /** On the local network; `mdns` counts host addresses hidden behind a random .local name. */
  host: number;
  mdns: number;
  /** As seen from the internet (found through STUN). */
  srflx: number;
  /** Through a TURN relay. */
  relay: number;
  /** Of the routes whose address is visible, how many are IPv4 and how many IPv6. */
  v4: number;
  v6: number;
}

export function routesIn(sdp: string | undefined): RouteSummary {
  const r: RouteSummary = { host: 0, mdns: 0, srflx: 0, relay: 0, v4: 0, v6: 0 };
  for (const line of (sdp ?? '').split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (host|srflx|prflx|relay)/.exec(line);
    if (!m) continue;
    const addr = m[1];
    if (m[2] === 'host') {
      r.host++;
      if (addr.endsWith('.local')) r.mdns++;
    } else if (m[2] === 'relay') r.relay++;
    else r.srflx++;
    if (addr.includes(':')) r.v6++;
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) r.v4++;
  }
  return r;
}

/** One voice link as seen from this phone, for the diagnostics panel. */
export interface LinkReport {
  userId: number;
  status: PeerStatus | 'none';
  /** Seconds in the current state. */
  forSec: number;
  /** We dial this player (lower id) or wait for their call. */
  role: 'dial' | 'answer';
  ice: string;
  /** Their offer or answer arrived. */
  gotReply: boolean;
  /** Candidates sent / received after the first offer or answer. */
  late: { sent: number; got: number };
  /** Voice through the game server: we send to them, and how much of theirs we've received. */
  relay: { sending: boolean; heard: boolean; framesIn: number };
  /** Talking through the built-in voice server (UDP). */
  sfu: boolean;
  mine: RouteSummary;
  theirs: RouteSummary;
  /** Route types of the working connection, e.g. "host → host". */
  via: string | null;
  audioKbIn: number;
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
  /** Our microphone's sender on this link (null for listen-only). */
  mic: RTCRtpSender | null;
  audio: HTMLAudioElement;
  status: PeerStatus;
  /** Ties an answer to our offer, or our answer to their offer. */
  call: number;
  /** When the link last stopped being connected (or was created). */
  since: number;
  /** Our offer/answer went out; candidates found after that are sent on as `cand`. */
  sentSdp: boolean;
  late: RTCIceCandidateInit[];
  lateTimer: ReturnType<typeof setTimeout> | null;
  /** Their late candidates that came before their description did. */
  queued: RTCIceCandidateInit[];
  trickled: { sent: number; got: number };
}

/** Late candidates are batched for this long, so a burst is one message. */
const LATE_BATCH_MS = 250;

/** Our one connection to the built-in voice server (see server/sfu.ts). */
interface SfuLink {
  pc: RTCPeerConnection | null;
  mic: RTCRtpSender | null;
  /** Which receive slot (mid) carries whose voice. */
  slots: VoiceSlot[];
  audios: HTMLAudioElement[];
  status: PeerStatus;
  since: number;
  late: RTCIceCandidateInit[];
  lateTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Voice chat for one lobby (up to 8 people: every seat and every spectator). Every lobby member
 * is in it from joining the lobby until leaving it, through matches and results, unless the
 * host turns it off.
 *
 * The voice goes, for each pair of phones, the best way that works:
 * 1. through the built-in voice server over UDP, when both phones are connected to it (one
 *    upload per phone however many listen);
 * 2. otherwise a direct WebRTC link between the two;
 * 3. and if that can't connect, relayed over the game's own connection (voiceRelay.ts).
 *
 * The microphone goes through RNNoise and a voice-focus filter (micChain.ts), and nothing at all
 * is sent while nobody talks.
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
  /** Microphones the phone had last time we looked, to spot earphones connecting. */
  private knownMics: string[] = [];
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while swapping to a new microphone, so the watchdog doesn't mistake the old one ending for a fault. */
  private switching = false;
  private listeners = new Set<() => void>();
  private audioBox: HTMLElement | null = null;
  /** The microphone, cleaned up (RNNoise, filters) and gated; null where that can't run. */
  private chain: MicChain | null = null;
  private chainStream: MediaStream | null = null;
  /** The server has the voice server on. */
  private sfuOn = false;
  private sfu: SfuLink | null = null;
  private sfuStarting = false;
  /** Others connected to the voice server (from the channel state). */
  private onSfu = new Set<number>();
  /** When each other member appeared, for the grace before dialling them directly. */
  private seenAt = new Map<number, number>();
  /** Last RTP timestamp seen per speaker, to tell a fresh voice level from a stale one. */
  private lastSrc = new Map<number, { rtp: number; at: number }>();

  constructor() {
    if (typeof document === 'undefined') return;
    // A tap anywhere lets audio that the browser refused to autoplay start.
    document.addEventListener('pointerdown', () => this.resumeAudio(), { capture: true });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.check());
    // Bluetooth earphones connecting or disconnecting mid-call.
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (this.deviceTimer) clearTimeout(this.deviceTimer);
      this.deviceTimer = setTimeout(() => void this.onDevicesChanged(), DEVICE_SETTLE_MS);
    });
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
    if (this.viaSfu(userId)) return 'connected';
    // Heard through the game server counts as connected, even while the direct link keeps trying.
    if (this.relayIn.heard(userId)) return 'connected';
    return this.peers.get(userId)?.status ?? null;
  }

  /** Players whose voice reaches us through the game server rather than directly. */
  get relayedCount(): number {
    let n = 0;
    for (const id of this.others) if (!this.viaSfu(id) && this.peers.get(id)?.status !== 'connected' && this.relayIn.heard(id)) n++;
    return n;
  }

  /** Players we talk with through the voice server. */
  get sfuCount(): number {
    let n = 0;
    for (const id of this.others) if (this.viaSfu(id)) n++;
    return n;
  }

  /** Our voice-server connection: off, or its state. */
  get sfuStatus(): PeerStatus | 'off' {
    return this.sfuOn ? (this.sfu?.status ?? 'connecting') : 'off';
  }

  /** RNNoise is cleaning up our microphone. */
  get denoising(): boolean {
    return Boolean(this.chain?.ready && this.chain.denoising);
  }

  /** Both of us are on the voice server, and it carries their voice to us. */
  private viaSfu(userId: number): boolean {
    return this.sfu?.status === 'connected' && this.onSfu.has(userId) && this.sfu.slots.some((s) => s.userId === userId);
  }

  /**
   * How loudly someone is talking right now, 0..1, for the talking animation. Ours comes from
   * the voice gate (0 while muted or quiet, matching what the others hear); theirs from the
   * level the browser reads off each packet that arrives, or from relayed audio.
   */
  levelOf(userId: number): number {
    if (!this.joined) return 0;
    if (userId === this.myId) return !this.muted && this.chain?.ready ? this.chain.level : 0;
    let receiver: RTCRtpReceiver | undefined;
    if (this.viaSfu(userId)) {
      const mid = this.sfu!.slots.find((s) => s.userId === userId)?.mid;
      receiver = this.sfu!.pc?.getTransceivers().find((t) => t.mid === mid)?.receiver;
    } else if (this.peers.get(userId)?.status === 'connected') {
      receiver = this.peers.get(userId)!.pc.getReceivers()[0];
    }
    if (!receiver) return this.relayIn.levelOf(userId);
    const src = receiver.getSynchronizationSources?.()[0];
    if (!src) return 0;
    const now = performance.now();
    const last = this.lastSrc.get(userId);
    if (!last || last.rtp !== src.rtpTimestamp) this.lastSrc.set(userId, { rtp: src.rtpTimestamp, at: now });
    else if (now - last.at > LEVEL_STALE_MS) return 0;
    return talkLevel(src.audioLevel ?? 0);
  }

  /** Last error the server gave for one of our voice signals (e.g. a rejected offer). */
  signalError: string | null = null;

  /** Per-player link details for the "Details" panel and a copyable report. */
  async report(): Promise<{ myId: number; mic: boolean; iceServers: number; signalError: string | null; sfu: PeerStatus | 'off'; denoise: boolean; links: LinkReport[] }> {
    const links: LinkReport[] = [];
    for (const userId of this.others) {
      const peer = this.peers.get(userId);
      let via: string | null = null;
      let audioKbIn = 0;
      if (peer) {
        try {
          const stats = await peer.pc.getStats();
          const byId = new Map<string, any>();
          stats.forEach((s: any) => byId.set(s.id, s));
          stats.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio') audioKbIn += Math.round((s.bytesReceived ?? 0) / 1024);
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
              const l = byId.get(s.localCandidateId);
              const r = byId.get(s.remoteCandidateId);
              via = `${l?.candidateType ?? '?'} → ${r?.candidateType ?? '?'}`;
            }
          });
        } catch {
          /* closed */
        }
      }
      links.push({
        userId,
        status: peer?.status ?? 'none',
        forSec: peer ? Math.round((Date.now() - peer.since) / 1000) : 0,
        role: this.myId < userId ? 'dial' : 'answer',
        ice: peer ? `${peer.pc.iceConnectionState}/${peer.pc.iceGatheringState}` : '-',
        gotReply: Boolean(peer?.pc.remoteDescription),
        late: peer ? { ...peer.trickled } : { sent: 0, got: 0 },
        relay: { sending: this.relayTo.has(userId), heard: this.relayIn.heard(userId), framesIn: this.relayIn.framesFrom(userId) },
        sfu: this.viaSfu(userId),
        mine: routesIn(peer?.pc.localDescription?.sdp),
        theirs: routesIn(peer?.pc.remoteDescription?.sdp),
        via,
        audioKbIn,
      });
    }
    return { myId: this.myId, mic: this.micAvailable, iceServers: this.iceServers.length, signalError: this.signalError, sfu: this.sfuStatus, denoise: this.denoising, links };
  }

  /** How many of the other members we have a working audio link with. */
  get linked(): { connected: number; total: number } {
    let connected = 0;
    for (const id of this.others) if (this.peerStatus(id) === 'connected') connected++;
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
      this.sfuOn = Boolean(r.data!.sfu);
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
      this.setOthers(state);
      // The voice server first; direct links (the watchdog) only for those it can't carry.
      if (this.sfuOn) void this.startSfu();
      else for (const id of this.others) this.connect(id);
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
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: micOptions(), video: false });
      this.micAvailable = true;
      await this.buildChain();
      this.knownMics = await this.listMics();
    } catch {
      this.stream = null;
      this.micAvailable = false;
    }
  }

  /** Runs the microphone through RNNoise, the voice-focus filters and the voice gate. */
  private async buildChain(): Promise<void> {
    this.chain?.stop();
    this.chain = this.chainStream = null;
    const stream = this.stream;
    if (!stream) return;
    const chain = await MicChain.create(stream);
    if (this.stream !== stream) {
      chain?.stop();
      return;
    }
    if (!chain) {
      // No audio worklets here: let the browser suppress noise instead.
      void stream.getAudioTracks()[0]?.applyConstraints(micConstraints(false)).catch(() => {});
      return;
    }
    chain.onGate = () => this.applySendTrack();
    chain.onReady = () => this.applySendTrack();
    chain.onNoRnnoise = () => void stream.getAudioTracks()[0]?.applyConstraints(micConstraints(false)).catch(() => {});
    this.chain = chain;
    this.chainStream = new MediaStream([chain.track]);
    chain.track.enabled = !this.muted;
  }

  /**
   * What our senders carry: the cleaned-up microphone while we talk, and nothing at all (no
   * packets) while we're quiet or muted. Without the chain (or before iOS lets audio run): the
   * raw microphone, muted by disabling it.
   */
  private sendTrack(): MediaStreamTrack | null {
    const raw = this.stream?.getAudioTracks()[0] ?? null;
    if (!raw) return null;
    const c = this.chain;
    if (c?.ready) return !this.muted && c.open ? c.track : null;
    return raw;
  }

  private applySendTrack(): void {
    const track = this.sendTrack();
    for (const sender of [...[...this.peers.values()].map((p) => p.mic), this.sfu?.mic]) {
      if (sender && sender.track !== track) void sender.replaceTrack(track).catch(() => {});
    }
    this.relayOut.setGate(!this.chain?.ready || this.chain.open);
  }

  private async listMics(): Promise<string[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.deviceId);
    } catch {
      return [];
    }
  }

  /**
   * Earphones connected or went away. Phones pick the audio route (Bluetooth or wired headset,
   * versus earpiece or speaker) when the microphone is opened, so a call keeps the old route
   * until the mic is opened again. Open a fresh one (the new headset's if one just appeared),
   * swap it into every call without redialling, and restart playback so it follows the new route.
   */
  private async onDevicesChanged(): Promise<void> {
    if (!this.joined || this.joining || this.switching || !this.stream) return;
    this.switching = true;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const wanted = pickMicAfterChange(this.knownMics, devices);
      this.knownMics = devices.filter((d) => d.kind === 'audioinput').map((d) => d.deviceId);
      const open = (deviceId: string | null) =>
        navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...micOptions(), deviceId: { exact: deviceId } } : micOptions(), video: false });
      let next: MediaStream | null = null;
      try {
        next = await open(wanted);
      } catch {
        // Some phones can't hold two captures at once, or the new device isn't ready yet:
        // release the old mic and try the default.
        this.stopStream();
        next = await open(null).catch(() => null);
      }
      if (!this.joined || !next) {
        for (const t of next?.getTracks() ?? []) t.stop();
        if (!next && this.joined) void this.rejoin();
        return;
      }
      const old = this.stream;
      this.stream = next;
      await this.buildChain();
      // Every sender switches to the new microphone (applyMute does that) without redialling.
      this.applyMute();
      this.updateRelay();
      // Reattach playback so the browser opens its output on the new route.
      for (const audio of [...[...this.peers.values()].map((p) => p.audio), ...(this.sfu?.audios ?? [])]) {
        const src = audio.srcObject;
        if (!src) continue;
        audio.srcObject = null;
        audio.srcObject = src;
        void audio.play().catch(() => {});
      }
      for (const t of old?.getTracks() ?? []) if (!next.getTracks().includes(t)) t.stop();
    } finally {
      this.switching = false;
      this.notify();
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
    this.updateRelay();
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
      for (const p of this.peers.values()) void this.applyBitrate(p.mic);
      void this.applyBitrate(this.sfu?.mic ?? null);
      this.relayOut.setBitrate(this.bitrateKbps);
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
    this.setOthers(state);
    for (const id of [...this.peers.keys()]) if (!this.others.has(id) || this.viaSfu(id)) this.closePeer(id);
    this.notify();
  }

  private setOthers(state: VoiceState): void {
    const now = Date.now();
    this.others = new Set(state.participants.map((p) => p.userId).filter((id) => id !== this.myId));
    this.onSfu = new Set(state.participants.filter((p) => p.sfu && p.userId !== this.myId).map((p) => p.userId));
    for (const id of this.others) if (!this.seenAt.has(id)) this.seenAt.set(id, now);
    for (const id of [...this.seenAt.keys()]) if (!this.others.has(id)) this.seenAt.delete(id);
  }

  /** The voice server says which receive slot carries whose voice. */
  onSlots(s: { lobbyId: string; slots: VoiceSlot[] }): void {
    if (s.lobbyId !== this.lobbyId || !this.sfu) return;
    this.sfu.slots = s.slots;
    for (const id of [...this.peers.keys()]) if (this.viaSfu(id)) this.closePeer(id);
    this.notify();
  }

  /** Connects (again) to the voice server: one connection carries everyone. */
  private async startSfu(): Promise<void> {
    const lobbyId = this.lobbyId;
    if (!lobbyId || !this.sfuOn || this.sfuStarting) return;
    this.sfuStarting = true;
    this.closeSfu();
    const link: SfuLink = { pc: null, mic: null, slots: [], audios: [], status: 'connecting', since: Date.now(), late: [], lateTimer: null };
    this.sfu = link;
    this.notify();
    const fail = () => {
      if (this.sfu !== link) return;
      link.status = 'failed';
      link.since = Date.now();
    };
    try {
      const r = await emit<SfuOffer>('voice:sfuJoin', { lobbyId }, 10_000);
      if (this.sfu !== link || this.lobbyId !== lobbyId) return;
      if (!r.ok) {
        if (r.error === 'SFU_OFF') this.sfuOn = false;
        return fail();
      }
      link.slots = r.data!.slots;
      const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
      link.pc = pc;
      pc.ontrack = (e) => {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audio.srcObject = new MediaStream([e.track]);
        this.box().appendChild(audio);
        link.audios.push(audio);
        void audio.play().catch(() => {});
      };
      pc.onicecandidate = (e) => {
        if (!e.candidate || this.sfu !== link) return;
        link.late.push(e.candidate.toJSON());
        link.lateTimer ??= setTimeout(() => {
          link.lateTimer = null;
          if (this.sfu === link && link.late.length) void emit('voice:sfuCand', { lobbyId, sdp: JSON.stringify(link.late.splice(0)) });
        }, LATE_BATCH_MS);
      };
      pc.onconnectionstatechange = () => {
        if (this.sfu !== link) return;
        const s = pc.connectionState;
        const status: PeerStatus = s === 'connected' ? 'connected' : s === 'failed' || s === 'closed' ? 'failed' : 'connecting';
        if (status !== link.status) link.since = Date.now();
        link.status = status;
        if (status === 'connected') {
          void this.applyBitrate(link.mic);
          for (const a of link.audios) void a.play().catch(() => {});
        }
        this.updateRelay();
        this.notify();
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: setOpusBitrate(r.data!.sdp, MAX_KBPS) });
      // The first section is our microphone (the server only receives on it); the rest are slots.
      const up = pc.getTransceivers()[0];
      up.direction = this.stream ? 'sendonly' : 'inactive';
      link.mic = up.sender;
      await up.sender.replaceTrack(this.sendTrack());
      await pc.setLocalDescription(await pc.createAnswer());
      const a = await emit('voice:sfuAnswer', { lobbyId, sdp: pc.localDescription!.sdp });
      if (!a.ok) fail();
    } catch {
      fail();
    } finally {
      this.sfuStarting = false;
      this.notify();
    }
  }

  private closeSfu(): void {
    const link = this.sfu;
    if (!link) return;
    this.sfu = null;
    if (link.lateTimer) clearTimeout(link.lateTimer);
    if (link.pc) {
      link.pc.ontrack = link.pc.onicecandidate = link.pc.onconnectionstatechange = null;
      link.pc.close();
    }
    for (const a of link.audios) {
      a.srcObject = null;
      a.remove();
    }
  }

  /** Relayed voice from a player we can't reach directly. Ignored once the direct link works. */
  onFrames(f: VoiceFramesIn): void {
    if (!this.joined || f.lobbyId !== this.lobbyId || !this.others.has(f.from)) return;
    if (this.peers.get(f.from)?.status === 'connected') return;
    const wasHeard = this.relayIn.heard(f.from);
    this.relayIn.push(f.from, f.frames);
    if (!wasHeard) this.notify();
  }

  async onSignal(sig: VoiceSignalIn): Promise<void> {
    if (!this.joined || sig.lobbyId !== this.lobbyId) return;
    // Both on the voice server: it carries this pair, no direct link needed.
    if (sig.kind !== 'cand' && this.viaSfu(sig.from)) return;
    if (sig.kind === 'cand') {
      this.onLateCandidates(sig);
    } else if (sig.kind === 'ring') {
      // They (re)joined or lost us: dial them afresh. Only the lower id dials.
      if (this.myId < sig.from) {
        this.closePeer(sig.from);
        void this.call(sig.from);
      }
    } else if (sig.kind === 'offer') {
      if (this.myId < sig.from) return; // we are the dialler for this pair; they'll get our offer
      // A new offer always replaces whatever link we had with that player.
      this.closePeer(sig.from);
      const peer = this.createPeer(sig.from, sig.call, false);
      try {
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
        // Their offer made our audio section: send our microphone on it (or just listen).
        const t = peer.pc.getTransceivers()[0];
        if (t) {
          t.direction = this.stream ? 'sendrecv' : 'recvonly';
          peer.mic = t.sender;
          await t.sender.replaceTrack(this.sendTrack());
        }
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription({ type: 'answer', sdp: setOpusBitrate(answer.sdp ?? '', MAX_KBPS) });
        this.applyQueued(peer);
        await iceGathered(peer.pc);
        if (this.peers.get(sig.from) === peer) this.sendDescription(sig.from, peer, 'answer');
      } catch {
        this.markFailed(sig.from, peer);
      }
    } else {
      const peer = this.peers.get(sig.from);
      // Only the answer to our current offer; one to an offer we already gave up on is stale.
      if (!peer || peer.call !== sig.call || peer.pc.signalingState !== 'have-local-offer') return;
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        this.applyQueued(peer);
      } catch {
        this.markFailed(sig.from, peer);
      }
    }
  }

  /** Their candidates found after their offer/answer (a slow STUN reply, a relay). */
  private onLateCandidates(sig: VoiceSignalIn): void {
    const peer = this.peers.get(sig.from);
    if (!peer || peer.call !== sig.call) return;
    let list: unknown;
    try {
      list = JSON.parse(sig.sdp);
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const c of list as RTCIceCandidateInit[]) {
      if (!c || typeof c.candidate !== 'string') continue;
      peer.trickled.got++;
      if (peer.pc.remoteDescription) void peer.pc.addIceCandidate(c).catch(() => {});
      else peer.queued.push(c);
    }
  }

  private applyQueued(peer: Peer): void {
    for (const c of peer.queued.splice(0)) void peer.pc.addIceCandidate(c).catch(() => {});
  }

  /** Sends our offer/answer with every candidate found so far; later ones follow as `cand`. */
  private sendDescription(to: number, peer: Peer, kind: 'offer' | 'answer'): void {
    peer.sentSdp = true;
    this.signal(to, kind, peer.call, peer.pc.localDescription!.sdp);
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
    this.closeSfu();
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
    const peer = this.createPeer(userId, ++this.seq, true);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ type: 'offer', sdp: setOpusBitrate(offer.sdp ?? '', MAX_KBPS) });
      await iceGathered(peer.pc);
      if (this.peers.get(userId) === peer) this.sendDescription(userId, peer, 'offer');
    } catch {
      this.markFailed(userId, peer);
    }
  }

  private signal(to: number, kind: VoiceSignalKind, call: number, sdp: string): void {
    if (!this.lobbyId) return;
    void emit('voice:signal', { lobbyId: this.lobbyId, to, kind, call, sdp }).then((r) => {
      if (r.ok) return;
      // The server refused it (e.g. too large, or they left): don't wait for an answer that
      // can't come; the watchdog redials.
      this.signalError = `${kind} to ${to}: ${r.error}`;
      const peer = this.peers.get(to);
      if (peer && (kind === 'offer' || kind === 'answer')) this.markFailed(to, peer);
    });
  }

  /** A direct link. The dialler adds its audio section now; the answerer once the offer is in. */
  private createPeer(userId: number, call: number, dialler: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    let mic: RTCRtpSender | null = null;
    if (dialler) {
      // Listen-only (no microphone): still ask to receive their audio.
      mic = pc.addTransceiver('audio', { direction: this.stream ? 'sendrecv' : 'recvonly' }).sender;
      void mic.replaceTrack(this.sendTrack()).catch(() => {});
    }
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    this.box().appendChild(audio);
    const peer: Peer = { pc, mic, audio, status: 'connecting', call, since: Date.now(), sentSdp: false, late: [], lateTimer: null, queued: [], trickled: { sent: 0, got: 0 } };
    // Candidates found after our offer/answer went out: pass them on in small batches.
    pc.onicecandidate = (e) => {
      if (!e.candidate || !peer.sentSdp || this.peers.get(userId) !== peer) return;
      peer.late.push(e.candidate.toJSON());
      peer.lateTimer ??= setTimeout(() => {
        peer.lateTimer = null;
        if (this.peers.get(userId) !== peer || !peer.late.length) return;
        peer.trickled.sent += peer.late.length;
        this.signal(userId, 'cand', peer.call, JSON.stringify(peer.late.splice(0)));
      }, LATE_BATCH_MS);
    };
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
        void this.applyBitrate(peer.mic);
        void audio.play().catch(() => {});
      }
      this.notify();
    };
    this.peers.set(userId, peer);
    void this.applyBitrate(mic);
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
    if (!this.joined || this.joining || this.switching) return;
    if (this.stream && !this.stream.getAudioTracks().some((t) => t.readyState === 'live') && document.visibilityState === 'visible') {
      void this.rejoin();
      return;
    }
    const now = Date.now();
    // The voice-server link: (re)connect it when it's missing, broke, or never came up.
    if (this.sfuOn && !this.sfuStarting) {
      const s = this.sfu;
      if (!s || (s.status === 'failed' && now - s.since > RETRY_MS) || (s.status !== 'connected' && now - s.since > STALL_MS) || s.pc?.connectionState === 'closed') void this.startSfu();
    }
    for (const id of this.others) {
      if (this.viaSfu(id)) {
        if (this.peers.has(id)) this.closePeer(id);
        continue;
      }
      // Give both phones a moment to reach the voice server before dialling directly.
      if (this.sfuOn && !this.peers.has(id) && now - (this.seenAt.get(id) ?? 0) < SFU_GRACE_MS) continue;
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
    this.updateRelay();
    this.resumeAudio();
  }

  /**
   * Links that haven't connected directly for RELAY_AFTER_MS send our voice through the game
   * server instead (the direct link keeps retrying, and takes over again once it connects).
   */
  private relayOut = new RelaySender((frames) => {
    if (this.lobbyId && this.relayTo.size) send('voice:frames', { lobbyId: this.lobbyId, to: [...this.relayTo], frames });
  });
  private relayIn = new RelayPlayer();
  private relayTo = new Set<number>();
  private downSince = new Map<number, number>();

  private updateRelay(): void {
    const now = Date.now();
    const before = this.relayTo.size;
    this.relayTo.clear();
    for (const id of this.others) {
      if (this.peers.get(id)?.status === 'connected' || this.viaSfu(id)) {
        this.downSince.delete(id);
        this.relayIn.drop(id);
        continue;
      }
      if (!this.downSince.has(id)) this.downSince.set(id, now);
      if (now - this.downSince.get(id)! >= RELAY_AFTER_MS) this.relayTo.add(id);
    }
    for (const id of [...this.downSince.keys()]) if (!this.others.has(id)) this.downSince.delete(id);
    // The cleaned-up microphone when it runs (gated: nothing is encoded while we're quiet).
    const source = this.chain?.ready ? this.chainStream : this.stream;
    const sendNow = this.joined && this.relayTo.size > 0 && Boolean(source) && !this.muted && relaySupport().send;
    // A new microphone (earphones connected, Rejoin): send from that one.
    if (sendNow && this.relayOut.running && this.relayOut.stream !== source) this.relayOut.stop();
    if (sendNow && !this.relayOut.running) this.relayOut.start(source!, this.bitrateKbps);
    else if (!sendNow && this.relayOut.running) this.relayOut.stop();
    this.relayOut.setGate(!this.chain?.ready || this.chain.open);
    if (before !== this.relayTo.size) this.notify();
  }

  /** Starts any incoming audio the browser left paused (autoplay rules after a reconnect). */
  resumeAudio(): void {
    for (const p of this.peers.values()) if (p.audio.srcObject && p.audio.paused) void p.audio.play().catch(() => {});
    for (const a of this.sfu?.audios ?? []) if (a.paused) void a.play().catch(() => {});
    this.chain?.resume();
    this.relayIn.resume();
    this.relayOut.resume();
  }

  /** Caps our outgoing audio at the shared quality setting. */
  private async applyBitrate(sender: RTCRtpSender | null): Promise<void> {
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = this.bitrateKbps * 1000;
    try {
      await sender.setParameters(params);
    } catch {
      /* not negotiated yet; applied again once connected */
    }
  }

  private applyMute(): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !this.muted;
    if (this.chain) this.chain.track.enabled = !this.muted;
    this.applySendTrack();
  }

  /** Drops every connection and the microphone; we are out of the channel. */
  private teardown(): void {
    this.joined = false;
    this.closeAllPeers();
    this.closeSfu();
    this.relayOut.stop();
    this.relayIn.stopAll();
    this.relayTo.clear();
    this.downSince.clear();
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
    peer.pc.onicecandidate = null;
    if (peer.lateTimer) clearTimeout(peer.lateTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }

  private stopStream(): void {
    this.chain?.stop();
    this.chain = this.chainStream = null;
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
