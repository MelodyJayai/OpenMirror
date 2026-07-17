import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  AirPlayDiagnostics,
  analyzeInteroperabilityRecords,
} from '../src/diagnostics.js';

test('AirPlayDiagnostics produces redacted JSON-safe interoperability metrics', () => {
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  const receiver = new EventEmitter();
  const diagnostics = new AirPlayDiagnostics(receiver, {
    clock: () => now,
    intervalMs: 0,
  });
  const session = {
    remoteAddress: '192.168.10.44',
    state: { sessionKey: Buffer.alloc(16, 0xaa) },
  };

  receiver.emit('session-opened', session);
  now += 10;
  receiver.emit('paired', { session });
  receiver.emit('fp-setup', { session, phase: 1, bytes: 16 });
  receiver.emit('setup', {
    session,
    crypto: {
      sessionKeyReady: true,
      audioDecryptorReady: true,
      videoDecryptorReady: false,
    },
    payload: {
      ekey: Buffer.alloc(72, 0xbb),
      streams: [{
        type: 96,
        ct: 4,
        sr: 44100,
        spf: 480,
        controlPort: 6001,
      }],
    },
  });
  receiver.emit('setup', {
    session,
    crypto: {
      sessionKeyReady: true,
      audioDecryptorReady: false,
      videoDecryptorReady: true,
    },
    payload: {
      streams: [{ type: 110 }],
    },
  });
  receiver.emit('video-codec', {
    session,
    profile: 100,
    level: 40,
    revision: 1,
    dimensions: { width: 1920, height: 1080, orientation: 'landscape', interlaced: false },
    displayDimensions: {
      source: { width: 1080, height: 1920, orientation: 'portrait' },
      encoded: { width: 1920, height: 1080, orientation: 'landscape' },
    },
  });
  now += 20;
  receiver.emit('video-data', {
    session,
    annexB: Buffer.alloc(100),
    keyframe: true,
    timing: { delayMs: 120 },
  });
  receiver.emit('audio-data', {
    session,
    payload: Buffer.alloc(20),
    encrypted: false,
    timing: { delayMs: 125 },
  });
  receiver.emit('audio-no-data', {
    session,
    sequence: 1,
    timestamp: 0,
    bytes: 4,
  });
  receiver.emit('audio-rtp-event', {
    session,
    stats: {
      received: 2,
      emitted: 1,
      gapsSkipped: 1,
      duplicates: 0,
      late: 0,
      retransmitRequests: 1,
      retransmitRecovered: 1,
      retransmitUnrecovered: 0,
      retransmittedRecovered: 1,
      pending: 0,
    },
  });
  receiver.emit('audio-retransmit-request', {
    session,
    count: 1,
    sent: true,
  });
  receiver.emit('audio-retransmitted-packet', { session, sequence: 2 });
  receiver.emit('feedback', { session, receivedAt: now });
  receiver.emit('feedback', { session, receivedAt: now });
  receiver.emit('feedback-timeout', { session, timeoutMs: 15000, idleForMs: 15002 });
  receiver.emit('clock-sync', {
    session,
    clock: { offsetMs: 10, roundTripMs: 2 },
  });
  now += 1000;
  receiver.emit('clock-sync', {
    session,
    clock: { offsetMs: 10.1, roundTripMs: 3 },
  });
  receiver.emit('stream-error', {
    session,
    type: 'audio-rtp',
    error: new Error('bad packet from 192.168.10.44 or [fe80::abcd%12]:7000'),
  });
  receiver.emit('session-closed', session);

  const report = diagnostics.snapshot();
  const json = JSON.stringify(report);
  const item = report.sessions[0];
  assert.equal(item.peer, 'peer-1');
  assert.equal(item.videoFormat.width, 1920);
  assert.equal(item.videoFormat.orientation, 'portrait');
  assert.equal(item.videoFormat.sourceHeight, 1920);
  assert.equal(item.crypto.sessionKeyReady, true);
  assert.equal(item.crypto.audioDecryptorReady, true);
  assert.equal(item.crypto.videoDecryptorReady, true);
  assert.deepEqual(item.streamTypes, [96, 110]);
  assert.equal(item.audioFormat.compressionType, 4);
  assert.equal(item.audioFormat.retransmitAvailable, true);
  assert.equal(item.counts.videoBytes, 100);
  assert.equal(item.counts.audioBytes, 20);
  assert.equal(item.counts.audioNoDataPackets, 1);
  assert.equal(item.counts.feedbacks, 2);
  assert.equal(item.counts.feedbackTimeouts, 1);
  assert.equal(item.milestones.firstFeedback, 30);
  assert.deepEqual(item.timeline.find((event) => event.event === 'feedback-timeout'), {
    event: 'feedback-timeout',
    elapsedMs: 30,
    timeoutMs: 15000,
    idleForMs: 15002,
  });
  assert.equal(item.latencyMs.audioMinusVideo.mean, 5);
  assert.equal(item.clock.drift.driftMs, 0.09999999999999964);
  assert.equal(item.rtp.gapsSkipped, 1);
  assert.equal(item.rtp.transport.datagramsSent, 1);
  assert.equal(item.rtp.transport.packetsReceived, 1);
  assert.doesNotMatch(json, /192\.168\.10\.44/);
  assert.doesNotMatch(json, /fe80|abcd|7000/);
  assert.doesNotMatch(json, /aaaa|bbbb/);
  assert.doesNotMatch(json, /"sessionKey":|"ekey":/);
  assert.match(item.lastError.message, /\[redacted-ip\]/);
  diagnostics.close();
});

