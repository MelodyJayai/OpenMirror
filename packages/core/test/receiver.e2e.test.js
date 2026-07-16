// End-to-end: start an AirPlayReceiver on a random port (mDNS disabled is not
// possible yet, so this test does start the responder — it binds 5353 with
// reuseAddr and is torn down after) and drive /info + full pairing over TCP
// like an iOS sender would.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { AirPlayReceiver } from '../src/index.js';
import { RtspParser } from '../src/rtsp/parser.js';
import { decodeBplist, encodeBplist } from '../src/plist/bplist.js';
import { rawEd25519PublicKey, x25519PublicFromRaw, ed25519PublicFromRaw } from '../src/crypto/pairing.js';
import {
  FPLY_HEADER, FP_SETUP1_LENGTH, FP_SETUP2_LENGTH, FP_REPLY1_LENGTH,
  FP_REPLY2_LENGTH, FP_SETUP2_REPLY_HEADER,
} from '../src/crypto/fairplay.js';

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
    }));
  });
}

test('AirPlayReceiver serves /info and completes legacy pairing end-to-end', async () => {
  const receiver = new AirPlayReceiver({ name: 'E2ETest', port: 0 });
  const { port } = await receiver.start();
  const client = await connect(port);

  try {
    // GET /info
    const info = await client.request('GET /info RTSP/1.0\r\nCSeq: 1');
    assert.equal(info.status, 200);
    const dict = decodeBplist(info.body);
    assert.equal(dict.name, 'E2ETest');
    assert.ok(dict.deviceid);
    assert.equal(dict.pk.length, 32);
    assert.deepEqual(Buffer.from(dict.pk), receiver.identity.publicKeyRaw);

    // pair-setup
    const clientId = crypto.generateKeyPairSync('ed25519');
    const clientCurve = crypto.generateKeyPairSync('x25519');
    const clientEdRaw = rawEd25519PublicKey(clientId.publicKey);
    const curveDer = clientCurve.publicKey.export({ format: 'der', type: 'spki' });
    const clientCurveRaw = Buffer.from(curveDer.subarray(curveDer.length - 32));

    const setup = await client.request('POST /pair-setup RTSP/1.0\r\nCSeq: 2', clientEdRaw);
    assert.equal(setup.status, 200);
    assert.equal(setup.body.length, 32);

    // pair-verify step 1
    const step1 = await client.request(
      'POST /pair-verify RTSP/1.0\r\nCSeq: 3',
      Buffer.concat([Buffer.from([1, 0, 0, 0]), clientCurveRaw, clientEdRaw]),
    );
    assert.equal(step1.status, 200);
    assert.equal(step1.body.length, 96);
    const serverCurveRaw = step1.body.subarray(0, 32);

    const shared = crypto.diffieHellman({
      privateKey: clientCurve.privateKey,
      publicKey: x25519PublicFromRaw(serverCurveRaw),
    });
    const aesKey = crypto.createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest().subarray(0, 16);
    const aesIv = crypto.createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest().subarray(0, 16);

    const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, aesIv);
    const serverSig = decipher.update(step1.body.subarray(32, 96));
    assert.equal(crypto.verify(
      null,
      Buffer.concat([serverCurveRaw, clientCurveRaw]),
      ed25519PublicFromRaw(setup.body),
      serverSig,
    ), true);

    // pair-verify step 2
    const paired = new Promise((res) => receiver.once('paired', res));
    const clientSig = crypto.sign(null, Buffer.concat([clientCurveRaw, serverCurveRaw]), clientId.privateKey);
    const cipher = crypto.createCipheriv('aes-128-ctr', aesKey, aesIv);
    cipher.update(Buffer.alloc(64));
    const step2 = await client.request(
      'POST /pair-verify RTSP/1.0\r\nCSeq: 4',
      Buffer.concat([Buffer.from([0, 0, 0, 0]), cipher.update(clientSig)]),
    );
    assert.equal(step2.status, 200);
    await paired;

    // fp-setup phase 1/2 wire state machine (default provider is shape-only).
    const fp1Body = Buffer.alloc(FP_SETUP1_LENGTH);
    FPLY_HEADER.copy(fp1Body);
    fp1Body[4] = 3;
    fp1Body[5] = 1;
    fp1Body[6] = 1;
    fp1Body[14] = 2;
    const fp1 = await client.request('POST /fp-setup RTSP/1.0\r\nCSeq: 5', fp1Body);
    assert.equal(fp1.status, 200);
    assert.equal(fp1.body.length, FP_REPLY1_LENGTH);

    const fp2Body = Buffer.alloc(FP_SETUP2_LENGTH);
    FPLY_HEADER.copy(fp2Body);
    fp2Body[4] = 3;
    fp2Body[5] = 1;
    fp2Body[6] = 3;
    const fp2 = await client.request('POST /fp-setup RTSP/1.0\r\nCSeq: 6', fp2Body);
    assert.equal(fp2.status, 200);
    assert.equal(fp2.body.length, FP_REPLY2_LENGTH);
    assert.deepEqual(fp2.body.subarray(0, 12), FP_SETUP2_REPLY_HEADER);
    assert.deepEqual(fp2.body.subarray(12), fp2Body.subarray(144));
  } finally {
    client.end();
    await receiver.stop();
  }
});

