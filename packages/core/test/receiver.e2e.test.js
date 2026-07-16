// End-to-end: start an AirPlayReceiver on a random port (mDNS disabled is not
// possible yet, so this test does start the responder — it binds 5353 with
// reuseAddr and is torn down after) and drive /info + full pairing over TCP
// like an iOS sender would.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { AirPlayReceiver } from '../src/index.js';
import { RtspParser } from '../src/rtsp/parser.js';
import { decodeBplist, encodeBplist } from '../src/plist/bplist.js';
import { rawEd25519PublicKey, x25519PublicFromRaw, ed25519PublicFromRaw } from '../src/crypto/pairing.js';

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

  try {
    const setupBody = encodeBplist({
      timingProtocol: 'NTP',
      streams: [{ type: 110, streamConnectionID: 123456 }],
    });
    const setup = await client.request('SETUP rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 1', setupBody);
    assert.equal(setup.status, 200);
    const response = decodeBplist(setup.body);
    assert.ok(response.eventPort > 0);
    assert.ok(response.timingPort > 0);
    assert.equal(response.streams[0].type, 110);
    assert.equal(response.streams[0].streamConnectionID, 123456);
    assert.ok(response.streams[0].dataPort > 0);

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

    const teardown = await client.request('TEARDOWN rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 2');
    assert.equal(teardown.status, 200);
  } finally {
    video?.destroy();
    client.end();
    await receiver.stop();
  }
});
