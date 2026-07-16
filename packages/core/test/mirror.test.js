import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MirrorFrameParser, MirrorTransport, MIRROR_HEADER_BYTES } from '../src/stream/mirror.js';

function packet(payload, { type = 0, timestamp = 0n } = {}) {
  const header = Buffer.alloc(MIRROR_HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt16LE(type, 4);
  header.writeBigUInt64LE(timestamp, 8);
  return Buffer.concat([header, payload]);
}

test('MirrorFrameParser handles fragmented and pipelined frames', () => {
  const frames = [];
  const parser = new MirrorFrameParser((frame) => frames.push(frame));
  const bytes = Buffer.concat([
    packet(Buffer.from('one'), { type: 1, timestamp: 42n }),
    packet(Buffer.from('two'), { type: 0, timestamp: 43n }),
  ]);
  parser.push(bytes.subarray(0, 17));
  parser.push(bytes.subarray(17));
  assert.deepEqual(frames.map((f) => [f.type, f.timestamp, f.payload.toString()]), [
    [1, 42n, 'one'],
    [0, 43n, 'two'],
  ]);
});

test('MirrorFrameParser rejects unreasonable payload sizes', () => {
  const parser = new MirrorFrameParser(() => {}, { maxFrameBytes: 8 });
  const header = Buffer.alloc(MIRROR_HEADER_BYTES);
  header.writeUInt32LE(9, 0);
  assert.throws(() => parser.push(header), /too large/);
});

test('MirrorTransport allocates real ports and receives a frame', async () => {
  const transport = new MirrorTransport();
  const ports = await transport.start('127.0.0.1');
  assert.ok(ports.videoPort > 0 && ports.eventPort > 0 && ports.timingPort > 0);

  try {
    const received = new Promise((resolve) => transport.once('video-frame', resolve));
    const socket = net.connect(ports.videoPort, '127.0.0.1');
    await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
    socket.write(packet(Buffer.from([1, 2, 3]), { type: 1, timestamp: 99n }));
    const frame = await received;
    assert.equal(frame.type, 1);
    assert.equal(frame.timestamp, 99n);
    assert.deepEqual(frame.payload, Buffer.from([1, 2, 3]));
    socket.end();
  } finally {
    await transport.close();
  }
});
