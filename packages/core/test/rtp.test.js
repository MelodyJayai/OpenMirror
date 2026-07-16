import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRtpPacket, parseAudioSyncPacket, RtpSequencer, AUDIO_PAYLOAD,
} from '../src/stream/rtp.js';

function rtp({ payloadType = AUDIO_PAYLOAD.DATA, sequence = 0, timestamp = 0, ssrc = 1, marker = false, payload = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0) | payloadType;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return Buffer.concat([header, payload]);
}

test('parseRtpPacket extracts header fields and payload', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const packet = parseRtpPacket(rtp({ sequence: 4711, timestamp: 88200, ssrc: 0xdead, marker: true, payload }));
  assert.equal(packet.version, 2);
  assert.equal(packet.marker, true);
  assert.equal(packet.payloadType, AUDIO_PAYLOAD.DATA);
  assert.equal(packet.sequence, 4711);
  assert.equal(packet.timestamp, 88200);
  assert.equal(packet.ssrc, 0xdead);
  assert.deepEqual(packet.payload, payload);
});

test('parseRtpPacket strips padding and rejects truncated packets', () => {
  const padded = rtp({ payload: Buffer.from([9, 9, 0, 0, 3]) });
  padded[0] |= 0x20; // padding flag; last byte (3) = pad length
  assert.deepEqual(parseRtpPacket(padded).payload, Buffer.from([9, 9]));
  assert.throws(() => parseRtpPacket(Buffer.alloc(4)), /too short/);
  const wrongVersion = rtp();
  wrongVersion[0] = 0x40;
  assert.throws(() => parseRtpPacket(wrongVersion), /version/);
  const badPadding = rtp({ payload: Buffer.from([1, 99]) });
  badPadding[0] |= 0x20;
  assert.throws(() => parseRtpPacket(badPadding), /padding/);
});

test('parseAudioSyncPacket extracts the RTP to remote-NTP anchor', () => {
  const packet = Buffer.alloc(20);
  packet[0] = 0x90;
  packet[1] = 0xd4;
  packet.writeUInt16BE(4, 2);
  packet.writeUInt32BE(0xfffffff0, 4);
  packet.writeBigUInt64BE(0x123456789abcdef0n, 8);
  packet.writeUInt32BE(0x00001d39, 16);
  assert.deepEqual(parseAudioSyncPacket(packet), {
    version: 2,
    first: true,
    sequence: 4,
    rtpTimestamp: 0xfffffff0,
    remoteNtp: 0x123456789abcdef0n,
    nextRtpTimestamp: 0x00001d39,
  });
  assert.throws(() => parseAudioSyncPacket(Buffer.alloc(19)), /at least 20/);
  packet[1] = 0xd3;
  assert.throws(() => parseAudioSyncPacket(packet), /not an AirPlay audio sync/);
});

test('RtpSequencer reorders out-of-order packets and drops stale ones', () => {
  const out = [];
  const seq = new RtpSequencer((p) => out.push(p.sequence));
  const packet = (sequence) => ({ sequence });

  seq.push(packet(10));
  seq.push(packet(12)); // held until 11 arrives
  seq.push(packet(11));
  seq.push(packet(9));  // late: dropped
  assert.deepEqual(out, [10, 11, 12]);
});

test('RtpSequencer handles 16-bit wraparound', () => {
  const out = [];
  const seq = new RtpSequencer((p) => out.push(p.sequence));
  seq.push({ sequence: 65534 });
  seq.push({ sequence: 0 }); // held
  seq.push({ sequence: 65535 });
  assert.deepEqual(out, [65534, 65535, 0]);
});

test('RtpSequencer skips ahead when a gap never fills', () => {
  const out = [];
  const seq = new RtpSequencer((p) => out.push(p.sequence), { depth: 3 });
  seq.push({ sequence: 1 });
  seq.push({ sequence: 3 }); // 2 lost
  seq.push({ sequence: 4 });
  seq.push({ sequence: 5 });
  seq.push({ sequence: 6 }); // buffer over depth → skip to 3
  assert.deepEqual(out, [1, 3, 4, 5, 6]);
});
