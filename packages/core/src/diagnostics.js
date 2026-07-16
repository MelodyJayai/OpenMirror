import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';

class RunningStats {
  #count = 0;
  #sum = 0;
  #min = Infinity;
  #max = -Infinity;
  #recent = [];
  #limit;

  constructor(limit = 256) {
    this.#limit = limit;
  }

  add(value) {
    if (!Number.isFinite(value)) return;
    this.#count++;
    this.#sum += value;
    this.#min = Math.min(this.#min, value);
    this.#max = Math.max(this.#max, value);
    this.#recent.push(value);
    if (this.#recent.length > this.#limit) this.#recent.shift();
  }

  snapshot() {
    if (!this.#count) return { count: 0 };
    const sorted = [...this.#recent].sort((a, b) => a - b);
    const percentile = (fraction) => sorted[Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    )];
    return {
      count: this.#count,
      min: this.#min,
      max: this.#max,
      mean: this.#sum / this.#count,
      p50: percentile(0.5),
      p95: percentile(0.95),
    };
  }
}

function redactError(error) {
  const text = error?.message ?? String(error ?? 'unknown error');
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(
      /\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}(?:%[\w.-]+)?\]?(?::\d+)?/gi,
      (candidate) => {
        const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
        const address = (bracketed?.[1] ?? candidate).replace(/%[\w.-]+$/, '');
        return isIP(address) === 6 ? '[redacted-ip]' : candidate;
      },
    );
}

function normalizedPeer(address = '') {
  return String(address).replace(/^::ffff:/, '');
}

/**
 * Aggregates JSON-safe, redacted AirPlay interoperability diagnostics.
 * It never records payload bytes, pairing secrets, FairPlay material, raw
 * headers, device names, or network addresses.
 */
export class AirPlayDiagnostics extends EventEmitter {
  #receiver;
  #clock;
  #startedAt;
  #interval = null;
  #listeners = [];
  #sessions = new Map();
  #sessionIds = new WeakMap();
  #peers = new Map();
  #nextSessionId = 1;
  #nextPeerId = 1;
  #maxTimeline;