test('AirPlayReceiver SETUP allocates a media transport and forwards mirror frames', async () => {
  const receiver = new AirPlayReceiver({ name: 'MediaE2E', port: 0 });
  const { port } = await receiver.start();
  const client = await connect(port);
  let video;
  let audio;
  let eventClient;

  try {
    const setupBody = encodeBplist({
      timingProtocol: 'NTP',
      streams: [
        { type: 110, streamConnectionID: 123456 },
        { type: 96, audioFormat: 0x40000 },
      ],
    });
    const setup = await client.request('SETUP rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 1', setupBody);
    assert.equal(setup.status, 200);
    const response = decodeBplist(setup.body);
    assert.ok(response.eventPort > 0);
    assert.ok(response.timingPort > 0);
    assert.equal(response.streams[0].type, 110);
    assert.equal(response.streams[0].streamConnectionID, 123456);
    assert.ok(response.streams[0].dataPort > 0);
    assert.equal(response.streams[1].type, 96);
    assert.ok(response.streams[1].dataPort > 0);
    assert.ok(response.streams[1].controlPort > 0);

    const frameReceived = new Promise((resolve) => receiver.once('video-frame', resolve));
    video = net.connect(response.streams[0].dataPort, '127.0.0.1');
    await new Promise((resolve, reject) => video.once('connect', resolve).once('error', reject));
    const payload = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const header = Buffer.alloc(128);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt16LE(1, 4);
    header.writeBigUInt64LE(777n, 8);
    video.write(Buffer.concat([header, payload]));

    const frame = await frameReceived;
    assert.equal(frame.type, 1);
    assert.equal(frame.timestamp, 777n);
    assert.deepEqual(frame.payload, payload);

    const audioReceived = new Promise((resolve) => receiver.once('audio-data', resolve));
    audio = dgram.createSocket('udp4');
    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 96;
    rtpHeader.writeUInt16BE(10, 2);
    const audioPayload = Buffer.from([4, 5, 6]);
    audio.send(Buffer.concat([rtpHeader, audioPayload]), response.streams[1].dataPort, '127.0.0.1');
    const audioPacket = await audioReceived;
    assert.equal(audioPacket.sequence, 10);
    assert.equal(audioPacket.encrypted, true);
    assert.deepEqual(audioPacket.payload, audioPayload);

    const reordered = [];
    const reorderedPackets = new Promise((resolve) => {
      const onAudio = ({ sequence }) => {
        if (sequence !== 11 && sequence !== 12) return;
        reordered.push(sequence);
        if (reordered.length === 2) {
          receiver.removeListener('audio-data', onAudio);
          resolve();
        }
      };
      receiver.on('audio-data', onAudio);
    });
    for (const sequence of [12, 11]) {
      const header = Buffer.from(rtpHeader);
      header.writeUInt16BE(sequence, 2);
      await new Promise((resolve, reject) => audio.send(
        Buffer.concat([header, Buffer.from([sequence])]),
        response.streams[1].dataPort,
        '127.0.0.1',
        (error) => error ? reject(error) : resolve(),
      ));
    }
    await reorderedPackets;
    assert.deepEqual(reordered, [11, 12]);

    const eventReceived = new Promise((resolve) => receiver.once('event', resolve));
    eventClient = await connect(response.eventPort);
    const eventBody = encodeBplist({ type: 'playbackState', state: 'playing' });
    const eventResponse = await eventClient.request('POST /event HTTP/1.1\r\nCSeq: 3', eventBody);
    assert.equal(eventResponse.version, 'HTTP/1.1');
    assert.equal(eventResponse.status, 200);
    const event = await eventReceived;
    assert.equal(event.method, 'POST');
    assert.equal(event.uri, '/event');
    assert.deepEqual(event.payload, { type: 'playbackState', state: 'playing' });

    const teardown = await client.request('TEARDOWN rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 2');
    assert.equal(teardown.status, 200);
  } finally {
    video?.destroy();
    audio?.close();
    eventClient?.end();
    client.end();
    await receiver.stop();
  }
});
