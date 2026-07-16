import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import {
  ntpNow, ntpToUnixMs, ntpFixedToMs, encodeTimingPacket, decodeTimingPacket,
  buildTimingRequest, buildTimingReply, timingReplySample, signedRtpDelta,
  AirPlayMediaClock, TIMING_REQUEST, TIMING_REPLY,
} from '../src/stream/timing.js';
import { MirrorTransport } from '../src/stream/mirror.js';

test('NTP timestamps round-trip through unix milliseconds', () => {
  const ms = 1752652800123; // some fixed instant
  const ntp = ntpNow(ms);
  assert.ok(Math.abs(ntpToUnixMs(ntp) - ms) <= 1); // fraction rounding
});

test('boot-relative fixed-point timestamps do not apply the NTP epoch', () => {
  const bootMs = 12_345_678;
  const fixed = ntpNow(bootMs) - ntpNow(0);
  assert.ok(Math.abs(ntpFixedToMs(fixed) - bootMs) <= 1);
});

test('timing packets encode/decode symmetrically', () => {
  const packet = encodeTimingPacket({
    type: TIMING_REQUEST, sequence: 7, origin: 1n, receive: 2n, transmit: 3n,
  });
  const decoded = decodeTimingPacket(packet);
  assert.equal(decoded.type, TIMING_REQUEST);
  assert.equal(decoded.sequence, 7);
  assert.equal(decoded.origin, 1n);
  assert.equal(decoded.transmit, 3n);
});

test('buildTimingReply follows SNTP semantics with an injected clock', () => {
  let tick = 100n;
  const clock = () => tick++;
  const request = encodeTimingPacket({ type: TIMING_REQUEST, sequence: 42, transmit: 555n });
  const reply = decodeTimingPacket(buildTimingReply(request, clock));
  assert.equal(reply.type, TIMING_REPLY);
  assert.equal(reply.sequence, 42);
  assert.equal(reply.origin, 555n);   // echo of the request's transmit
  assert.equal(reply.receive, 100n);
  assert.equal(reply.transmit, 101n);
});

test('timingReplySample calculates remote clock offset and network RTT', () => {
  const localBase = 1_700_000_000_000;
  const remoteBase = 1_000_000;
  const reply = encodeTimingPacket({
    type: TIMING_REPLY,
    sequence: 9,
    origin: ntpNow(localBase),
    receive: ntpNow(remoteBase + 5),
    transmit: ntpNow(remoteBase + 7),
  });
  const sample = timingReplySample(reply, ntpNow(localBase + 12));
  assert.ok(Math.abs(sample.offsetMs - (remoteBase - localBase)) < 0.01);
  assert.ok(Math.abs(sample.roundTripMs - 10) < 0.01);
});

test('AirPlayMediaClock maps wrapped audio RTP and video onto one local clock', () => {
  const localBase = 1_700_000_000_000;
  const remoteBase = 1_000_000;
  const clock = new AirPlayMediaClock({ targetLatencyMs: 100, smoothing: 1, clock: () => localBase });
  clock.updateTimingReply({ offsetMs: remoteBase - localBase, roundTripMs: 10 });
  clock.updateAudioSync({
    rtpTimestamp: 0xfffffff0,
    nextRtpTimestamp: 0x00001d39,
    remoteNtp: ntpNow(remoteBase + 100),
    receivedAtMs: localBase + 20,
  });

  const audio = clock.mapAudio((0xfffffff0 + 4410) >>> 0, localBase);
  assert.equal(audio.source, 'ntp');
  assert.ok(Math.abs(audio.presentationTimeMs - (localBase + 300)) <= 1);
  assert.equal(signedRtpDelta(0x20, 0xfffffff0), 48);

  const videoFixed = ntpNow(remoteBase + 150) - ntpNow(0);
  const video = clock.mapVideo(videoFixed, localBase);
  assert.ok(Math.abs(video.presentationTimeMs - (localBase + 250)) <= 1);
  assert.ok(Math.abs(video.presentationTimeMs - audio.presentationTimeMs) <= 51);

  clock.resetAudio();
  assert.equal(clock.mapAudio(0x20, localBase), null);
  assert.equal(clock.mapVideo(videoFixed, localBase).source, 'ntp');
});

