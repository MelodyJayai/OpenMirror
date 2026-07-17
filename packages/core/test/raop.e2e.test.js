// End-to-end RAOP (audio-only) session: ANNOUNCE with an SDP body, legacy
// Transport-header SETUP, RECORD, RTP audio over UDP, SET_PARAMETER volume
// and TEARDOWN — the control plane older senders and audio-only apps use.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { AirPlayReceiver, ntpNow, parseTransportHeader } from '../src/index.js';
import { RtspParser } from '../src/rtsp/parser.js';

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const pending = [];
    const waiters = [];
    const parser = new RtspParser((m) => {
      const w = waiters.shift();
      if (w) w(m);
      else pending.push(m);
    });
    socket.on('data', (c) => parser.push(c));
    socket.on('error', reject);
    socket.on('connect', () => resolve({
      request(head, body = Buffer.alloc(0)) {
        socket.write(Buffer.concat([
          Buffer.from(`${head}\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
          body,
        ]));
        return new Promise((res) => {
          const m = pending.shift();
          if (m) res(m);
          else waiters.push(res);
        });
      },
      end: () => socket.end(),
      destroy: () => socket.destroy(),
    }));
  });
}

function announceSdp(extraLines) {
  return Buffer.from([
    'v=0',
    'o=iTunes 3413821438 0 IN IP4 127.0.0.1',
    's=iTunes',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=audio 0 RTP/AVP 96',
    'a=rtpmap:96 AppleLossless',
    'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
    ...extraLines,
  ].join('\r\n') + '\r\n', 'latin1');
}

function bindUdp() {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket));
  });
}

function send(socket, payload, port) {
  return new Promise((resolve, reject) => socket.send(
    payload, port, '127.0.0.1',
    (error) => error ? reject(error) : resolve(),
  ));
}

function syncPacket(rtpTimestamp, nextRtpTimestamp) {
  const packet = Buffer.alloc(20);
  packet[0] = 0x90;
  packet[1] = 0xd4;
  packet.writeUInt16BE(1, 2);
  packet.writeUInt32BE(rtpTimestamp, 4);
  packet.writeBigUInt64BE(ntpNow(), 8);
  packet.writeUInt32BE(nextRtpTimestamp, 16);
  return packet;
}

function rtpAudio(sequence, timestamp, payload) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 96;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(timestamp, 4);
  return Buffer.concat([header, payload]);
}

test('RAOP unencrypted ALAC session over ANNOUNCE + legacy SETUP', async () => {
  const receiver = new AirPlayReceiver({ name: 'RaopE2E', port: 0 });
  const { port } = await receiver.start();
  const client = await connect(port);
  const control = await bindUdp();
  const timing = await bindUdp();

  try {
    const announced = new Promise((resolve) => receiver.once('announce', resolve));
    const announceResponse = await client.request(
      'ANNOUNCE rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 1\r\nContent-Type: application/sdp',
      announceSdp([]),
    );
    assert.equal(announceResponse.status, 200);
    const announce = await announced;
    assert.equal(announce.codec, 'alac');
    assert.equal(announce.compressionType, 2);
    assert.equal(announce.samplesPerFrame, 352);
    assert.equal(announce.encryption, 'none');
    assert.equal(announce.hasKey, false);
    assert.equal(announce.ekey, undefined, 'announce event must not expose key material');

    const setupEvent = new Promise((resolve) => receiver.once('setup', resolve));
    const setup = await client.request(
      'SETUP rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 2\r\n'
      + 'Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record'
      + `;control_port=${control.address().port};timing_port=${timing.address().port}`,
    );
    assert.equal(setup.status, 200);
    assert.equal(setup.headers.session, '1');
    assert.equal(setup.headers['audio-jack-status'], 'connected; type=analog');
    const transport = parseTransportHeader(setup.headers.transport);
    const serverPort = Number(transport.params.server_port);
    assert.ok(serverPort > 0);
    assert.ok(transport.controlPort > 0);
    assert.ok(transport.timingPort > 0);
    const setupInfo = await setupEvent;
    assert.equal(setupInfo.payload, null);
    assert.equal(setupInfo.transport.controlPort, control.address().port);
    assert.deepEqual(setupInfo.crypto, {
      sessionKeyReady: false,
      audioDecryptorReady: false,
      videoDecryptorReady: false,
    });

    const recorded = new Promise((resolve) => receiver.once('record', resolve));
    const record = await client.request(
      'RECORD rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 3\r\nRTP-Info: seq=44;rtptime=2789220',
    );
    assert.equal(record.status, 200);
    assert.equal(record.headers['audio-latency'], '11025');
    assert.deepEqual((await recorded).rtpInfo, { seq: 44, rtptime: 2789220 });

    const synchronized = new Promise((resolve) => receiver.once('audio-sync', resolve));
    await send(control, syncPacket(2789220, 2789572), transport.controlPort);
    await synchronized;

    const audioReceived = new Promise((resolve) => receiver.once('audio-data', resolve));
    const alacFrame = Buffer.from([0x20, 0x00, 0x12, 0x34, 0x56, 0x78]);
    await send(control, rtpAudio(44, 2789572, alacFrame), serverPort);
    const packet = await audioReceived;
    assert.equal(packet.sequence, 44);
    assert.equal(packet.encrypted, false, 'unencrypted RAOP audio must not be flagged encrypted');
    assert.equal(packet.compressionType, 2);
    assert.equal(packet.samplesPerFrame, 352);
    assert.equal(packet.sampleRate, 44100);
    assert.deepEqual(packet.payload, alacFrame);

    const volumeChanged = new Promise((resolve) => receiver.once('volume', resolve));
    const setVolume = await client.request(
      'SET_PARAMETER rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 4\r\nContent-Type: text/parameters',
      Buffer.from('volume: -11.5\r\n', 'latin1'),
    );
    assert.equal(setVolume.status, 200);
    const volume = await volumeChanged;
    assert.equal(volume.volumeDb, -11.5);
    assert.equal(volume.muted, false);

    const getVolume = await client.request(
      'GET_PARAMETER rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 5\r\nContent-Type: text/parameters',
      Buffer.from('volume', 'latin1'),
    );
    assert.equal(getVolume.status, 200);
    assert.equal(getVolume.body.toString('latin1'), 'volume: -11.500000\r\n');

    const metadataReceived = new Promise((resolve) => receiver.once('metadata', resolve));
    const dmap = Buffer.from('6d696e6d00000009', 'hex');
    await client.request(
      'SET_PARAMETER rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 6\r\n'
      + 'Content-Type: application/x-dmap-tagged',
      dmap,
    );
    assert.equal((await metadataReceived).bytes, dmap.length);

    const teardown = await client.request('TEARDOWN rtsp://127.0.0.1/3413821438 RTSP/1.0\r\nCSeq: 7');
    assert.equal(teardown.status, 200);
  } finally {
    control.close();
    timing.close();
    client.destroy();
    await receiver.stop();
  }
});

test('RAOP FairPlay session decrypts AES-CBC audio with the unwrapped key', async () => {
  const sessionKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const wrappedKey = Buffer.alloc(72, 0x5a);
  const receiver = new AirPlayReceiver({
    name: 'RaopFairPlayE2E',
    port: 0,
    fairPlayProvider: {
      decryptKey(ekey) {
        assert.deepEqual(ekey, wrappedKey);
        return Buffer.from(sessionKey);
      },
    },
  });
  const { port } = await receiver.start();
  const client = await connect(port);
  const control = await bindUdp();

  try {
    const announced = new Promise((resolve) => receiver.once('announce', resolve));
    const announceResponse = await client.request(
      'ANNOUNCE rtsp://127.0.0.1/1 RTSP/1.0\r\nCSeq: 1\r\nContent-Type: application/sdp',
      announceSdp([
        `a=fpaeskey:${wrappedKey.toString('base64')}`,
        `a=aesiv:${iv.toString('base64')}`,
      ]),
    );
    assert.equal(announceResponse.status, 200);
    const announce = await announced;
    assert.equal(announce.encryption, 'fairplay');
    assert.equal(announce.hasKey, true);
    assert.equal(announce.hasIv, true);

    const setup = await client.request(
      'SETUP rtsp://127.0.0.1/1 RTSP/1.0\r\nCSeq: 2\r\n'
      + `Transport: RTP/AVP/UDP;unicast;mode=record;control_port=${control.address().port}`,
    );
    assert.equal(setup.status, 200);
    const transport = parseTransportHeader(setup.headers.transport);
    const serverPort = Number(transport.params.server_port);

    const synchronized = new Promise((resolve) => receiver.once('audio-sync', resolve));
    await send(control, syncPacket(1000, 1352), transport.controlPort);
    await synchronized;

    const clearAudio = Buffer.concat([Buffer.from([0x20, 0x00]), crypto.randomBytes(39)]);
    const encryptedLength = clearAudio.length - (clearAudio.length % 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', sessionKey, iv);
    cipher.setAutoPadding(false);
    const encryptedAudio = Buffer.concat([
      cipher.update(clearAudio.subarray(0, encryptedLength)),
      clearAudio.subarray(encryptedLength),
    ]);

    const audioReceived = new Promise((resolve) => receiver.once('audio-data', resolve));
    await send(control, rtpAudio(1, 1352, encryptedAudio), serverPort);
    const packet = await audioReceived;
    assert.equal(packet.encrypted, false);
    assert.deepEqual(packet.payload, clearAudio);
  } finally {
    control.close();
    client.destroy();
    await receiver.stop();
  }
});

test('RAOP rejects RSA-encrypted announces with 453', async () => {
  const receiver = new AirPlayReceiver({ name: 'RaopRsaE2E', port: 0 });
  const { port } = await receiver.start();
  const client = await connect(port);

  try {
    const errored = new Promise((resolve) => receiver.once('stream-error', resolve));
    const response = await client.request(
      'ANNOUNCE rtsp://127.0.0.1/1 RTSP/1.0\r\nCSeq: 1\r\nContent-Type: application/sdp',
      announceSdp([
        `a=rsaaeskey:${Buffer.alloc(32, 3).toString('base64')}`,
        `a=aesiv:${Buffer.alloc(16, 9).toString('base64')}`,
      ]),
    );
    assert.equal(response.status, 453);
    const failure = await errored;
    assert.equal(failure.type, 'raop-announce');
    assert.match(failure.error.message, /RSA/);

    const malformed = await client.request(
      'ANNOUNCE rtsp://127.0.0.1/1 RTSP/1.0\r\nCSeq: 2\r\nContent-Type: application/sdp',
      Buffer.from('not an sdp body', 'latin1'),
    );
    assert.equal(malformed.status, 400);
  } finally {
    client.destroy();
    await receiver.stop();
  }
});