test('AirPlayDiagnostics labels repeated connections from one peer as reconnects', () => {
  const receiver = new EventEmitter();
  const diagnostics = new AirPlayDiagnostics(receiver, { intervalMs: 0 });
  receiver.emit('session-opened', { remoteAddress: '::ffff:10.0.0.8', state: {} });
  receiver.emit('session-opened', { remoteAddress: '10.0.0.8', state: {} });
  const sessions = diagnostics.snapshot().sessions;
  assert.equal(sessions[0].peer, sessions[1].peer);
  assert.equal(sessions[0].reconnectIndex, 1);
  assert.equal(sessions[1].reconnectIndex, 2);
  diagnostics.close();
});

test('analyzeInteroperabilityRecords enforces the complete true-device contract', () => {
  const base = {
    peer: 'peer-1',
    closedAt: '2026-07-16T00:02:00.000Z',
    fairPlayPhases: [1, 2],
    crypto: {
      sessionKeyReady: true,
      videoDecryptorReady: true,
      audioDecryptorReady: true,
    },
    audioFormat: { compressionType: 8 },
    videoFormat: { width: 1920, height: 1080, orientation: 'landscape' },
    counts: {
      videoAccessUnits: 100,
      videoKeyframes: 3,
      encryptedVideoFrames: 0,
      audioPackets: 300,
      encryptedAudioPackets: 0,
      formatChanges: 2,
      streamErrors: 0,
    },
    playback: {
      video: { started: 2, accepted: 100, errors: 0, reasons: {} },
      audio: { started: 1, forwarded: 300, errors: 0, reasons: {} },
    },
    mediaState: { media: { state: 'closed' } },
    latencyMs: {
      video: { count: 100 },
      audio: { count: 300 },
      audioMinusVideo: { count: 100 },
    },
    clock: {
      offsetMs: { count: 40 },
      drift: { elapsedMs: 60_000, ppm: 12 },
    },
    rtp: {
      received: 300,
      gapsSkipped: 1,
      duplicates: 2,
      late: 3,
      retransmitRequests: 1,
      retransmitRecovered: 1,
      retransmitUnrecovered: 0,
      retransmittedRecovered: 1,
      transport: {
        datagramsSent: 1,
        packetsReceived: 1,
      },
    },
    timeline: [
      { event: 'video-idle', elapsedMs: 30_000, reason: 'timeout' },
      { event: 'video-streaming', elapsedMs: 42_000, reason: 'resumed' },
    ],
  };
  const sessionOne = { ...base, id: 'session-1', reconnectIndex: 1 };
  const sessionTwo = {
    ...base,
    id: 'session-2',
    reconnectIndex: 3,
    counts: {
      ...base.counts,
      videoAccessUnits: 1,
      audioPackets: 1,
    },
  };
  const auxiliarySession = {
    id: 'session-auxiliary',
    peer: 'peer-1',
    reconnectIndex: 2,
    closedAt: '2026-07-16T00:01:00.000Z',
    counts: { videoAccessUnits: 0, audioPackets: 0, streamErrors: 0 },
  };
  const result = analyzeInteroperabilityRecords([
    {
      type: 'run-start',
      runId: 'run-1',
      schemaVersion: 1,
      capabilityProfile: {
        featureMask: '0x5A7FFEE6',
        pairing: 'legacy',
        identity: 'persistent-v1',
        video: 'H264',
        audio: 'AAC-ELD',
      },
    },
    {
      type: 'session-report',
      session: sessionOne,
    },
    {
      type: 'session-report',
      session: sessionTwo,
    },
    { type: 'final-snapshot', sessions: [sessionOne, auxiliarySession, sessionTwo] },
    {
      type: 'manual-verification',
      observations: {
        videoPlayback: true,
        audioPlayback: true,
        rotationRecovery: true,
        lockResume: true,
        reconnect: true,
      },
    },
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 11);

  const incompleteSession = {
    ...base,
    id: 'session-1',
    reconnectIndex: 1,
    counts: { ...base.counts, formatChanges: 0 },
    timeline: [],
    clock: { offsetMs: { count: 1 }, drift: null },
  };
  const incomplete = analyzeInteroperabilityRecords([
    {
      type: 'session-report',
      session: incompleteSession,
    },
    { type: 'final-snapshot', sessions: [incompleteSession] },
  ]);
  assert.equal(incomplete.passed, false);
  assert.deepEqual(
    incomplete.checks.filter((item) => !item.passed).map((item) => item.name),
    [
      'capability-profile',
      'h264-decrypt-playback',
      'aac-eld-decrypt-playback',
      'rotation-format-change',
      'lock-idle-resume',
      'disconnect-reconnect-cleanup',
      'latency-av-drift',
    ],
  );
});

test('analyzeInteroperabilityRecords ignores stale snapshots and prefers final snapshots', () => {
  const complete = {
    id: 'session-1',
    peer: 'peer-1',
    reconnectIndex: 1,
    closedAt: '2026-07-16T00:01:00.000Z',
    counts: { videoAccessUnits: 10, audioPackets: 0, streamErrors: 0 },
  };
  const stale = {
    ...complete,
    closedAt: null,
    counts: { videoAccessUnits: 0, audioPackets: 0, streamErrors: 0 },
  };
  const final = {
    ...complete,
    counts: { videoAccessUnits: 20, audioPackets: 0, streamErrors: 1 },
  };
  const result = analyzeInteroperabilityRecords([
    { type: 'session-report', session: complete },
    { type: 'snapshot', sessions: [stale] },
    { type: 'final-snapshot', sessions: [final] },
  ]);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.mediaSessionCount, 1);
  assert.match(
    result.checks.find((item) => item.name === 'pipeline-stability').detail,
    /1 stream error/,
  );
});

test('analyzeInteroperabilityRecords only evaluates the latest appended run', () => {
  const oldSession = {
    id: 'session-1',
    peer: 'peer-1',
    closedAt: '2026-07-16T00:01:00.000Z',
    counts: { videoAccessUnits: 10, audioPackets: 0, streamErrors: 0 },
  };
  const result = analyzeInteroperabilityRecords([
    { type: 'run-start', runId: 'old-run' },
    { type: 'final-snapshot', runId: 'old-run', sessions: [oldSession] },
    { type: 'run-start', runId: 'new-run' },
    { type: 'final-snapshot', runId: 'new-run', sessions: [] },
  ]);
  assert.equal(result.sessionCount, 0);
  assert.equal(result.mediaSessionCount, 0);
  assert.equal(
    result.checks.find((item) => item.name === 'report-completeness').passed,
    false,
  );
});
