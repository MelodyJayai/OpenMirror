import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  ntpNow, ntpToUnixMs, encodeTimingPacket, decodeTimingPacket, buildTimingReply,
  TIMING_REQUEST, TIMING_REPLY,
} from '../src/stream/timing.js';
import { MirrorTransport } from '../src/stream/mirror.js';

test('NTP timestamps round-trip through unix milliseconds', () => {
  const ms = 1752652800123; // some fixed instant
  const ntp = ntpNow(ms);
  assert.ok(Math.abs(ntpToUnixMs(ntp) - ms) <= 1); // fraction rounding
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
