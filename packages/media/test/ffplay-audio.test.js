import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AAC_ELD_CONFIG, AAC_ELD_NO_DATA_MARKER, FfplayAudioSink,
  buildAacEldSdp, buildFfplayAudioArgs, wrapAacEldRtp,
} from '../src/ffplay-audio.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.stdin = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

class FakeSocket extends EventEmitter {
  sent = [];
  closed = false;

  send(message, port, host, callback) {
    this.sent.push({ message: Buffer.from(message), port, host });
    queueMicrotask(() => callback?.(null));
  }

  close() {
    this.closed = true;
  }
}

test('AAC-ELD SDP advertises the real codec config and RFC 3640 framing', () => {
  const sdp = buildAacEldSdp({ port: 5004 });
  assert.match(sdp, /m=audio 5004 RTP\/AVP 96/);
  assert.match(sdp, /MPEG4-GENERIC\/44100\/2/);
  assert.match(sdp, new RegExp(`config=${AAC_ELD_CONFIG}`));
  assert.match(sdp, /SizeLength=13/);
  const args = buildFfplayAudioArgs();
  assert.ok(args.includes('file,crypto,data,udp,rtp,pipe'));
  assert.deepEqual(args.slice(-4), ['-i', 'pipe:0', '-vn', '-nodisp']);
});

test('wrapAacEldRtp writes RTP and a single 16-bit AU header', () => {
  const payload = Buffer.from([0x8c, 1, 2, 3]);
  const packet = wrapAacEldRtp(payload, {
    sequence: 0xabcd,
    timestamp: 0xfedcba98,
    ssrc: 0x10203040,
  });
  assert.equal(packet[0], 0x80);
  assert.equal(packet[1], 0xe0);
  assert.equal(packet.readUInt16BE(2), 0xabcd);
  assert.equal(packet.readUInt32BE(4), 0xfedcba98);
  assert.equal(packet.readUInt32BE(8), 0x10203040);
  assert.equal(packet.readUInt16BE(12), 16);
  assert.equal(packet.readUInt16BE(14), payload.length << 3);
  assert.deepEqual(packet.subarray(16), payload);
});

test('FfplayAudioSink launches from SDP and forwards synchronized AAC-ELD', async () => {
  const child = new FakeChild();
  const socket = new FakeSocket();
  const stdin = [];
  const calls = [];
  child.stdin.on('data', (chunk) => stdin.push(Buffer.from(chunk)));
  const sink = new FfplayAudioSink({
    executable: 'fake-ffplay',
    port: 5004,
    startupDelayMs: 0,
    clock: () => 1000,
    createSocket: () => socket,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const started = once(sink, 'started');
  const forwarded = once(sink, 'packet');
  assert.equal(sink.writeAudio({
    // AAC-ELD is a raw bitstream and valid access units do not share a magic byte.
    payload: Buffer.from([0x70, 1, 2]),
    encrypted: false,
    compressionType: 8,
    sequence: 7,
    timestamp: 480,
    timing: { presentationTimeMs: 1000 },
  }), true);
  await started;
  await forwarded;
  assert.equal(calls[0].command, 'fake-ffplay');
  assert.match(Buffer.concat(stdin).toString(), /OpenMirror AAC-ELD/);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].port, 5004);
  assert.equal(socket.sent[0].message.readUInt16BE(2), 7);
  assert.equal(socket.sent[0].message.readUInt32BE(4), 480);
  await sink.stop();
  assert.equal(socket.closed, true);
  assert.equal(sink.running, false);
});

test('FfplayAudioSink rejects encrypted, empty-marker, and oversized frames', () => {
  const sink = new FfplayAudioSink({ port: 5004 });
  const reasons = [];
  sink.on('dropped', ({ reason }) => reasons.push(reason));
  assert.equal(sink.writeAudio({ payload: Buffer.from([0x8c]), encrypted: true }), false);
  assert.equal(sink.writeAudio({ payload: AAC_ELD_NO_DATA_MARKER, encrypted: false, compressionType: 8 }), false);
  assert.equal(sink.writeAudio({
    payload: Buffer.alloc(0x2000, 0x70),
    encrypted: false,
    compressionType: 8,
  }), false);
  assert.deepEqual(reasons, ['encrypted', 'no-data', 'oversized']);
});

test('FfplayAudioSink paces packets at the shared presentation time', async () => {
  const child = new FakeChild();
  const socket = new FakeSocket();
  const sink = new FfplayAudioSink({
    port: 5004,
    startupDelayMs: 0,
    createSocket: () => socket,
    spawnProcess() {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const forwarded = once(sink, 'packet');
  sink.writeAudio({
    payload: Buffer.from([0x8c, 1]),
    encrypted: false,
    compressionType: 8,
    sequence: 8,
    timestamp: 960,
    timing: { presentationTimeMs: Date.now() + 25 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(socket.sent.length, 0);
  await forwarded;
  assert.equal(socket.sent.length, 1);
  await sink.stop();
});