test('buildTimingRequest stamps the local transmit time', () => {
  const request = decodeTimingPacket(buildTimingRequest(17, () => 123n));
  assert.equal(request.type, TIMING_REQUEST);
  assert.equal(request.sequence, 17);
  assert.equal(request.transmit, 123n);
});

test('buildTimingReply ignores non-timing datagrams', () => {
  assert.equal(buildTimingReply(Buffer.alloc(8)), null);
  assert.equal(buildTimingReply(Buffer.alloc(33)), null);
  const notRequest = encodeTimingPacket({ type: TIMING_REPLY, sequence: 1 });
  assert.equal(buildTimingReply(notRequest), null);
  const wrongVersion = encodeTimingPacket({ type: TIMING_REQUEST, sequence: 2 });
  wrongVersion[0] = 0x40;
  assert.equal(buildTimingReply(wrongVersion), null);
});

test('MirrorTransport answers timing requests over UDP', async () => {
  const transport = new MirrorTransport();
  const ports = await transport.start('127.0.0.1');
  const client = dgram.createSocket('udp4');
  try {
    const request = encodeTimingPacket({ type: TIMING_REQUEST, sequence: 9, transmit: ntpNow() });
    const replied = new Promise((resolve) => client.once('message', resolve));
    client.send(request, ports.timingPort, '127.0.0.1');
    const reply = decodeTimingPacket(await replied);
    assert.equal(reply.type, TIMING_REPLY);
    assert.equal(reply.sequence, 9);
    assert.ok(reply.transmit > 0n);
  } finally {
    client.close();
    await transport.close();
  }
});

test('MirrorTransport actively probes the sender timing port', async () => {
  const sender = dgram.createSocket('udp4');
  await new Promise((resolve) => sender.bind(0, '127.0.0.1', resolve));
  const transport = new MirrorTransport();
  await transport.start('127.0.0.1');
  try {
    sender.on('message', (message, remote) => {
      const request = decodeTimingPacket(message);
      sender.send(encodeTimingPacket({
        type: TIMING_REPLY,
        sequence: request.sequence,
        origin: request.transmit,
        receive: ntpNow(1_000_005),
        transmit: ntpNow(1_000_007),
      }), remote.port, remote.address);
    });
    const synchronized = new Promise((resolve) => transport.once('timing-sync', resolve));
    transport.configureTiming({ address: '127.0.0.1', port: sender.address().port });
    const sample = await synchronized;
    assert.equal(sample.type, TIMING_REPLY);
    assert.ok(Number.isFinite(sample.offsetMs));
    assert.ok(Number.isFinite(sample.roundTripMs));
  } finally {
    sender.close();
    await transport.close();
  }
});

test('MirrorTransport reports active video connections during fast reconnects', async () => {
  const transport = new MirrorTransport();
  const ports = await transport.start('127.0.0.1');
  const connected = [];
  const disconnected = [];
  transport.on('video-connection', (event) => connected.push(event));
  transport.on('video-disconnection', (event) => disconnected.push(event));
  const first = net.connect(ports.videoPort, '127.0.0.1');
  const second = net.connect(ports.videoPort, '127.0.0.1');
  try {
    await Promise.all([
      new Promise((resolve, reject) => first.once('connect', resolve).once('error', reject)),
      new Promise((resolve, reject) => second.once('connect', resolve).once('error', reject)),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(connected.map((event) => event.activeConnections), [1, 2]);

    first.destroy();
    await new Promise((resolve) => first.once('close', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnected[0].activeConnections, 1);

    second.destroy();
    await new Promise((resolve) => second.once('close', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnected[1].activeConnections, 0);
  } finally {
    first.destroy();
    second.destroy();
    await transport.close();
  }
});
