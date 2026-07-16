import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { RtspServer } from '../src/rtsp/server.js';
import { RtspParser } from '../src/rtsp/parser.js';
import { decodeBplist, encodeBplist } from '../src/plist/bplist.js';
import { buildServices, formatFeatures, DEFAULT_FEATURES, randomDeviceId } from '../src/discovery/airplay.js';
import { isUsableLanIPv4 } from '../src/discovery/responder.js';

test('LAN address filtering excludes loopback, multicast and benchmark adapters', () => {
  assert.equal(isUsableLanIPv4('10.10.0.129'), true);
  assert.equal(isUsableLanIPv4('192.168.1.20'), true);
  assert.equal(isUsableLanIPv4('198.18.0.1'), false);
  assert.equal(isUsableLanIPv4('127.0.0.1'), false);
  assert.equal(isUsableLanIPv4('224.0.0.251'), false);
  assert.equal(isUsableLanIPv4('not-an-address'), false);
});

test('formatFeatures splits the 64-bit mask into low,high hex', () => {
  assert.equal(formatFeatures(0x5a7ffee6n), '0x5A7FFEE6');
  assert.equal(formatFeatures((1n << 40n) | 0xe6n), '0xE6,0x100');
});

test('buildServices produces AirPlay + RAOP registrations with required TXT keys', () => {
  const services = buildServices({
    name: 'TestMirror',
    deviceId: 'AA:BB:CC:DD:EE:FF',
    publicKeyHex: 'ab'.repeat(32),
    airplayPort: 7100,
  });
  assert.equal(services.length, 2);
  const [airplay, raop] = services;
  assert.equal(airplay.type, '_airplay._tcp.local');
  assert.equal(airplay.port, 7100);
  for (const key of ['deviceid', 'features', 'model', 'pk', 'srcvers']) {
    assert.ok(airplay.txt[key], `airplay TXT missing ${key}`);
  }
  assert.equal(raop.type, '_raop._tcp.local');
  assert.equal(raop.name, 'AABBCCDDEEFF@TestMirror');
  for (const key of ['ch', 'cn', 'et', 'ft', 'pk', 'tp']) {
    assert.ok(raop.txt[key], `raop TXT missing ${key}`);
  }
});

test('randomDeviceId returns a locally-administered unicast MAC', () => {
  const id = randomDeviceId();
  assert.match(id, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  const first = parseInt(id.slice(0, 2), 16);
  assert.equal(first & 0x01, 0, 'must be unicast');
  assert.equal(first & 0x02, 2, 'must be locally administered');
});

/** Send raw RTSP bytes over a socket and resolve with parsed responses. */
function rtspExchange(port, requests) {
  return new Promise((resolve, reject) => {
    const responses = [];
    const socket = net.connect(port, '127.0.0.1');
    const parser = new RtspParser((m) => {
      responses.push(m);
      if (responses.length === requests.length) {
        socket.end();
        resolve(responses);
      }
    });
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', reject);
    socket.on('connect', () => {
      for (const request of requests) socket.write(request);
    });
    setTimeout(() => reject(new Error('rtsp exchange timeout')), 3000).unref();
  });
}

test('RtspServer dispatches handlers and echoes CSeq', async () => {
  const server = new RtspServer();
  server.handle('GET', '/info', () => ({
    status: 200,
    headers: { 'Content-Type': 'application/x-apple-binary-plist' },
    body: encodeBplist({ name: 'TestMirror', features: 123 }),
  }));
  server.handle('OPTIONS', () => ({ status: 200, headers: { Public: 'SETUP, RECORD' } }));

  const port = await server.listen(0, '127.0.0.1');
  try {
    const [info, options, missing] = await rtspExchange(port, [
      'GET /info RTSP/1.0\r\nCSeq: 1\r\n\r\n',
      'OPTIONS * RTSP/1.0\r\nCSeq: 2\r\n\r\n',
      'DESCRIBE /nope RTSP/1.0\r\nCSeq: 3\r\n\r\n',
    ]);

    assert.equal(info.status, 200);
    assert.equal(info.headers['cseq'], '1');
    const decoded = decodeBplist(info.body);
    assert.equal(decoded.name, 'TestMirror');
    assert.equal(decoded.features, 123);

    assert.equal(options.status, 200);
    assert.match(options.headers['public'], /SETUP/);

    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cseq'], '3');
  } finally {
    await server.close();
  }
});

test('RtspServer keeps per-connection session state', async () => {
  const server = new RtspServer();
  server.handle('POST', '/count', (request, ctx) => {
    ctx.session.state.count = (ctx.session.state.count ?? 0) + 1;
    return { status: 200, headers: { 'X-Count': String(ctx.session.state.count) } };
  });
  const port = await server.listen(0, '127.0.0.1');
  try {
    const [first, second] = await rtspExchange(port, [
      'POST /count RTSP/1.0\r\nCSeq: 1\r\n\r\n',
      'POST /count RTSP/1.0\r\nCSeq: 2\r\n\r\n',
    ]);
    assert.equal(first.headers['x-count'], '1');
    assert.equal(second.headers['x-count'], '2');
  } finally {
    await server.close();
  }
});
