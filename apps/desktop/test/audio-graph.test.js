import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioGraph, dbToGain, hexToBytes, planarize,
} from '../src/renderer/audio-graph.js';

class FakeAudioContext {
  currentTime = 0;
  destination = { name: 'destination' };
  closed = false;
  sources = [];

  constructor(sampleRate) {
    this.sampleRate = sampleRate;
  }

  createGain() {
    return {
      gain: { value: 1 },
      connected: null,
      connect(node) { this.connected = node; },
    };
  }

  createBuffer(channels, frames, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      sampleRate,
      length: frames,
      numberOfChannels: channels,
      getChannelData: (channel) => data[channel],
    };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      connected: null,
      startedAt: null,
      connect(node) { this.connected = node; },
      start: (when) => { /* replaced below */ },
    };
    source.start = (when) => { source.startedAt = when; };
    this.sources.push(source);
    return source;
  }

  close() {
    this.closed = true;
  }
}

function graphWith({ nowMs = 10_000 } = {}) {
  const contexts = [];
  const state = { nowMs };
  const graph = new AudioGraph({
    clock: () => state.nowMs,
    createContext: (sampleRate) => {
      const context = new FakeAudioContext(sampleRate);
      contexts.push(context);
      return context;
    },
  });
  return { graph, contexts, state };
}

test('dbToGain maps sender volume to linear gain', () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(dbToGain(-144), 0);
  assert.equal(dbToGain(-6, true), 0);
  assert.equal(dbToGain(undefined), 1);
  assert.ok(Math.abs(dbToGain(-20) - 0.1) < 1e-9);
});

test('hexToBytes decodes the AAC-ELD AudioSpecificConfig', () => {
  assert.deepEqual([...hexToBytes('f8e85000')], [0xf8, 0xe8, 0x50, 0x00]);
  assert.throws(() => hexToBytes('xyz'));
  assert.throws(() => hexToBytes('abc'));
});

test('planarize splits interleaved stereo into normalized planes', () => {
  const planes = planarize(Int16Array.of(32767, -32768, 0, 16384), 2);
  assert.equal(planes.length, 2);
  assert.ok(Math.abs(planes[0][0] - 32767 / 32768) < 1e-6);
  assert.equal(planes[1][0], -1);
  assert.equal(planes[0][1], 0);
  assert.equal(planes[1][1], 0.5);
  assert.throws(() => planarize(Int16Array.of(1, 2, 3), 2));
});

test('playPcm schedules samples at the shared presentation time', () => {
  const { graph, contexts, state } = graphWith();
  const result = graph.playPcm({
    pcm: Int16Array.of(1, 2, 3, 4),
    sampleRate: 44100,
    channels: 2,
    presentationTimeMs: state.nowMs + 500,
  });
  assert.equal(result.frames, 2);
  assert.equal(contexts.length, 1);
  const [source] = contexts[0].sources;
  assert.equal(source.startedAt, 0.5);
  assert.equal(source.connected.connected, contexts[0].destination);
  assert.ok(Math.abs(source.buffer.getChannelData(0)[1] - 3 / 32768) < 1e-9);
});

test('unsynchronized packets play back-to-back on the context clock', () => {
  const { graph, contexts } = graphWith();
  const first = graph.playPcm({ pcm: new Int16Array(882), sampleRate: 44100, channels: 2 });
  const second = graph.playPcm({ pcm: new Int16Array(882), sampleRate: 44100, channels: 2 });
  assert.equal(first.when, 0);
  assert.ok(Math.abs(second.when - 441 / 44100) < 1e-9);
  assert.equal(contexts.length, 1);
});

test('late and far-future packets are dropped', () => {
  const { graph, state } = graphWith();
  assert.deepEqual(graph.playPcm({
    pcm: Int16Array.of(1, 2),
    sampleRate: 44100,
    channels: 2,
    presentationTimeMs: state.nowMs - 300,
  }), { dropped: 'late' });
  assert.deepEqual(graph.playPcm({
    pcm: Int16Array.of(1, 2),
    sampleRate: 44100,
    channels: 2,
    presentationTimeMs: state.nowMs + 60_000,
  }), { dropped: 'timing-outlier' });
});

test('sample-rate changes rebuild the context and volume persists', () => {
  const { graph, contexts } = graphWith();
  graph.setVolume({ volumeDb: -20 });
  graph.playPcm({ pcm: Int16Array.of(1, 2), sampleRate: 44100, channels: 2 });
  graph.playPcm({ pcm: Int16Array.of(1, 2), sampleRate: 48000, channels: 2 });
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].closed, true);
  assert.equal(graph.sampleRate, 48000);
  const gainNode = contexts[1].sources[0].connected;
  assert.ok(Math.abs(gainNode.gain.value - 0.1) < 1e-9);
  graph.setVolume({ muted: true });
  assert.equal(gainNode.gain.value, 0);
  graph.close();
  assert.equal(contexts[1].closed, true);
});
