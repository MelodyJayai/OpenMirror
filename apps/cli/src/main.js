#!/usr/bin/env node
// OpenMirror CLI receiver — advertises an AirPlay receiver on the LAN and
// logs the control-channel exchange. Protocol bring-up tool for M1–M3.

import { parseArgs } from 'node:util';
import { AirPlayReceiver, localIPv4Addresses } from '@openmirror/core';

const { values } = parseArgs({
  options: {
    name: { type: 'string', short: 'n', default: 'OpenMirror' },
    port: { type: 'string', short: 'p', default: '7000' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`OpenMirror — open-source wireless screen mirroring receiver

Usage: openmirror [options]

  -n, --name <name>   Receiver name shown on the sender (default: OpenMirror)
  -p, --port <port>   RTSP control port (default: 7000, 0 = random)
  -v, --verbose       Log every RTSP request
  -h, --help          Show this help
`);
  process.exit(0);
}

const receiver = new AirPlayReceiver({
  name: values.name,
  port: parseInt(values.port, 10),
});

receiver.on('request', ({ method, uri, session }) => {
  if (values.verbose) console.log(`[rtsp] ${session.remoteAddress} ${method} ${uri}`);
});
receiver.on('paired', ({ session }) => {
  console.log(`[pair] ${session.remoteAddress} completed pair-verify`);
});
receiver.on('setup', ({ session }) => {
  console.log(`[setup] ${session.remoteAddress} requested media session (media pipeline: milestone M4)`);
});
receiver.on('teardown', ({ session }) => {
  console.log(`[teardown] ${session.remoteAddress} ended session`);
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
    await receiver.stop();
    process.exit(0);
  });
}
