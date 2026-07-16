import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudioRetransmitRequest,
  parseAudioRetransmitRequest,
  parseRetransmittedAudioPacket,
  parseRtpPacket,
  parseAudioSyncPacket,
  isAudioNoDataPayload,
  RtpSequencer,
  AUDIO_PAYLOAD,
  AAC_ELD_NO_DATA_MARKER,
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

test('AAC-ELD no-data payloads are distinguished from decoder access units', () => {
  assert.equal(isAudioNoDataPayload(Buffer.alloc(0), 8), true);
  assert.equal(isAudioNoDataPayload(AAC_ELD_NO_DATA_MARKER, 8), true);
  assert.equal(isAudioNoDataPayload(AAC_ELD_NO_DATA_MARKER, 2), false);
  assert.equal(isAudioNoDataPayload(Buffer.from([0x00, 0x68, 0x34, 0x01]), 8), false);
  assert.equal(isAudioNoDataPayload(Buffer.from([0x70, 1, 2]), 8), false);
  assert.equal(isAudioNoDataPayload(null, 8), false);
});

test('audio retransmit request and response packets match AirPlay control framing', () => {
  const request = buildAudioRetransmitRequest({
    requestSequence: 7,
    sequence: 0xfffe,
    count: 3,
  });
  assert.deepEqual(parseAudioRetransmitRequest(request), {
    version: 2,
    marker: true,
    payloadType: AUDIO_PAYLOAD.RETRANSMIT_REQUEST,
    requestSequence: 7,
    sequence: 0xfffe,
    count: 3,
  });

  const inner = rtp({
    sequence: 0xffff,
    timestamp: 88200,
    payload: Buffer.from([0x70, 1, 2]),
  });
  const response = Buffer.concat([
    Buffer.from([0x80, 0x80 | AUDIO_PAYLOAD.RETRANSMITTED, 0, 7]),
    inner,
  ]);
  const packet = parseRetransmittedAudioPacket(response);
  assert.equal(packet.retransmitted, true);
  assert.equal(packet.retransmitSequence, 7);
  assert.equal(packet.sequence, 0xffff);
  assert.deepEqual(packet.payload, Buffer.from([0x70, 1, 2]));
  assert.throws(
    () => parseRetransmittedAudioPacket(Buffer.alloc(8)),
    /at least 16/,
  );
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
  const events = [];
  const seq = new RtpSequencer((p) => out.push(p.sequence), {
    depth: 3,
    onEvent: (event) => events.push(event),
  });
  seq.push({ sequence: 1 });
  seq.push({ sequence: 3 }); // 2 lost
  seq.push({ sequence: 4 });
  seq.push({ sequence: 5 });
  seq.push({ sequence: 6 }); // buffer over depth → skip to 3
  assert.deepEqual(out, [1, 3, 4, 5, 6]);
  assert.deepEqual(seq.stats, {
    received: 5,
    emitted: 5,
    late: 0,
    duplicates: 0,
    reordered: 4,
    gapsSkipped: 1,
    maxPending: 4,
    discontinuities: 0,
    retransmitRequests: 1,
    retransmitPacketsRequested: 1,
    retransmitRecovered: 0,
    retransmitUnrecovered: 1,
    retransmittedReceived: 0,
    retransmittedRecovered: 0,
    retransmittedLate: 0,
    retransmittedDuplicates: 0,
    pending: 0,
    missing: 0,
    nextSequence: 7,
  });
  assert.equal(events[0].type, 'retransmit-request');
  assert.equal(events.at(-1).type, 'gap');
  assert.equal(events.at(-1).skipped, 1);
});

