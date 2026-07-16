#!/usr/bin/env node
// OpenMirror CLI receiver — advertises an AirPlay receiver on the LAN and
// logs the control-channel exchange. Protocol bring-up tool for M1–M3.

import { parseArgs } from 'node:util';
import { AirPlayReceiver, localIPv4Addresses } from '@openmirror/core';
import { FfplayVideoSink, probeFfplay } from '@openmirror/media';

const { values } = parseArgs({
  options: {
    name: { type: 'string', short: 'n', default: 'OpenMirror' },
    port: { type: 'string', short: 'p', default: '7000' },
    verbose: { type: 'boolean', short: 'v', default: false },
    headless: { type: 'boolean', default: false },
    ffplay: { type: 'string', default: 'ffplay' },
    fullscreen: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`OpenMirror — open-source wireless screen mirroring receiver

Usage: openmirror [options]

  -n, --name <name>   Receiver name shown on the sender (default: OpenMirror)
  -p, --port <port>   RTSP control port (default: 7000, 0 = random)
  -v, --verbose       Log every RTSP request
      --headless      Receive media without opening an ffplay window
      --ffplay <path> ffplay executable name/path (default: ffplay)
      --fullscreen    Open the video player fullscreen
  -h, --help          Show this help
`);
  process.exit(0);
}

const receiver = new AirPlayReceiver({
  name: values.name,
  port: parseInt(values.port, 10),
});

const displayEnabled = !values.headless && await probeFfplay({ executable: values.ffplay });
if (!values.headless && !displayEnabled) {
  console.warn(`[player] Cannot launch "${values.ffplay}"; continuing headless. Install FFmpeg/ffplay or pass --ffplay <path>.`);
}
const videoSinks = new Map();

function videoSinkFor(session) {
  if (!displayEnabled) return null;
  let sink = videoSinks.get(session);
  if (sink) return sink;
  sink = new FfplayVideoSink({
    executable: values.ffplay,
    title: `${values.name} — ${session.remoteAddress}`,
    fullscreen: values.fullscreen,
  });
  sink.on('started', ({ pid }) => console.log(`[player] opened ffplay (pid ${pid}) for ${session.remoteAddress}`));
  sink.on('process-error', (error) => console.error(`[player] ${error.message}`));
  sink.on('diagnostic', (message) => {
    if (values.verbose) console.error(`[ffplay] ${message}`);
  });
  sink.on('dropped', ({ chunks, bytes, reason }) => {
    if (values.verbose) console.warn(`[player] dropped ${chunks} chunk(s), ${bytes} bytes (${reason})`);
  });
  videoSinks.set(session, sink);
  return sink;
}

receiver.on('request', ({ method, uri, session }) => {
  if (values.verbose) console.log(`[rtsp] ${session.remoteAddress} ${method} ${uri}`);
});
receiver.on('paired', ({ session }) => {
  console.log(`[pair] ${session.remoteAddress} completed pair-verify`);
});
receiver.on('fp-setup', ({ session, phase }) => {
  console.log(`[fairplay] ${session.remoteAddress} fp-setup phase ${phase}`);
});
receiver.on('setup', ({ session, ports }) => {
  console.log(`[setup] ${session.remoteAddress} media ports: video TCP ${ports.videoPort}, event TCP ${ports.eventPort}, timing UDP ${ports.timingPort}, audio UDP ${ports.audioPort}/${ports.audioControlPort}`);
});
receiver.on('video-codec', ({ session, profile, level, sps, pps, annexB }) => {
  console.log(`[codec] ${session.remoteAddress} H.264 profile=${profile} level=${level} sps=${sps.length} pps=${pps.length}`);
  videoSinkFor(session)?.writeCodec({ annexB });
});
receiver.on('video-data', ({ session, annexB, keyframe, timestamp }) => {
  if (values.verbose) console.log(`[h264] ${session.remoteAddress} ${annexB.length} bytes${keyframe ? ' (keyframe)' : ''} ts=${timestamp}`);
  videoSinkFor(session)?.writeVideo({ annexB, keyframe });
});
receiver.on('video-frame', ({ session, type, payloadLength, timestamp }) => {
  if (values.verbose) console.log(`[video] ${session.remoteAddress} type=${type} bytes=${payloadLength} timestamp=${timestamp}`);
});
receiver.on('audio-data', ({ session, sequence, payload, encrypted }) => {
  if (values.verbose) console.log(`[audio] ${session.remoteAddress} seq=${sequence} bytes=${payload.length}${encrypted ? ' (encrypted)' : ''}`);
});
receiver.on('timing-packet', ({ remote, replied }) => {
  if (values.verbose) console.log(`[timing] ${remote.address}:${remote.port}${replied ? ' -> replied' : ''}`);
});
receiver.on('stream-error', ({ session, error }) => {
  if (values.verbose) console.log(`[stream] ${session?.remoteAddress ?? 'unknown'} pipeline: ${error.message}`);
});
receiver.on('teardown', ({ session }) => {
  console.log(`[teardown] ${session.remoteAddress} ended session`);
  const sink = videoSinks.get(session);
  videoSinks.delete(session);
  sink?.stop().catch((error) => console.error(`[player] ${error.message}`));
});
receiver.on('error', (err) => {
  console.error(`[error] ${err.message}`);
});

const { port } = await receiver.start();
const addresses = localIPv4Addresses().map((a) => a.address).join(', ') || 'no LAN address found';
console.log(`OpenMirror receiver "${values.name}" started`);
console.log(`  control port : ${port}`);
console.log(`  addresses    : ${addresses}`);
console.log(`  device id    : ${receiver.options.deviceId}`);
console.log('On your iPhone/iPad: Control Center → Screen Mirroring — the device should appear.');
console.log('Press Ctrl+C to stop.');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nStopping (sending mDNS goodbye)…');
    await Promise.all([...videoSinks.values()].map((sink) => sink.stop()));
    videoSinks.clear();
    await receiver.stop();
    process.exit(0);
  });
}
