import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { FfplayVideoSink, buildFfplayArgs, probeFfplay } from '../src/ffplay.js';

class FakeChild extends EventEmitter {
  constructor({ exitCode = 0 } = {}) {
    super();
    this.pid = 1234;
    this.stdin = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.once('finish', () => queueMicrotask(() => this.emit('exit', exitCode, null)));
  }

  kill() {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

test('buildFfplayArgs configures raw low-latency H.264 input', () => {
  const args = buildFfplayArgs({ title: 'Test Mirror', fullscreen: true, extraArgs: ['-x', '1280'] });
  assert.deepEqual(args.slice(-3), ['-i', 'pipe:0', '-an']);
  assert.ok(args.includes('nobuffer'));
  assert.ok(args.includes('low_delay'));
  assert.ok(args.includes('-framedrop'));
  assert.ok(args.includes('-fs'));
  assert.equal(args[args.indexOf('-window_title') + 1], 'Test Mirror');
  assert.ok(args.indexOf('-x') < args.indexOf('-i'));
});

test('FfplayVideoSink lazily starts and writes codec/video chunks in order', async () => {
  const child = new FakeChild();
  const calls = [];
  const chunks = [];
  child.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const sink = new FfplayVideoSink({
    executable: 'fake-ffplay',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const started = once(sink, 'started');
  assert.equal(sink.writeCodec({ annexB: Buffer.from([0, 0, 0, 1, 0x67]) }), true);
  assert.equal(sink.writeVideo({ annexB: Buffer.from([0, 0, 0, 1, 0x65]), keyframe: true }), true);
  await started;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'fake-ffplay');
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x65]));
  await sink.stop();
  assert.equal(sink.running, false);
});

test('probeFfplay reports process exit status', async () => {
  const successfulSpawn = () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const failedSpawn = () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit('error', new Error('not found')));
    return child;
  };
  assert.equal(await probeFfplay({ spawnProcess: successfulSpawn }), true);
  assert.equal(await probeFfplay({ spawnProcess: failedSpawn }), false);
});
