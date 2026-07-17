import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRaopAnnounce, parseTransportHeader, buildTransportHeader,
  parseTextParameters, parseRtpInfoHeader, RAOP_COMPRESSION,
} from '../src/rtsp/sdp.js';

const CRLF = '\r\n';

function sdp(lines) {
  return [
    'v=0',
    'o=iTunes 3413821438 0 IN IP4 192.0.2.10',
    's=iTunes',
    'c=IN IP4 192.0.2.20',
    't=0 0',
    ...lines,
  ].join(CRLF) + CRLF;
}

test('parseRaopAnnounce parses an ALAC FairPlay announce', () => {
  const key = Buffer.from('example-fairplay-wrapped-key');
  const iv = Buffer.alloc(16, 7);
  const announce = parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    `a=fpaeskey:${key.toString('base64')}`,
    `a=aesiv:${iv.toString('base64')}`,
    'a=min-latency:11025',
    'a=max-latency:88200',
  ]));
  assert.equal(announce.payloadType, 96);
  assert.equal(announce.codec, 'alac');
  assert.equal(announce.compressionType, RAOP_COMPRESSION.ALAC);
  assert.equal(announce.sampleRate, 44100);
  assert.equal(announce.channels, 2);
  assert.equal(announce.samplesPerFrame, 352);
  assert.deepEqual(announce.alac, {
    frameLength: 352,
    compatibleVersion: 0,
    bitDepth: 16,
    pb: 40,
    mb: 10,
    kb: 14,
    channels: 2,
    maxRun: 255,
    maxFrameBytes: 0,
    avgBitRate: 0,
    sampleRate: 44100,
  });
  assert.equal(announce.encryption, 'fairplay');
  assert.deepEqual(announce.ekey, key);
  assert.deepEqual(announce.eiv, iv);
  assert.equal(announce.minLatency, 11025);
  assert.equal(announce.maxLatency, 88200);
});

test('parseRaopAnnounce parses an unencrypted AAC announce', () => {
  const announce = parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 97',
    'a=rtpmap:97 mpeg4-generic/44100/2',
    'a=fmtp:97 mode=AAC-eld; constantDuration=480',
  ]));
  assert.equal(announce.codec, 'aac');
  assert.equal(announce.compressionType, RAOP_COMPRESSION.AAC_LC);
  assert.equal(announce.samplesPerFrame, 480);
  assert.equal(announce.encryption, 'none');
  assert.equal(announce.ekey, null);
  assert.equal(announce.eiv, null);
});

test('parseRaopAnnounce defaults AAC constantDuration to 1024', () => {
  const announce = parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 97',
    'a=rtpmap:97 mpeg4-generic/48000/2',
    'a=fmtp:97 mode=AAC-hbr',
  ]));
  assert.equal(announce.sampleRate, 48000);
  assert.equal(announce.samplesPerFrame, 1024);
});

test('parseRaopAnnounce parses PCM and flags RSA announces', () => {
  const pcm = parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 L16/44100/2',
  ]));
  assert.equal(pcm.codec, 'pcm');
  assert.equal(pcm.compressionType, RAOP_COMPRESSION.PCM);

  const rsa = parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    `a=rsaaeskey:${Buffer.alloc(32, 3).toString('base64')}`,
    `a=aesiv:${Buffer.alloc(16, 9).toString('base64')}`,
  ]));
  assert.equal(rsa.encryption, 'rsa');
  assert.equal(rsa.ekey, null);
});

test('parseRaopAnnounce rejects malformed bodies', () => {
  assert.throws(() => parseRaopAnnounce('v=0\r\nm=video 0 RTP/AVP 96\r\n'), /no audio media/);
  assert.throws(() => parseRaopAnnounce('nonsense'), /Invalid SDP line/);
  assert.throws(() => parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:97 AppleLossless',
  ])), /rtpmap does not describe/);
  assert.throws(() => parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16',
  ])), /11 unsigned integers/);
  assert.throws(() => parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    'a=aesiv:%%%not-base64%%%',
  ])), /not valid base64/);
  assert.throws(() => parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    `a=aesiv:${Buffer.alloc(8, 1).toString('base64')}`,
  ])), /16 bytes/);
  assert.throws(() => parseRaopAnnounce(sdp([
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    `a=fpaeskey:${Buffer.alloc(24, 2).toString('base64')}`,
  ])), /missing aesiv/);
});

test('Transport header parse/build round-trip', () => {
  const parsed = parseTransportHeader(
    'RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=6001;timing_port=6002',
  );
  assert.equal(parsed.protocol, 'RTP/AVP/UDP');
  assert.equal(parsed.udp, true);
  assert.equal(parsed.unicast, true);
  assert.equal(parsed.mode, 'record');
  assert.equal(parsed.controlPort, 6001);
  assert.equal(parsed.timingPort, 6002);

  const bare = parseTransportHeader('RTP/AVP');
  assert.equal(bare.udp, true);
  assert.equal(bare.controlPort, null);
  assert.equal(bare.timingPort, null);

  assert.throws(() => parseTransportHeader(''), /required/);
  assert.throws(() => parseTransportHeader('HTTP/1.1;unicast'), /Unsupported Transport protocol/);
  assert.throws(() => parseTransportHeader('RTP/AVP/UDP;control_port=99999'), /valid port/);

  const built = buildTransportHeader({ serverPort: 50000, controlPort: 50001, timingPort: 50002 });
  assert.equal(built, 'RTP/AVP/UDP;unicast;mode=record;server_port=50000;control_port=50001;timing_port=50002');
  const roundTrip = parseTransportHeader(built);
  assert.equal(roundTrip.params.server_port, '50000');
  assert.equal(roundTrip.controlPort, 50001);
  assert.equal(roundTrip.timingPort, 50002);
  assert.throws(() => buildTransportHeader({ serverPort: 0, controlPort: 1, timingPort: 2 }), /serverPort/);
});

test('parseTextParameters and parseRtpInfoHeader', () => {
  assert.deepEqual(parseTextParameters('volume: -11.5\r\nprogress: 1/2/3\r\n'), {
    volume: '-11.5',
    progress: '1/2/3',
  });
  assert.deepEqual(parseTextParameters(Buffer.from('Volume: -144.0')), { volume: '-144.0' });
  assert.deepEqual(parseTextParameters(''), {});

  assert.deepEqual(parseRtpInfoHeader('seq=44;rtptime=2789220'), { seq: 44, rtptime: 2789220 });
  assert.deepEqual(parseRtpInfoHeader('seq=-1;rtptime=abc'), {});
  assert.deepEqual(parseRtpInfoHeader(undefined), {});
});
