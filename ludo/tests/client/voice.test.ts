import { describe, expect, it } from 'vitest';
import { setOpusBitrate } from '../../src/client/voice.js';

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
