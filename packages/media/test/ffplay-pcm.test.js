import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { FfplayPcmSink, buildFfplayPcmArgs, pcmChannelLayout } from '../src/ffplay-pcm.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 8765;
    this.stdin = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

test('PCM ffplay args describe a raw s16le stdin stream', () => {
  const args = buildFfplayPcmArgs({ sampleRate: 44100, channels: 2 });
  const format = args.indexOf('-f');
  assert.deepEqual(args.slice(format), [
    '-f', 's16le',
    '-sample_rate', '44100',
    '-ch_layout', 'stereo',
    '-i', 'pipe:0',
    '-vn',
    '-nodisp',
  ]);
  assert.equal(pcmChannelLayout(1), 'mono');
  assert.equal(pcmChannelLayout(6), '6c');
  assert.throws(() => pcmChannelLayout(0));
  assert.throws(() => buildFfplayPcmArgs({ sampleRate: 0 }));
});

test('FfplayPcmSink launches ffplay and streams synchronized samples to stdin', async () => {
  const child = new FakeChild();
  const stdin = [];
  const calls = [];
  child.stdin.on('data', (chunk) => stdin.push(Buffer.from(chunk)));
  const sink = new FfplayPcmSink({
    executable: 'fake-ffplay',
    sampleRate: 44100,
    channels: 2,
    startupDelayMs: 0,
    clock: () => 1000,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const started = once(sink, 'started');
  const forwarded = once(sink, 'packet');
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // two stereo frames
  assert.equal(sink.writePcm({
    pcm,
    sequence: 9,
    timestamp: 352,
    timing: { presentationTimeMs: 1000 },
  }), true);
  await started;
  const [sent] = await forwarded;
  assert.equal(calls[0].command, 'fake-ffplay');
  assert.ok(calls[0].args.includes('s16le'));
  assert.equal(sent.samples, 2);
  assert.equal(sent.sequence, 9);
  assert.deepEqual(Buffer.concat(stdin), pcm);
  await sink.stop();
  assert.equal(sink.running, false);
});

test('FfplayPcmSink rejects empty and frame-misaligned buffers', () => {
  const sink = new FfplayPcmSink({ channels: 2 });
  const reasons = [];
  sink.on('dropped', ({ reason }) => reasons.push(reason));
  assert.equal(sink.writePcm({ pcm: Buffer.alloc(0) }), false);
  assert.equal(sink.writePcm({ pcm: Buffer.alloc(6) }), false); // 1.5 stereo frames
  assert.equal(sink.writePcm(null), false);
  assert.deepEqual(reasons, ['empty', 'unaligned', 'empty']);
});

test('FfplayPcmSink paces samples at the shared presentation time', async () => {
  const child = new FakeChild();
  const stdin = [];
  child.stdin.on('data', (chunk) => stdin.push(Buffer.from(chunk)));
  const sink = new FfplayPcmSink({
    channels: 2,
    startupDelayMs: 0,
    spawnProcess() {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const forwarded = once(sink, 'packet');
  sink.writePcm({
    pcm: Buffer.from([5, 0, 6, 0]),
    sequence: 10,
    timestamp: 704,
    timing: { presentationTimeMs: Date.now() + 25 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stdin.length, 0);
  await forwarded;
  assert.equal(Buffer.concat(stdin).length, 4);
  await sink.stop();
});

test('FfplayPcmSink drops the queue when ffplay exits', async () => {
  const child = new FakeChild();
  const sink = new FfplayPcmSink({
    channels: 2,
    startupDelayMs: 0,
    spawnProcess() {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const drops = [];
  sink.on('dropped', (info) => drops.push(info));
  sink.writePcm({
    pcm: Buffer.from([7, 0, 8, 0]),
    timing: { presentationTimeMs: Date.now() + 3_000 },
  });
  await once(sink, 'started');
  const exited = once(sink, 'exit');
  child.emit('exit', 1, null);
  await exited;
  assert.equal(sink.running, false);
  assert.ok(drops.some(({ reason }) => reason === 'process-exit'));
});
