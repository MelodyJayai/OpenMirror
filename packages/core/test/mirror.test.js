import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { MirrorFrameParser, MirrorTransport, MIRROR_HEADER_BYTES } from '../src/stream/mirror.js';
import {
  AUDIO_PAYLOAD,
  parseAudioRetransmitRequest,
} from '../src/stream/rtp.js';
import { RtspParser } from '../src/rtsp/parser.js';

function packet(payload, {
  type = 0,
  flags = 0,
  option = 0,
  timestamp = 0n,
  sourceDimensions = null,
  encodedDimensions = null,
} = {}) {
  const header = Buffer.alloc(MIRROR_HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  header[4] = type;
  header[5] = flags;
  header.writeUInt16LE(option, 6);
  header.writeBigUInt64LE(timestamp, 8);
  if (sourceDimensions) {
    header.writeFloatLE(sourceDimensions.width, 40);
    header.writeFloatLE(sourceDimensions.height, 44);
  }
  if (encodedDimensions) {
    header.writeFloatLE(encodedDimensions.width, 56);
    header.writeFloatLE(encodedDimensions.height, 60);
  }
  return Buffer.concat([header, payload]);
}

test('MirrorFrameParser handles fragmented and pipelined frames', () => {
  const frames = [];
  const parser = new MirrorFrameParser((frame) => frames.push(frame));
  const bytes = Buffer.concat([
    packet(Buffer.from('one'), {
      type: 1,
      timestamp: 42n,
      sourceDimensions: { width: 640, height: 360 },
      encodedDimensions: { width: 1280, height: 720 },
    }),
    packet(Buffer.from('two'), { type: 0, flags: 0x10, option: 0x0116, timestamp: 43n }),
  ]);
  parser.push(bytes.subarray(0, 17));
  parser.push(bytes.subarray(17));
  assert.deepEqual(frames.map((f) => [f.type, f.timestamp, f.payload.toString()]), [
    [1, 42n, 'one'],
    [0, 43n, 'two'],
  ]);
  assert.equal(frames[1].payloadFlags, 0x10);
  assert.equal(frames[1].payloadOption, 0x0116);
  assert.equal(frames[1].rawTypeAndFlags, 0x1000);
  assert.deepEqual(frames[0].displayDimensions, {
    source: { width: 640, height: 360, orientation: 'landscape' },
    encoded: { width: 1280, height: 720, orientation: 'landscape' },
  });
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

test('MirrorTransport parses and acknowledges reverse HTTP event requests', async () => {
  const transport = new MirrorTransport();
  const ports = await transport.start('127.0.0.1');
  let socket;

  try {
    const requestReceived = new Promise((resolve) => transport.once('event-request', resolve));
    const responseReceived = new Promise((resolve, reject) => {
      socket = net.connect(ports.eventPort, '127.0.0.1');
      const parser = new RtspParser(resolve);
      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('error', reject);
    });
    await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
    const body = Buffer.from('event-body');
    const request = Buffer.concat([
      Buffer.from(`POST /event HTTP/1.1\r\nCSeq: 9\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
      body,
    ]);
    socket.write(request.subarray(0, 13));
    socket.write(request.subarray(13));

    const event = await requestReceived;
    assert.equal(event.method, 'POST');
    assert.equal(event.uri, '/event');
    assert.deepEqual(event.body, body);

    const response = await responseReceived;
    assert.equal(response.kind, 'response');
    assert.equal(response.version, 'HTTP/1.1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.cseq, '9');
  } finally {
    socket?.destroy();
    await transport.close();
  }
});

test('MirrorTransport requests and receives retransmitted audio over the control port', async () => {
  const transport = new MirrorTransport();
  const remote = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    remote.once('error', reject);
    remote.bind(0, '127.0.0.1', resolve);
  });
  const ports = await transport.start('127.0.0.1');

  try {
    assert.equal(
      transport.requestAudioRetransmit({ sequence: 1, count: 1 }),
      false,
    );
    transport.configureAudio({
      address: '127.0.0.1',
      controlPort: remote.address().port,
    });
    const requestReceived = new Promise((resolve) => remote.once('message', (...args) => resolve(args)));
    assert.equal(transport.requestAudioRetransmit({ sequence: 42, count: 2 }), true);
    const [request, requestRemote] = await requestReceived;
    assert.deepEqual(parseAudioRetransmitRequest(request), {
      version: 2,
      marker: true,
      payloadType: AUDIO_PAYLOAD.RETRANSMIT_REQUEST,
      requestSequence: 0,
      sequence: 42,
      count: 2,
    });
    assert.equal(requestRemote.port, ports.audioControlPort);

    const inner = Buffer.alloc(12 + 3);
    inner[0] = 0x80;
    inner[1] = AUDIO_PAYLOAD.DATA;
    inner.writeUInt16BE(42, 2);
    inner.writeUInt32BE(480, 4);
    inner.writeUInt32BE(1, 8);
    Buffer.from([0x70, 1, 2]).copy(inner, 12);
    const response = Buffer.concat([
      Buffer.from([0x80, 0x80 | AUDIO_PAYLOAD.RETRANSMITTED, 0, 0]),
      inner,
    ]);
    const recovered = new Promise((resolve) => {
      transport.once('audio-retransmitted-packet', resolve);
    });
    remote.send(response, ports.audioControlPort, '127.0.0.1');
    const packet = await recovered;
    assert.equal(packet.sequence, 42);
    assert.equal(packet.retransmitted, true);
    assert.deepEqual(packet.payload, Buffer.from([0x70, 1, 2]));
  } finally {
    remote.close();
    await transport.close();
  }
});