test('RtpSequencer reports duplicate and late packets and resets buffered state', () => {
  const out = [];
  const events = [];
  const seq = new RtpSequencer((p) => out.push(p.sequence), {
    onEvent: (event) => events.push(event),
  });

  seq.push({ sequence: 20 });
  seq.push({ sequence: 20 });
  seq.push({ sequence: 22 });
  seq.push({ sequence: 22 });
  seq.push({ sequence: 19 });
  assert.deepEqual(out, [20]);
  assert.equal(seq.stats.duplicates, 2);
  assert.equal(seq.stats.late, 1);
  assert.equal(seq.stats.pending, 1);

  seq.reset();
  assert.equal(seq.stats.pending, 0);
  assert.equal(seq.stats.nextSequence, null);
  assert.equal(events.at(-1).type, 'reset');
  assert.equal(events.at(-1).discarded, 1);

  seq.push({ sequence: 100 });
  assert.deepEqual(out, [20, 100]);
  seq.reset({ resetStats: true });
  assert.deepEqual(seq.stats, {
    received: 0,
    emitted: 0,
    late: 0,
    duplicates: 0,
    reordered: 0,
    gapsSkipped: 0,
    maxPending: 0,
    discontinuities: 0,
    retransmitRequests: 0,
    retransmitPacketsRequested: 0,
    retransmitRecovered: 0,
    retransmitUnrecovered: 0,
    retransmittedReceived: 0,
    retransmittedRecovered: 0,
    retransmittedLate: 0,
    retransmittedDuplicates: 0,
    pending: 0,
    missing: 0,
    nextSequence: null,
  });
});

test('RtpSequencer requests, retries, and accounts for retransmitted recovery', () => {
  const out = [];
  const events = [];
  const seq = new RtpSequencer((packet) => out.push(packet.sequence), {
    retransmitIntervalPackets: 2,
    maxRetransmitAttempts: 2,
    onEvent: (event) => events.push(event),
  });

  seq.push({ sequence: 10 });
  seq.push({ sequence: 12 });
  assert.deepEqual(
    events.filter((event) => event.type === 'retransmit-request')
      .map(({ sequence, count, attempt }) => ({ sequence, count, attempt })),
    [{ sequence: 11, count: 1, attempt: 1 }],
  );
  seq.push({ sequence: 13 });
  seq.push({ sequence: 14 });
  assert.equal(
    events.filter((event) => event.type === 'retransmit-request').length,
    2,
  );
  seq.push({ sequence: 15 });
  seq.push({ sequence: 16 });
  assert.equal(
    events.filter((event) => event.type === 'retransmit-request').length,
    2,
    'retry attempts are bounded while the gap remains unresolved',
  );
  seq.push({ sequence: 11, retransmitted: true });
  assert.deepEqual(out, [10, 11, 12, 13, 14, 15, 16]);
  assert.equal(seq.stats.retransmitRecovered, 1);
  assert.equal(seq.stats.retransmittedReceived, 1);
  assert.equal(seq.stats.retransmittedRecovered, 1);
  assert.equal(seq.stats.retransmitUnrecovered, 0);
  assert.equal(seq.stats.missing, 0);
});

test('RtpSequencer resynchronizes a large sequence discontinuity', () => {
  const out = [];
  const events = [];
  const seq = new RtpSequencer((packet) => out.push(packet.sequence), {
    depth: 4,
    maxGapDistance: 16,
    onEvent: (event) => events.push(event),
  });
  seq.push({ sequence: 1 });
  seq.push({ sequence: 1000 });
  assert.deepEqual(out, [1, 1000]);
  assert.equal(seq.stats.discontinuities, 1);
  assert.equal(seq.stats.gapsSkipped, 998);
  assert.equal(events.at(-1).type, 'discontinuity');
});

test('RtpSequencer batches missing ranges across 16-bit wraparound', () => {
  const events = [];
  const seq = new RtpSequencer(() => {}, {
    maxRetransmitBatch: 2,
    onEvent: (event) => events.push(event),
  });
  seq.push({ sequence: 0xfffe });
  seq.push({ sequence: 2 });
  assert.deepEqual(
    events.filter((event) => event.type === 'retransmit-request')
      .map(({ sequence, count }) => ({ sequence, count })),
    [
      { sequence: 0xffff, count: 2 },
      { sequence: 1, count: 1 },
    ],
  );
});
