import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaActivityMonitor } from '../src/stream/activity.js';

test('MediaActivityMonitor reports idle and resume transitions', () => {
  let now = 1000;
  const events = [];
  const monitor = new MediaActivityMonitor({
    clock: () => now,
    videoIdleMs: 500,
    mediaIdleMs: 800,
    autoCheck: false,
  });
  monitor.on('state', (event) => events.push(event));

  monitor.signal('video');
  assert.deepEqual(monitor.snapshot, {
    videoState: 'streaming',
    mediaState: 'streaming',
    lastVideoAt: 1000,
    lastMediaAt: 1000,
    lastHeartbeatAt: null,
  });

  now = 1400;
  monitor.signal('heartbeat');
  now = 1500;
  monitor.check();
  assert.equal(monitor.snapshot.videoState, 'idle');
  assert.equal(monitor.snapshot.mediaState, 'streaming');

  now = 1800;
  monitor.check();
  assert.equal(monitor.snapshot.mediaState, 'idle');

  now = 1900;
  monitor.signal('heartbeat');
  assert.equal(monitor.snapshot.videoState, 'idle');
  assert.equal(monitor.snapshot.mediaState, 'idle');
  assert.equal(monitor.snapshot.lastHeartbeatAt, 1900);

  monitor.signal('video');
  monitor.signal('audio');
  assert.equal(monitor.snapshot.mediaState, 'streaming');
  assert.ok(events.some((event) => event.component === 'video' && event.reason === 'resumed'));
  assert.ok(events.some((event) => event.component === 'media' && event.reason === 'resumed'));
  monitor.close();
});

test('MediaActivityMonitor reset prepares a clean post-FLUSH state', () => {
  const events = [];
  const monitor = new MediaActivityMonitor({
    clock: () => 10,
    videoIdleMs: 500,
    mediaIdleMs: 800,
    autoCheck: false,
  });
  monitor.on('state', (event) => events.push(event));
  monitor.signal('video');
  monitor.reset('flush');
  assert.deepEqual(monitor.snapshot, {
    videoState: 'waiting',
    mediaState: 'starting',
    lastVideoAt: null,
    lastMediaAt: null,
    lastHeartbeatAt: null,
  });
  assert.equal(events.at(-1).reason, 'flush');
  monitor.close();
  assert.equal(monitor.snapshot.videoState, 'closed');
  assert.equal(monitor.snapshot.mediaState, 'closed');
});
