import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from 'werift';
import type { SfuOffer } from '../src/shared/protocol.js';
import type { VoiceSlot } from '../src/shared/types.js';
import type { TestClient } from './serverHelpers.js';

const CODECS = { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 })], video: [] };

/**
 * A phone on the voice server, played by werift in Node: it joins over the real socket, sends
 * fake Opus packets as its microphone and records what arrives on each receive slot.
 */
export async function sfuPhone(c: TestClient, lobbyId: string, opts: { local?: boolean } = {}) {
  const join = await c.emit<{ state: unknown; sfu: boolean }>('voice:join', { lobbyId });
  if (!join.ok || !join.data?.sfu) throw new Error(`voice:join ${JSON.stringify(join)}`);
  let slots: VoiceSlot[] = [];
  c.socket.on('voice:slots', (s: { lobbyId: string; slots: VoiceSlot[] }) => s.lobbyId === lobbyId && (slots = s.slots));
  const r = await c.emit<SfuOffer>('voice:sfuJoin', { lobbyId, ...(opts.local && { local: true }) });
  if (!r.ok) throw new Error(`voice:sfuJoin ${r.error}`);
  slots = r.data!.slots;
  const pc = new RTCPeerConnection({ codecs: CODECS, bundlePolicy: 'max-bundle', iceServers: [] });
  /** Sequence numbers received, by the user each slot said it carried. */
  const heard = new Map<number, number[]>();
  pc.onRemoteTransceiverAdded.subscribe((t) =>
    t.onTrack.subscribe((track) =>
      track.onReceiveRtp.subscribe((rtp) => {
        const owner = slots.find((s) => s.mid === t.mid)?.userId;
        if (owner == null) return;
        if (!heard.has(owner)) heard.set(owner, []);
        heard.get(owner)!.push(rtp.header.sequenceNumber);
      }),
    ),
  );
  await pc.setRemoteDescription({ type: 'offer', sdp: r.data!.sdp });
  const mic = new MediaStreamTrack({ kind: 'audio' });
  const [up] = pc.getTransceivers();
  up.sender.replaceTrack(mic);
  up.setDirection('sendonly');
  await pc.setLocalDescription(await pc.createAnswer());
  const answered = await c.emit('voice:sfuAnswer', { lobbyId, sdp: pc.localDescription!.sdp });
  if (!answered.ok) throw new Error(`voice:sfuAnswer ${answered.error}`);
  await new Promise<void>((resolve, reject) => {
    if (pc.connectionState === 'connected') return resolve();
    const t = setTimeout(() => reject(new Error('voice server connection timed out')), 8000);
    pc.connectionStateChange.subscribe((s) => s === 'connected' && (clearTimeout(t), resolve()));
  });
  let seq = 0;
  return {
    pc,
    offer: r.data!.sdp,
    heard,
    slots: () => slots,
    /** Sends `n` 20 ms packets of "voice". */
    async talk(n: number) {
      for (let i = 0; i < n; i++, seq++) {
        mic.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq, timestamp: seq * 960, ssrc: 4242 }), Buffer.from([0xfc, 0xff, 0xfe, i & 0xff])));
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: () => pc.close(),
  };
}
