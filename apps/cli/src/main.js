#!/usr/bin/env node
// OpenMirror interoperability receiver and diagnostic harness.

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDiagnosticsWriter } from './diagnostics-writer.js';
import {
  defaultReceiverIdentityPath,
  loadOrCreateReceiverIdentity,
} from './identity.js';
import {
  AirPlayDiagnostics,
  AirPlayReceiver,
  formatFeatures,
  isMirrorVideoSuspended,
  isUsableLanIPv4,
  localIPv4Addresses,
} from '@openmirror/core';
import { FfplayAudioSink, FfplayVideoSink, probeFfplay } from '@openmirror/media';

const { values } = parseArgs({
  options: {
    name: { type: 'string', short: 'n' },
    port: { type: 'string', short: 'p', default: '7000' },
    verbose: { type: 'boolean', short: 'v', default: false },
    headless: { type: 'boolean', default: false },
    ffplay: { type: 'string', default: 'ffplay' },
    fullscreen: { type: 'boolean', default: false },
    mute: { type: 'boolean', default: false },
    'advertise-address': { type: 'string' },
    identity: { type: 'string' },
    diagnostics: { type: 'string' },
    'stats-interval': { type: 'string', default: '5' },
    'video-idle-ms': { type: 'string', default: '5000' },
    'media-idle-ms': { type: 'string', default: '7000' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`OpenMirror — open-source wireless screen mirroring receiver

Usage: openmirror [options]

  -n, --name <name>          Receiver name shown on the sender (default: OpenMirror)
  -p, --port <port>          RTSP control port (default: 7000, 0 = random)
  -v, --verbose              Log media/control details
      --headless             Receive media without opening ffplay
      --ffplay <path>        ffplay executable name/path (default: ffplay)
      --fullscreen           Open the video player fullscreen
      --mute                 Disable AAC-ELD audio output
      --advertise-address    Force the LAN IPv4 address published over mDNS
      --identity <path>      Persistent receiver identity file
      --diagnostics <path>   Append redacted interoperability records as JSONL
      --stats-interval <s>   Diagnostic snapshot interval (default: 5, 0 = off)
      --video-idle-ms <ms>   Recycle a silent video player (default: 5000)
      --media-idle-ms <ms>   Recycle all silent players (default: 7000)
  -h, --help                 Show this help
`);
  process.exit(0);
}

function integerOption(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

let options;
try {
  options = {
    port: integerOption('port', values.port, { min: 0, max: 65535 }),
    statsIntervalMs: integerOption('stats-interval', values['stats-interval'], {
      min: 0,
      max: 86400,
    }) * 1000,
    videoIdleMs: integerOption('video-idle-ms', values['video-idle-ms'], {
      min: 100,
      max: 3600000,
    }),
    mediaIdleMs: integerOption('media-idle-ms', values['media-idle-ms'], {
      min: 100,
      max: 3600000,
    }),
  };
  if (options.mediaIdleMs < options.videoIdleMs) {
    throw new Error('--media-idle-ms must be greater than or equal to --video-idle-ms');
  }
  if (values['advertise-address'] && !isUsableLanIPv4(values['advertise-address'])) {
    throw new Error('--advertise-address must be a usable LAN IPv4 address');
  }
} catch (error) {
  console.error(`openmirror: ${error.message}`);
  process.exit(2);
}

const configuredIdentity = values.identity ?? process.env.OPENMIRROR_IDENTITY;
const identityPath = configuredIdentity
  ? resolve(configuredIdentity)
  : defaultReceiverIdentityPath();
let receiverIdentity;
try {
  receiverIdentity = await loadOrCreateReceiverIdentity(identityPath);
} catch (error) {
  console.error(`openmirror: ${error.message}`);
  process.exit(2);
}

const receiver = new AirPlayReceiver({
  name: values.name ?? process.env.OPENMIRROR_NAME ?? 'OpenMirror',
  port: options.port,
  deviceId: receiverIdentity.deviceId,
  privateKeySeed: receiverIdentity.privateKeySeed,
  videoIdleMs: options.videoIdleMs,
  mediaIdleMs: options.mediaIdleMs,
  addresses: values['advertise-address'] ? [values['advertise-address']] : undefined,
});

let diagnosticsPath = null;
let diagnosticsWriter = null;
const diagnosticsRunId = randomUUID();
const configuredDiagnostics = values.diagnostics ?? process.env.OPENMIRROR_DIAGNOSTICS;
const stopRequestPath = process.env.OPENMIRROR_STOP_FILE
  ? resolve(process.env.OPENMIRROR_STOP_FILE)
  : null;
if (configuredDiagnostics) {
  diagnosticsPath = resolve(configuredDiagnostics);
  try {
    diagnosticsWriter = await openDiagnosticsWriter(diagnosticsPath, {
      runId: diagnosticsRunId,
      runStart: {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        capabilityProfile: {
          featureMask: formatFeatures(receiver.options.features),
          pairing: 'legacy',
          identity: 'persistent-v1',
          video: 'H264',
          audio: 'AAC-ELD',
        },
      },
      onError: (error) => console.error(`[diagnostics] ${error.message}`),
    });
  } catch (error) {
    console.error(`[diagnostics] Cannot initialize ${diagnosticsPath}: ${error.message}`);
    process.exit(2);
  }
}

function writeDiagnostic(type, payload) {
  diagnosticsWriter?.write(type, payload);
}

const diagnostics = new AirPlayDiagnostics(receiver, {
  intervalMs: options.statsIntervalMs,
});

function statValue(stats, key = 'mean') {
  return Number.isFinite(stats?.[key]) ? stats[key].toFixed(1) : '-';
}

diagnostics.on('snapshot', (snapshot) => {
  writeDiagnostic('snapshot', snapshot);
  for (const session of snapshot.sessions.filter((item) => item.closedAt === null)) {
    const rtp = session.rtp;
    const loss = rtp ? `${rtp.gapsSkipped}/${rtp.received}` : '-';
    const recovery = rtp
      ? `${rtp.retransmitRecovered}/${rtp.retransmitPacketsRequested}`
        + ` (${rtp.retransmittedRecovered} resent)`
      : '-';
    console.log(
      `[stats] ${session.id} stage=${session.stage}`
      + ` video=${session.counts.videoAccessUnits}`
      + ` audio=${session.counts.audioPackets}`
      + ` rtp-gap=${loss}`
      + ` rtp-recovery=${recovery}`
      + ` v/a=${statValue(session.latencyMs.video)}/${statValue(session.latencyMs.audio)}ms`
      + ` av=${statValue(session.latencyMs.audioMinusVideo)}ms`
      + ` drift=${statValue(session.clock.drift, 'ppm')}ppm`,
    );
  }
});
diagnostics.on('session-report', (report) => {
  writeDiagnostic('session-report', { session: report });
  const cryptoReady = report.crypto?.sessionKeyReady
    && (report.crypto.videoDecryptorReady || report.crypto.audioDecryptorReady);
  const h264Ready = report.counts.videoAccessUnits > 0
    && report.counts.encryptedVideoFrames === 0;
  const aacReady = report.counts.audioPackets > 0
    && report.counts.encryptedAudioPackets === 0;
  console.log(
    `[report] ${report.id}`
    + ` PlayFair=${cryptoReady ? 'ok' : 'not-confirmed'}`
    + ` H.264=${h264Ready ? 'ok' : 'not-confirmed'}`
    + ` AAC-ELD=${aacReady ? 'ok' : 'not-confirmed'}`
    + ` errors=${report.counts.streamErrors}`,
  );
});

const displayEnabled = !values.headless && await probeFfplay({ executable: values.ffplay });
if (!values.headless && !displayEnabled) {
  console.warn(
    `[player] Cannot launch "${values.ffplay}"; continuing headless.`
    + ' Install FFmpeg/ffplay or pass --ffplay <path>.',
  );
}

const videoSinks = new Map();
const audioSinks = new Map();
const latestCodecs = new Map();
const intentionallyStoppedVideoSinks = new WeakSet();
const intentionallyStoppedAudioSinks = new WeakSet();
const unsupportedAudioLogged = new WeakSet();
const localAddressSet = new Set(localIPv4Addresses().map((address) => address.address));
const receiverName = receiver.options.name;
let externalDiscoverySeen = false;
let sessionSeen = false;

function playbackEvent(session, component, action, details = {}) {
  receiver.emit('playback-event', { session, component, action, ...details });
}

function videoSinkFor(session) {
  if (!displayEnabled) return null;
  let sink = videoSinks.get(session);
  if (sink) return sink;
  sink = new FfplayVideoSink({
    executable: values.ffplay,
    title: `${receiverName} — ${session.remoteAddress}`,
    fullscreen: values.fullscreen,
  });
  sink.on('started', ({ pid }) => {
    console.log(`[player] opened ffplay (pid ${pid}) for ${session.remoteAddress}`);
    playbackEvent(session, 'video', 'started');
  });
  sink.on('process-error', (error) => {
    console.error(`[player] ${error.message}`);
    if (!intentionallyStoppedVideoSinks.has(sink)) {
      playbackEvent(session, 'video', 'errors', { reason: 'process-error' });
    }
  });
  sink.on('exit', ({ code, signal }) => {
    if (intentionallyStoppedVideoSinks.has(sink)) return;
    console.error(
      `[player] ffplay exited unexpectedly (code=${code ?? '-'}, signal=${signal ?? '-'})`,
    );
    playbackEvent(session, 'video', 'errors', { reason: 'unexpected-exit' });
  });
  sink.on('diagnostic', (message) => {
    if (values.verbose) console.error(`[ffplay] ${message}`);
  });
  sink.on('dropped', ({ chunks, bytes, reason }) => {
    if (values.verbose) {
      console.warn(`[player] dropped ${chunks} chunk(s), ${bytes} bytes (${reason})`);
    }
    playbackEvent(session, 'video', 'drops', { reason, count: chunks });
  });
  videoSinks.set(session, sink);
  const codec = latestCodecs.get(session);
  if (codec) sink.writeCodec(codec);
  return sink;
}

function audioSinkFor(session, packet) {
  if (!displayEnabled || values.mute) return null;
  let sink = audioSinks.get(session);
  if (sink) return sink;
  sink = new FfplayAudioSink({
    executable: values.ffplay,
    sampleRate: packet.sampleRate,
    samplesPerFrame: packet.samplesPerFrame,
  });
  sink.on('started', ({ pid }) => {
    console.log(`[audio] opened ffplay decoder (pid ${pid}) for ${session.remoteAddress}`);
    playbackEvent(session, 'audio', 'started');
  });
  sink.on('process-error', (error) => {
    console.error(`[audio] ${error.message}`);
    if (!intentionallyStoppedAudioSinks.has(sink)) {
      playbackEvent(session, 'audio', 'errors', { reason: 'process-error' });
    }
  });
  sink.on('exit', ({ code, signal }) => {
    if (intentionallyStoppedAudioSinks.has(sink)) return;
    console.error(
      `[audio] ffplay exited unexpectedly (code=${code ?? '-'}, signal=${signal ?? '-'})`,
    );
    playbackEvent(session, 'audio', 'errors', { reason: 'unexpected-exit' });
  });
  sink.on('diagnostic', (message) => {
    if (values.verbose) console.error(`[ffplay:audio] ${message}`);
  });
  sink.on('dropped', ({ packets, bytes, reason }) => {
    if (values.verbose) {
      console.warn(`[audio] dropped ${packets} packet(s), ${bytes} bytes (${reason})`);
    }
    playbackEvent(session, 'audio', 'drops', { reason, count: packets });
  });
  sink.on('packet', () => playbackEvent(session, 'audio', 'forwarded'));
  audioSinks.set(session, sink);
  return sink;
}

async function stopVideoSink(session, reason) {
  const sink = videoSinks.get(session);
  videoSinks.delete(session);
  if (!sink) return;
  intentionallyStoppedVideoSinks.add(sink);
  if (values.verbose) console.log(`[player] recycling video sink (${reason})`);
  await sink.stop().catch((error) => {
    console.error(`[player] ${error.message}`);
    playbackEvent(session, 'video', 'errors', { reason: 'stop-error' });
  });
}

async function stopAudioSink(session, reason) {
  const sink = audioSinks.get(session);
  audioSinks.delete(session);
  if (!sink) return;
  intentionallyStoppedAudioSinks.add(sink);
  if (values.verbose) console.log(`[audio] recycling audio sink (${reason})`);
  await sink.stop().catch((error) => {
    console.error(`[audio] ${error.message}`);
    playbackEvent(session, 'audio', 'errors', { reason: 'stop-error' });
  });
}

function stopSessionSinks(session, reason, { forgetCodec = false } = {}) {
  void stopVideoSink(session, reason);
  void stopAudioSink(session, reason);
  if (forgetCodec) latestCodecs.delete(session);
}

receiver.on('session-opened', (session) => {
  sessionSeen = true;
  if (values.verbose) console.log(`[session] ${session.remoteAddress} connected`);
});
receiver.on('discovery-query', ({ questions, from, unicast }) => {
  if (!localAddressSet.has(from.address)) externalDiscoverySeen = true;
  if (values.verbose) {
    const names = [...new Set(questions.map((question) => question.name))].join(',');
    console.log(
      `[mdns] query from ${from.address}:${from.port}`
      + ` names=${names}${unicast ? ' (unicast)' : ''}`,
    );
  }
});
receiver.on('session-closed', (session) => {
  console.log(`[session] ${session.remoteAddress} disconnected`);
  stopSessionSinks(session, 'session-closed', { forgetCodec: true });
});
receiver.on('request', ({ method, uri, bodyBytes, session }) => {
  if (values.verbose) {
    console.log(`[rtsp] ${session.remoteAddress} ${method} ${uri} body=${bodyBytes}`);
  }
});
receiver.on('feedback-timeout', ({ session, idleForMs }) => {
  console.warn(
    `[session] ${session.remoteAddress} feedback heartbeat timed out after ${idleForMs}ms`,
  );
});
receiver.on('paired', ({ session }) => {
  console.log(`[pair] ${session.remoteAddress} completed pair-verify`);
});
receiver.on('fp-setup', ({ session, phase }) => {
  console.log(`[fairplay] ${session.remoteAddress} fp-setup phase ${phase}`);
});
receiver.on('announce', ({
  session, codec, compressionType, sampleRate, channels, samplesPerFrame, encryption,
}) => {
  console.log(
    `[announce] ${session.remoteAddress} RAOP ${codec ?? 'unknown'} ct=${compressionType ?? '-'}`
    + ` sr=${sampleRate} ch=${channels} spf=${samplesPerFrame ?? '-'} encryption=${encryption}`,
  );
});
receiver.on('volume', ({ session, volumeDb, muted }) => {
  console.log(`[volume] ${session.remoteAddress} ${muted ? 'muted' : `${volumeDb} dB`}`);
});
receiver.on('progress', ({ session, progress }) => {
  if (values.verbose) console.log(`[progress] ${session.remoteAddress} ${progress}`);
});
receiver.on('metadata', ({ session, bytes }) => {
  if (values.verbose) console.log(`[metadata] ${session.remoteAddress} DMAP ${bytes} bytes`);
});
receiver.on('artwork', ({ session, contentType, bytes }) => {
  if (values.verbose) console.log(`[artwork] ${session.remoteAddress} ${contentType} ${bytes} bytes`);
});
receiver.on('setup', ({ session, ports, payload, crypto }) => {
  console.log(
    `[setup] ${session.remoteAddress} media ports:`
    + ` video TCP ${ports.videoPort}, event TCP ${ports.eventPort},`
    + ` timing UDP ${ports.timingPort}, audio UDP ${ports.audioPort}/${ports.audioControlPort}`,
  );
  console.log(
    `[crypto] key=${crypto.sessionKeyReady ? 'ready' : 'missing'}`
    + ` video=${crypto.videoDecryptorReady ? 'ready' : 'missing'}`
    + ` audio=${crypto.audioDecryptorReady ? 'ready' : 'missing'}`,
  );
  const audio = payload?.streams?.find((stream) => stream.type === 96);
  if (audio && values.verbose) {
    console.log(
      `[setup] audio ct=${audio.ct ?? 'unknown'}`
      + ` sr=${audio.sr ?? 44100} spf=${audio.spf ?? 'unknown'}`
      + ` retransmit=${audio.controlPort > 0 ? 'ready' : 'unavailable'}`,
    );
  }
});
receiver.on('video-codec', ({
  session,
  profile,
  level,
  sps,
  pps,
  annexB,
  dimensions,
  displayDimensions,
  dimensionsChanged,
  payloadOption,
  revision,
}) => {
  const existingSink = videoSinks.get(session);
  latestCodecs.set(session, { annexB });
  const encodedDimensions = dimensions ?? displayDimensions?.encoded;
  const format = encodedDimensions
    ? ` ${encodedDimensions.width}x${encodedDimensions.height} ${encodedDimensions.orientation}`
    : '';
  const sourceFormat = displayDimensions?.source
    ? ` source=${displayDimensions.source.width}x${displayDimensions.source.height}`
    : '';
  console.log(
    `[codec] ${session.remoteAddress} H.264 profile=${profile} level=${level}`
    + ` sps=${sps.length} pps=${pps.length} revision=${revision}${format}${sourceFormat}`,
  );
  if (isMirrorVideoSuspended(payloadOption)) {
    void stopVideoSink(session, 'sender-suspended');
    return;
  }
  if (dimensionsChanged) {
    void stopVideoSink(session, 'format-change');
    videoSinkFor(session);
  } else if (existingSink) {
    existingSink.writeCodec({ annexB });
  } else {
    videoSinkFor(session);
  }
});
receiver.on('video-data', ({ session, annexB, keyframe, timestamp, timing }) => {
  if (values.verbose) {
    const delay = timing ? ` delay=${timing.delayMs.toFixed(1)}ms` : ' unsynchronized';
    console.log(
      `[h264] ${session.remoteAddress} ${annexB.length} bytes`
      + `${keyframe ? ' (keyframe)' : ''} ts=${timestamp}${delay}`,
    );
  }
  if (videoSinkFor(session)?.writeVideo({ annexB, keyframe, timing })) {
    playbackEvent(session, 'video', 'accepted');
  }
});
receiver.on('video-frame', ({ session, type, payloadLength, timestamp, encrypted }) => {
  if (values.verbose) {
    console.log(
      `[video] ${session.remoteAddress} type=${type} bytes=${payloadLength}`
      + ` timestamp=${timestamp}${encrypted ? ' (encrypted)' : ''}`,
    );
  }
});
receiver.on('audio-data', (packet) => {
  const { session, sequence, payload, encrypted, timing } = packet;
  if (values.verbose) {
    const delay = timing ? ` delay=${timing.delayMs.toFixed(1)}ms` : ' unsynchronized';
    console.log(
      `[audio] ${session.remoteAddress} seq=${sequence} bytes=${payload.length}`
      + `${encrypted ? ' (encrypted)' : ''}${delay}`,
    );
  }
  // The ffplay audio sink only decodes AAC-ELD (ct=8); RAOP ALAC/PCM playback
  // is a later milestone, so those packets are received and counted only.
  if (packet.compressionType !== 8) {
    if (!unsupportedAudioLogged.has(session)) {
      unsupportedAudioLogged.add(session);
      console.log(
        `[audio] ${session.remoteAddress} ct=${packet.compressionType ?? 'unknown'}`
        + ' playback not supported yet; receiving without a local player',
      );
    }
    return;
  }
  audioSinkFor(session, packet)?.writeAudio(packet);
});
receiver.on('audio-sync', ({ session, rtpTimestamp, nextRtpTimestamp, timing }) => {
  if (values.verbose) {
    console.log(
      `[audio-sync] ${session.remoteAddress} rtp=${rtpTimestamp}`
      + ` next=${nextRtpTimestamp} source=${timing?.source ?? 'pending'}`,
    );
  }
});
receiver.on('audio-no-data', ({ session, sequence, timestamp }) => {
  if (values.verbose) {
    console.log(
      `[audio] ${session.remoteAddress} seq=${sequence} timestamp=${timestamp} (no data)`,
    );
  }
});
receiver.on('audio-dropped', ({ session, sequence, bytes, reason }) => {
  if (values.verbose) {
    console.warn(
      `[audio] ${session.remoteAddress} dropped seq=${sequence} bytes=${bytes} (${reason})`,
    );
  }
});
receiver.on('audio-rtp-event', ({ session, type, skipped, sequence }) => {
  if (values.verbose && type !== 'reset') {
    console.warn(
      `[rtp] ${session.remoteAddress} ${type}`
      + `${skipped ? ` skipped=${skipped}` : ''}`
      + `${sequence !== undefined ? ` seq=${sequence}` : ''}`,
    );
  }
});
receiver.on('audio-retransmit-request', ({
  session,
  sequence,
  count,
  attempt,
  sent,
}) => {
  if (values.verbose) {
    console.warn(
      `[rtp] ${session.remoteAddress} retransmit seq=${sequence}`
      + ` count=${count} attempt=${attempt}${sent ? '' : ' (sender controlPort unavailable)'}`,
    );
  }
});
receiver.on('audio-retransmitted-packet', ({ session, sequence }) => {
  if (values.verbose) {
    console.log(`[rtp] ${session.remoteAddress} recovered seq=${sequence}`);
  }
});
receiver.on('clock-sync', ({ session, clock }) => {
  if (values.verbose) {
    console.log(
      `[clock] ${session.remoteAddress} offset=${clock.offsetMs.toFixed(3)}ms`
      + ` rtt=${clock.roundTripMs.toFixed(3)}ms`,
    );
  }
});
receiver.on('media-state', ({ session, component, state, reason, idleForMs }) => {
  if (values.verbose || state === 'idle' || reason === 'resumed') {
    const idle = Number.isFinite(idleForMs) ? ` idle=${idleForMs.toFixed(0)}ms` : '';
    console.log(`[media] ${session.remoteAddress} ${component}=${state} (${reason})${idle}`);
  }
  if (component === 'video' && (state === 'idle' || state === 'closed')) {
    void stopVideoSink(session, `${component}-${state}`);
  }
  if (component === 'media' && (state === 'idle' || state === 'closed')) {
    stopSessionSinks(session, `${component}-${state}`);
  }
});
receiver.on('flush', ({ session }) => {
  if (values.verbose) console.log(`[flush] ${session.remoteAddress} reset media queues`);
  stopSessionSinks(session, 'flush');
});
receiver.on('timing-packet', ({ remote, replied }) => {
  if (values.verbose) {
    console.log(`[timing] ${remote.address}:${remote.port}${replied ? ' -> replied' : ''}`);
  }
});
receiver.on('event', ({ session, method, uri, payload }) => {
  if (values.verbose) {
    const summary = payload ? ` keys=${Object.keys(payload).join(',')}` : '';
    console.log(`[event] ${session.remoteAddress} ${method} ${uri}${summary}`);
  }
});
receiver.on('stream-error', ({ session, type, error }) => {
  console.warn(
    `[stream] ${session?.remoteAddress ?? 'unknown'} ${type ?? 'pipeline'}: ${error.message}`,
  );
});
receiver.on('teardown', ({ session }) => {
  console.log(`[teardown] ${session.remoteAddress} ended session`);
  stopSessionSinks(session, 'teardown', { forgetCodec: true });
});
receiver.on('error', (error) => {
  console.error(`[error] ${error.message}`);
});
receiver.on('warning', (error) => {
  if (values.verbose) console.warn(`[warning] ${error.message}`);
});

const { port } = await receiver.start();
const addresses = localIPv4Addresses().map((address) => address.address).join(', ')
  || 'no LAN address found';
console.log(`OpenMirror receiver "${receiverName}" started`);
console.log(`  control port : ${port}`);
console.log(`  addresses    : ${addresses}`);
console.log(`  device id    : ${receiver.options.deviceId}`);
console.log(`  identity     : ${receiverIdentity.path}${receiverIdentity.created ? ' (created)' : ''}`);
if (diagnosticsPath) console.log(`  diagnostics  : ${diagnosticsPath}`);
console.log('On your iPhone/iPad: Control Center → Screen Mirroring — the device should appear.');
console.log('Press Ctrl+C to stop.');

const discoveryWatchdog = setTimeout(() => {
  if (externalDiscoverySeen || sessionSeen) return;
  console.warn(
    '[network] No external AirPlay discovery query has reached OpenMirror.'
    + ' If Screen Mirroring is open on the device, check Windows Firewall/Public network'
    + ' policy and Wi-Fi client isolation.',
  );
  writeDiagnostic('network-warning', {
    code: 'no-external-discovery',
    elapsedMs: 15000,
  });
}, 15000);
discoveryWatchdog.unref?.();

let stopping = false;
let stopFileTimer = null;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(discoveryWatchdog);
  clearInterval(stopFileTimer);
  stopFileTimer = null;
  console.log('\nStopping (sending mDNS goodbye)…');
  await Promise.all([
    ...[...videoSinks.keys()].map((session) => stopVideoSink(session, 'shutdown')),
    ...[...audioSinks.keys()].map((session) => stopAudioSink(session, 'shutdown')),
  ]);
  videoSinks.clear();
  audioSinks.clear();
  latestCodecs.clear();
  await receiver.stop();
  const finalSnapshot = diagnostics.snapshot();
  writeDiagnostic('final-snapshot', finalSnapshot);
  diagnostics.close();
  await diagnosticsWriter?.close();
}

if (stopRequestPath) {
  stopFileTimer = setInterval(() => {
    if (!existsSync(stopRequestPath)) return;
    void stop().catch((error) => {
      console.error(`[shutdown] ${error.message}`);
      process.exitCode = 1;
    });
  }, 200);
  stopFileTimer.unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    await stop();
    process.exit(0);
  });
}