  constructor(receiver, {
    clock = Date.now,
    intervalMs = 5000,
    maxTimeline = 100,
  } = {}) {
    super();
    if (!receiver?.on || !receiver?.off) throw new Error('AirPlayDiagnostics requires an event emitter');
    if (typeof clock !== 'function') throw new Error('diagnostics clock must be a function');
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error('diagnostics intervalMs must be non-negative');
    }
    if (!Number.isInteger(maxTimeline) || maxTimeline < 1) {
      throw new Error('diagnostics maxTimeline must be positive');
    }
    this.#receiver = receiver;
    this.#clock = clock;
    this.#startedAt = clock();
    this.#maxTimeline = maxTimeline;
    this.#attach();
    if (intervalMs > 0) {
      this.#interval = setInterval(() => this.emit('snapshot', this.snapshot()), intervalMs);
      this.#interval.unref?.();
    }
  }

  snapshot() {
    const now = this.#clock();
    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      uptimeMs: now - this.#startedAt,
      sessions: [...this.#sessions.values()].map((record) => this.#report(record, now)),
    };
  }

  close() {
    clearInterval(this.#interval);
    this.#interval = null;
    for (const [event, listener] of this.#listeners) this.#receiver.off(event, listener);
    this.#listeners = [];
  }

  #attach() {
    this.#listen('session-opened', (session) => {
      const record = this.#recordFor(session);
      this.#mark(record, 'session-opened');
    });
    this.#listen('session-closed', (session) => {
      const record = this.#recordFor(session);
      const now = this.#clock();
      record.closedAt = now;
      record.stage = 'closed';
      this.#mark(record, 'session-closed', now);
      this.emit('session-report', this.#report(record, now));
    });
    this.#listen('request', ({ session, method, bodyBytes = 0 }) => {
      const record = this.#recordFor(session);
      record.counts.rtspRequests++;
      record.counts.rtspBodyBytes += Number(bodyBytes) || 0;
      record.requests[method] = (record.requests[method] ?? 0) + 1;
    });
    this.#listen('paired', ({ session }) => this.#advance(session, 'paired'));
    this.#listen('fp-setup', ({ session, phase }) => {
      const record = this.#recordFor(session);
      if (!record.fairPlayPhases.includes(phase)) record.fairPlayPhases.push(phase);
      this.#advance(session, `fairplay-${phase}`);
    });
    this.#listen('setup', ({ session, payload, crypto }) => {
      const record = this.#recordFor(session);
      const streamTypes = Array.isArray(payload?.streams)
        ? payload.streams.map((stream) => stream.type).filter(Number.isFinite)
        : [];
      record.streamTypes = [...new Set([...record.streamTypes, ...streamTypes])];
      const audio = payload?.streams?.find((stream) => stream.type === 96);
      if (audio) {
        record.audioFormat = {
          compressionType: audio.ct ?? record.audioFormat?.compressionType ?? null,
          audioFormat: audio.audioFormat ?? record.audioFormat?.audioFormat ?? null,
          sampleRate: audio.sr ?? record.audioFormat?.sampleRate ?? 44100,
          samplesPerFrame: audio.spf ?? record.audioFormat?.samplesPerFrame ?? null,
          retransmitAvailable: Number.isInteger(audio.controlPort)
            ? audio.controlPort > 0
            : record.audioFormat?.retransmitAvailable ?? false,
        };
      }
      record.crypto = {
        sessionKeyReady: Boolean(
          record.crypto?.sessionKeyReady || crypto?.sessionKeyReady,
        ),
        audioDecryptorReady: Boolean(
          record.crypto?.audioDecryptorReady || crypto?.audioDecryptorReady,
        ),
        videoDecryptorReady: Boolean(
          record.crypto?.videoDecryptorReady || crypto?.videoDecryptorReady,
        ),
      };
      this.#advance(session, 'setup');
    });
    this.#listen('record', ({ session }) => this.#advance(session, 'recording'));
    this.#listen('feedback', ({ session }) => {
      const record = this.#recordFor(session);
      record.counts.feedbacks++;
      this.#milestone(record, 'firstFeedback');
    });
    this.#listen('flush', ({ session }) => {
      const record = this.#recordFor(session);
      record.counts.flushes++;
      this.#mark(record, 'flush');
    });
    this.#listen('teardown', ({ session }) => this.#advance(session, 'teardown'));
    this.#listen('video-codec', (event) => {
      const record = this.#recordFor(event.session);
      record.counts.codecUpdates++;
      const displayed = event.displayDimensions?.source
        ?? event.displayDimensions?.encoded
        ?? event.dimensions;
      const encoded = event.dimensions
        ?? event.displayDimensions?.encoded
        ?? event.displayDimensions?.source;
      record.videoFormat = {
        profile: event.profile,
        level: event.level,
        revision: event.revision ?? record.counts.codecUpdates,
        width: encoded?.width ?? null,
        height: encoded?.height ?? null,
        orientation: displayed?.orientation ?? null,
        interlaced: event.dimensions?.interlaced ?? null,
        sourceWidth: event.displayDimensions?.source?.width ?? null,
        sourceHeight: event.displayDimensions?.source?.height ?? null,
        encodedHeaderWidth: event.displayDimensions?.encoded?.width ?? null,
        encodedHeaderHeight: event.displayDimensions?.encoded?.height ?? null,
      };
      if (event.dimensionsChanged) record.counts.formatChanges++;
      this.#milestone(record, 'firstVideoCodec');
    });
    this.#listen('video-data', ({ session, annexB, keyframe, timing }) => {
      const record = this.#recordFor(session);
      record.counts.videoAccessUnits++;
      record.counts.videoBytes += annexB?.length ?? 0;
      if (keyframe) record.counts.videoKeyframes++;
      this.#addTiming(record, 'video', timing);
      this.#milestone(record, 'firstVideo');
    });
    this.#listen('video-frame', ({ session, type, payloadLength = 0, encrypted }) => {
      if (type !== 0) return;
      const record = this.#recordFor(session);
      record.counts.videoFrames++;
      record.counts.videoFrameBytes += payloadLength;
      if (encrypted) record.counts.encryptedVideoFrames++;
    });
    this.#listen('audio-data', ({ session, payload, encrypted, timing }) => {
      const record = this.#recordFor(session);
      record.counts.audioPackets++;
      record.counts.audioBytes += payload?.length ?? 0;
      if (encrypted) record.counts.encryptedAudioPackets++;
      this.#addTiming(record, 'audio', timing);
      this.#milestone(record, 'firstAudio');
    });
    this.#listen('audio-sync', ({ session }) => this.#milestone(this.#recordFor(session), 'firstAudioSync'));
    this.#listen('audio-no-data', ({ session }) => {
      this.#recordFor(session).counts.audioNoDataPackets++;
    });
    this.#listen('audio-dropped', ({ session, bytes = 0, reason = 'unknown' }) => {
      const record = this.#recordFor(session);
      record.counts.audioDrops++;
      record.counts.audioDroppedBytes += bytes;
      record.dropReasons[reason] = (record.dropReasons[reason] ?? 0) + 1;
    });
    this.#listen('audio-rtp-event', ({ session, stats }) => {
      this.#recordFor(session).rtp = { ...stats };
    });
    this.#listen('audio-rtp-stats', ({ session, stats }) => {
      this.#recordFor(session).rtp = { ...stats };
    });
    this.#listen('audio-retransmit-request', ({
      session,
      count = 0,
      sent = false,
    }) => {
      const recovery = this.#recordFor(session).rtpRecovery;
      recovery.logicalRequests++;
      recovery.packetsRequested += count;
      if (sent) recovery.datagramsSent++;
      else recovery.unavailable++;
    });
    this.#listen('audio-retransmitted-packet', ({ session }) => {
      this.#recordFor(session).rtpRecovery.packetsReceived++;
    });
    this.#listen('clock-sync', ({ session, clock }) => {
      const record = this.#recordFor(session);
      const now = this.#clock();
      record.clock.offset.add(clock?.offsetMs);
      record.clock.roundTrip.add(clock?.roundTripMs);
      if (Number.isFinite(clock?.offsetMs)) {
        record.clock.first ??= { offsetMs: clock.offsetMs, atMs: now };
        record.clock.latest = { offsetMs: clock.offsetMs, atMs: now };
      }
      this.#milestone(record, 'firstClockSync', now);
    });
    this.#listen('media-state', ({ session, ...state }) => {
      const record = this.#recordFor(session);
      record.mediaState[state.component] = {
        state: state.state,
        reason: state.reason,
        atMs: state.atMs,
      };
      this.#mark(record, `${state.component}-${state.state}`, state.atMs, {
        reason: state.reason,
        previous: state.previous,
        idleForMs: state.idleForMs,
      });
    });
    this.#listen('playback-event', ({
      session,
      component,
      action,
      reason = null,
      count = 1,
    }) => {
      if (!['video', 'audio'].includes(component) || !action) return;
      const record = this.#recordFor(session);
      const bucket = record.playback[component];
      bucket[action] = (bucket[action] ?? 0) + count;
      if (reason) bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + count;
    });
    this.#listen('stream-error', ({ session, type = 'stream', error }) => {
      if (!session) return;
      const record = this.#recordFor(session);
      record.counts.streamErrors++;
      record.errorTypes[type] = (record.errorTypes[type] ?? 0) + 1;
      record.lastError = { type, message: redactError(error), at: new Date(this.#clock()).toISOString() };
    });
  }

  #listen(event, listener) {
    this.#receiver.on(event, listener);
    this.#listeners.push([event, listener]);
  }

  #recordFor(session) {
    let id = this.#sessionIds.get(session);
    if (id) return this.#sessions.get(id);
    const now = this.#clock();
    id = `session-${this.#nextSessionId++}`;
    this.#sessionIds.set(session, id);
    const peerKey = normalizedPeer(session?.remoteAddress);
    let peer = this.#peers.get(peerKey);
    if (!peer) {
      peer = { id: `peer-${this.#nextPeerId++}`, sessions: 0 };
      this.#peers.set(peerKey, peer);
    }
    peer.sessions++;
    const record = {
      id,
      peer: peer.id,
      reconnectIndex: peer.sessions,
      openedAt: now,
      closedAt: null,
      stage: 'connected',
      fairPlayPhases: [],
      streamTypes: [],
      audioFormat: null,
      videoFormat: null,
      crypto: null,
      requests: {},
      counts: {
        rtspRequests: 0,
        rtspBodyBytes: 0,
        codecUpdates: 0,
        formatChanges: 0,
        videoFrames: 0,
        encryptedVideoFrames: 0,
        videoFrameBytes: 0,
        videoAccessUnits: 0,
        videoKeyframes: 0,
        videoBytes: 0,
        audioPackets: 0,
        audioBytes: 0,
        encryptedAudioPackets: 0,
        audioNoDataPackets: 0,
        audioDrops: 0,
        audioDroppedBytes: 0,
        streamErrors: 0,
        feedbacks: 0,
        flushes: 0,
      },
      dropReasons: {},
      errorTypes: {},
      lastError: null,
      milestones: {},
      timeline: [],
      mediaState: {},
      playback: {
        video: { reasons: {} },
        audio: { reasons: {} },
      },
      rtp: null,
      rtpRecovery: {
        logicalRequests: 0,
        packetsRequested: 0,
        datagramsSent: 0,
        unavailable: 0,
        packetsReceived: 0,
      },
      latency: {
        video: new RunningStats(),
        audio: new RunningStats(),
        avSkew: new RunningStats(),
      },
      latestTiming: {},
      clock: {
        offset: new RunningStats(),
        roundTrip: new RunningStats(),
        first: null,
        latest: null,
      },
    };
    this.#sessions.set(id, record);
    return record;
  }

  #advance(session, stage) {
    const record = this.#recordFor(session);
    record.stage = stage;
    this.#mark(record, stage);
    this.#milestone(record, stage);
  }

  #mark(record, event, now = this.#clock(), details = {}) {
    record.timeline.push({
      event,
      elapsedMs: Math.max(0, now - record.openedAt),
      ...Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== null && value !== undefined),
      ),
    });
    if (record.timeline.length > this.#maxTimeline) record.timeline.shift();
  }

  #milestone(record, name, now = this.#clock()) {
    record.milestones[name] ??= Math.max(0, now - record.openedAt);
  }

  #addTiming(record, component, timing) {
    if (!Number.isFinite(timing?.delayMs)) return;
    const now = this.#clock();
    record.latency[component].add(timing.delayMs);
    record.latestTiming[component] = { delayMs: timing.delayMs, atMs: now };
    const other = component === 'audio' ? 'video' : 'audio';
    const otherTiming = record.latestTiming[other];
    if (otherTiming && Math.abs(now - otherTiming.atMs) <= 1000) {
      const audioDelay = component === 'audio' ? timing.delayMs : otherTiming.delayMs;
      const videoDelay = component === 'video' ? timing.delayMs : otherTiming.delayMs;
      record.latency.avSkew.add(audioDelay - videoDelay);
    }
  }

  #report(record, now) {
    let drift = null;
    if (record.clock.first && record.clock.latest) {
      const elapsedMs = record.clock.latest.atMs - record.clock.first.atMs;
      const driftMs = record.clock.latest.offsetMs - record.clock.first.offsetMs;
      drift = {
        elapsedMs,
        driftMs,
        ppm: elapsedMs > 0 ? driftMs / elapsedMs * 1_000_000 : null,
      };
    }
    return {
      id: record.id,
      peer: record.peer,
      reconnectIndex: record.reconnectIndex,
      stage: record.stage,
      openedAt: new Date(record.openedAt).toISOString(),
      closedAt: record.closedAt === null ? null : new Date(record.closedAt).toISOString(),
      durationMs: (record.closedAt ?? now) - record.openedAt,
      fairPlayPhases: [...record.fairPlayPhases],
      streamTypes: [...record.streamTypes],
      audioFormat: record.audioFormat ? { ...record.audioFormat } : null,
      videoFormat: record.videoFormat ? { ...record.videoFormat } : null,
      crypto: record.crypto ? { ...record.crypto } : null,
      requests: { ...record.requests },
      counts: { ...record.counts },
      dropReasons: { ...record.dropReasons },
      errorTypes: { ...record.errorTypes },
      lastError: record.lastError ? { ...record.lastError } : null,
      milestones: { ...record.milestones },
      timeline: record.timeline.map((event) => ({ ...event })),
      mediaState: Object.fromEntries(
        Object.entries(record.mediaState).map(([key, value]) => [key, { ...value }]),
      ),
      playback: Object.fromEntries(
        Object.entries(record.playback).map(([component, value]) => [
          component,
          { ...value, reasons: { ...value.reasons } },
        ]),
      ),
      rtp: record.rtp ? {
        ...record.rtp,
        transport: { ...record.rtpRecovery },
      } : null,
      latencyMs: {
        video: record.latency.video.snapshot(),
        audio: record.latency.audio.snapshot(),
        audioMinusVideo: record.latency.avSkew.snapshot(),
      },
      clock: {
        offsetMs: record.clock.offset.snapshot(),
        roundTripMs: record.clock.roundTrip.snapshot(),
        drift,
      },
    };
  }
}

