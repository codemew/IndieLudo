import { describe, expect, it } from 'vitest';
import { pickMicAfterChange, setOpusBitrate } from '../../src/client/voice.js';

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  '',
].join('\r\n');

describe('setOpusBitrate', () => {
  it('adds maxaveragebitrate to the opus fmtp line and keeps other params', () => {
    const out = setOpusBitrate(SDP, 64);
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000');
    // Other codecs are untouched.
    expect(out).toContain('a=fmtp:63 111/111');
    expect(out.split('\r\n')).toHaveLength(SDP.split('\r\n').length);
  });

  it('replaces an existing value rather than duplicating it', () => {
    const out = setOpusBitrate(setOpusBitrate(SDP, 64), 16);
    expect(out.match(/maxaveragebitrate/g)).toHaveLength(1);
    expect(out).toContain('maxaveragebitrate=16000');
  });

  it('inserts an fmtp line when opus has none', () => {
    const bare = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    const lines = setOpusBitrate(bare, 32).split('\r\n');
    const rtp = lines.indexOf('a=rtpmap:111 opus/48000/2');
    expect(lines[rtp + 1]).toBe('a=fmtp:111 maxaveragebitrate=32000;useinbandfec=1');
  });

  it('leaves an SDP without opus alone', () => {
    const noOpus = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
    expect(setOpusBitrate(noOpus, 32)).toBe(noOpus);
  });
});

describe('pickMicAfterChange', () => {
  const mic = (deviceId: string) => ({ deviceId, kind: 'audioinput' });
  it('switches to a microphone that just appeared (earphones connected)', () => {
    expect(pickMicAfterChange(['default', 'builtin'], [mic('default'), mic('builtin'), mic('bt-buds'), { deviceId: 'bt-out', kind: 'audiooutput' }])).toBe('bt-buds');
  });
  it('falls back to the system default when earphones go away or nothing new appeared', () => {
    expect(pickMicAfterChange(['default', 'builtin', 'bt-buds'], [mic('default'), mic('builtin')])).toBeNull();
    expect(pickMicAfterChange(['default', 'builtin'], [mic('default'), mic('builtin'), { deviceId: 'bt-out', kind: 'audiooutput' }])).toBeNull();
  });
  it('ignores the "default" and "communications" aliases and blank ids', () => {
    expect(pickMicAfterChange([], [mic('default'), mic('communications'), mic('')])).toBeNull();
  });
});

describe('routesIn', () => {
  it('counts local (and hidden .local), internet and relay routes in an SDP', async () => {
    const { routesIn } = await import('../../src/client/voice.js');
    const sdp = [
      'v=0',
      'a=candidate:1 1 udp 2122260223 4f1c-uuid.local 54400 typ host generation 0',
      'a=candidate:2 1 udp 2122260223 192.168.1.20 54401 typ host generation 0',
      'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active',
      'a=candidate:4 1 udp 1686052607 203.0.113.7 54400 typ srflx raddr 0.0.0.0 rport 0',
      'a=candidate:5 1 udp 41885439 198.51.100.2 3478 typ relay raddr 203.0.113.7 rport 54400',
      '',
    ].join('\r\n');
    expect(routesIn(sdp)).toEqual({ host: 3, mdns: 1, srflx: 1, relay: 1 });
    expect(routesIn(undefined)).toEqual({ host: 0, mdns: 0, srflx: 0, relay: 0 });
  });
});