function collectSessions(records) {
  const sessions = new Map();
  const priorities = new Map();
  const add = (session, priority) => {
    if (!session?.id) return;
    const previousPriority = priorities.get(session.id) ?? -1;
    if (priority < previousPriority) return;
    sessions.set(session.id, session);
    priorities.set(session.id, priority);
  };
  for (const record of records ?? []) {
    if (record?.type === 'session-report' && record.session?.id) {
      add(record.session, 2);
    }
    const snapshotPriority = record?.type === 'final-snapshot'
      ? 3
      : record?.type === 'snapshot' ? 1 : 0;
    for (const session of record?.sessions ?? []) {
      add(session, snapshotPriority);
    }
  }
  return [...sessions.values()];
}

function latestRunRecords(records) {
  const all = records ?? [];
  for (let index = all.length - 1; index >= 0; index--) {
    if (all[index]?.type === 'run-start') return all.slice(index);
  }
  return all;
}

function check(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

/**
 * Evaluate JSONL diagnostic records against the full true-device regression
 * contract. The result is intentionally strict: synthetic/headless media is
 * useful evidence but cannot satisfy decoder playback, rotation, lock/resume,
 * reconnect, and sustained clock-statistics requirements.
 */
export function analyzeInteroperabilityRecords(records) {
  const runRecords = latestRunRecords(records);
  const runStart = runRecords.find((record) => record?.type === 'run-start');
  const capabilityProfile = runStart?.capabilityProfile;
  const expectedCapabilityProfile = {
    featureMask: '0x5A7FFEE6',
    pairing: 'legacy',
    identity: 'persistent-v1',
    video: 'H264',
    audio: 'AAC-ELD',
  };
  const capabilityProfileReady = Boolean(
    runStart?.schemaVersion === 1
    && Object.entries(expectedCapabilityProfile).every(
      ([key, value]) => capabilityProfile?.[key] === value,
    ),
  );
  const sessions = collectSessions(runRecords);
  const manualVerification = [...runRecords].reverse().find(
    (record) => record?.type === 'manual-verification',
  )?.observations;
  const finalSnapshot = [...runRecords].reverse().find(
    (record) => record?.type === 'final-snapshot',
  );
  const finalSessions = finalSnapshot?.sessions ?? [];
  const completeFinalSnapshot = Boolean(
    finalSnapshot
    && finalSessions.length > 0
    && finalSessions.every((session) => session?.closedAt),
  );
  const mediaSessions = sessions.filter((session) => (
    session.counts?.videoAccessUnits > 0 || session.counts?.audioPackets > 0
  ));
  const fairPlaySession = mediaSessions.find((session) => (
    session.fairPlayPhases?.includes(1)
    && session.fairPlayPhases?.includes(2)
    && session.crypto?.sessionKeyReady
  ));
  const h264Session = mediaSessions.find((session) => (
    session.crypto?.videoDecryptorReady
    && session.counts?.videoAccessUnits > 0
    && session.counts?.videoKeyframes > 0
    && session.counts?.encryptedVideoFrames === 0
    && session.playback?.video?.accepted > 0
    && session.playback?.video?.started > 0
  ));
  const aacSession = mediaSessions.find((session) => (
    session.audioFormat?.compressionType === 8
    && session.crypto?.audioDecryptorReady
    && session.counts?.audioPackets > 0
    && session.counts?.encryptedAudioPackets === 0
    && session.playback?.audio?.forwarded > 0
    && session.playback?.audio?.started > 0
  ));
  const rotationSession = mediaSessions.find((session) => (
    session.counts?.formatChanges > 0
    && session.videoFormat?.width > 0
    && session.videoFormat?.height > 0
    && session.videoFormat?.orientation
  ));
  const lockResumeSession = mediaSessions.find((session) => {
    const timeline = session.timeline ?? [];
    const idleIndex = timeline.findIndex((event) => event.event === 'video-idle');
    return idleIndex >= 0 && timeline.slice(idleIndex + 1).some((event) => (
      event.event === 'video-streaming' && event.reason === 'resumed'
    ));
  });
  const peers = new Map();
  for (const session of mediaSessions) {
    if (!session.peer) continue;
    const bucket = peers.get(session.peer) ?? [];
    bucket.push(session);
    peers.set(session.peer, bucket);
  }
  const reconnect = [...peers.values()].find((peerSessions) => (
    peerSessions.filter((session) => session.closedAt).length >= 2
    && Math.max(...peerSessions.map((session) => session.reconnectIndex ?? 0)) >= 2
    && peerSessions.every((session) => (
      !session.closedAt || session.mediaState?.media?.state === 'closed'
    ))
  ));
  const timingSession = mediaSessions.find((session) => (
    session.latencyMs?.video?.count > 0
    && session.latencyMs?.audio?.count > 0
    && session.latencyMs?.audioMinusVideo?.count > 0
    && session.clock?.offsetMs?.count >= 2
    && Number.isFinite(session.clock?.drift?.ppm)
    && session.clock.drift.elapsedMs >= 30_000
  ));
  const rtpSession = mediaSessions.find((session) => (
    session.rtp?.received > 0
    && Number.isFinite(session.rtp?.gapsSkipped)
    && Number.isFinite(session.rtp?.duplicates)
    && Number.isFinite(session.rtp?.late)
    && Number.isFinite(session.rtp?.retransmitRequests)
    && Number.isFinite(session.rtp?.retransmitRecovered)
    && Number.isFinite(session.rtp?.retransmitUnrecovered)
    && Number.isFinite(session.rtp?.retransmittedRecovered)
    && Number.isFinite(session.rtp?.transport?.datagramsSent)
    && Number.isFinite(session.rtp?.transport?.packetsReceived)
  ));
  const totalStreamErrors = sessions.reduce(
    (total, session) => total + (session.counts?.streamErrors ?? 0),
    0,
  );
  const totalPlaybackErrors = sessions.reduce(
    (total, session) => total
      + (session.playback?.video?.errors ?? 0)
      + (session.playback?.audio?.errors ?? 0),
    0,
  );

  const checks = [
    check(
      'capability-profile',
      capabilityProfileReady,
      capabilityProfileReady
        ? `${capabilityProfile.featureMask}, ${capabilityProfile.identity},`
          + ` ${capabilityProfile.video}/${capabilityProfile.audio}`
        : 'Latest run does not prove the required legacy feature mask, persistent identity,'
          + ' H.264 and AAC-ELD profile',
    ),
    check(
      'report-completeness',
      completeFinalSnapshot,
      completeFinalSnapshot
        ? `final snapshot contains ${finalSessions.length} closed session(s)`
        : 'Missing a final snapshot containing only closed sessions',
    ),
    check(
      'real-playfair',
      fairPlaySession,
      fairPlaySession
        ? `${fairPlaySession.id}: phases 1/2 and media key ready`
        : 'No media session completed both fp-setup phases with a ready session key',
    ),
    check(
      'h264-decrypt-playback',
      h264Session && manualVerification?.videoPlayback === true,
      h264Session
        ? manualVerification?.videoPlayback === true
          ? `${h264Session.id}: ${h264Session.counts.videoAccessUnits} access units; picture confirmed`
          : 'H.264 reached a started player, but visible picture was not manually confirmed'
        : 'No session proved decrypted H.264 keyframes were accepted by a started player',
    ),
    check(
      'aac-eld-decrypt-playback',
      aacSession && manualVerification?.audioPlayback === true,
      aacSession
        ? manualVerification?.audioPlayback === true
          ? `${aacSession.id}: ${aacSession.counts.audioPackets} AAC-ELD packets; audio confirmed`
          : 'AAC-ELD reached a started player, but audible output was not manually confirmed'
        : 'No session proved decrypted AAC-ELD packets were forwarded to a started player',
    ),
    check(
      'rotation-format-change',
      rotationSession && manualVerification?.rotationRecovery === true,
      rotationSession
        ? manualVerification?.rotationRecovery === true
          ? `${rotationSession.id}: ${rotationSession.counts.formatChanges} change(s); recovery confirmed`
          : 'H.264 format changes were observed, but playback recovery after rotation was not confirmed'
        : 'No H.264 SPS dimension/orientation change was observed',
    ),
    check(
      'lock-idle-resume',
      lockResumeSession && manualVerification?.lockResume === true,
      lockResumeSession
        ? manualVerification?.lockResume === true
          ? `${lockResumeSession.id}: video idle followed by resumed streaming; recovery confirmed`
          : 'Idle/resume was observed, but playback recovery after unlock was not confirmed'
        : 'No video idle → resumed transition was observed',
    ),
    check(
      'disconnect-reconnect-cleanup',
      reconnect && manualVerification?.reconnect === true,
      reconnect
        ? manualVerification?.reconnect === true
          ? `${reconnect.length} closed sessions for ${reconnect[0].peer}; recovery confirmed`
          : 'Clean reconnect sessions were observed, but playback after reconnect was not confirmed'
        : 'No peer completed two cleaned-up sessions',
    ),
    check(
      'latency-av-drift',
      timingSession,
      timingSession
        ? `${timingSession.id}: drift ${timingSession.clock.drift.ppm.toFixed(1)} ppm`
        : 'Missing sustained video/audio latency, A/V skew, or ≥30 s drift statistics',
    ),
    check(
      'rtp-loss-statistics',
      rtpSession,
      rtpSession
        ? `${rtpSession.id}: ${rtpSession.rtp.received} packets,`
          + ` ${rtpSession.rtp.gapsSkipped} gaps,`
          + ` ${rtpSession.rtp.retransmittedRecovered} retransmit recovery`
        : 'Missing RTP loss/reorder/retransmit statistics',
    ),
    check(
      'pipeline-stability',
      mediaSessions.length > 0 && totalStreamErrors === 0 && totalPlaybackErrors === 0,
      `${mediaSessions.length}/${sessions.length} media/total session(s),`
        + ` ${totalStreamErrors} stream error(s),`
        + ` ${totalPlaybackErrors} playback error(s)`,
    ),
  ];
  return {
    passed: checks.every((item) => item.passed),
    sessionCount: sessions.length,
    mediaSessionCount: mediaSessions.length,
    checks,
  };
}
