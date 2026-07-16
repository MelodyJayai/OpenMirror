// End-to-end: start an AirPlayReceiver on a random port (mDNS disabled is not
// possible yet, so this test does start the responder — it binds 5353 with
// reuseAddr and is torn down after) and drive /info + full pairing over TCP
// like an iOS sender would.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {
  AUDIO_PAYLOAD,
  AirPlayReceiver,
  DEFAULT_FEATURES,
  deriveMirrorStreamKey,
  ntpNow,
  parseAudioRetransmitRequest,
} from '../src/index.js';
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
      destroy: () => socket.destroy(),
    }));
  });
}

function mirrorFrame(type, payload, timestamp, flags = 0, option = 0) {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(payload.length, 0);
  header[4] = type;
  header[5] = flags;
  header.writeUInt16LE(option, 6);
  header.writeBigUInt64LE(timestamp, 8);
  return Buffer.concat([header, payload]);
}

function avcC(sps, pps) {
  return Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]),
    sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]),
    pps,
  ]);
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
    assert.equal(dict.features, Number(DEFAULT_FEATURES));
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
    audio = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      audio.once('error', reject);
      audio.bind(0, '127.0.0.1', resolve);
    });
    const setupBody = encodeBplist({
      timingProtocol: 'NTP',
      streams: [
        { type: 110, streamConnectionID: 123456 },
        {
          type: 96,
          audioFormat: 0x40000,
          ct: 8,
          sr: 44100,
          spf: 480,
          controlPort: audio.address().port,
        },
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

    let audioDelivered = false;
    const noDataPackets = [];
    const noDataReceived = new Promise((resolve) => {
      const onNoData = (packet) => {
        noDataPackets.push(packet);
        if (noDataPackets.length === 1) resolve(packet);
      };
      receiver.on('audio-no-data', onNoData);
    });
    const audioReceived = new Promise((resolve) => receiver.once('audio-data', (packet) => {
      audioDelivered = true;
      resolve(packet);
    }));
    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 96;
    rtpHeader.writeUInt16BE(10, 2);
    rtpHeader.writeUInt32BE(1440, 4);
    const audioPayload = Buffer.from([4, 5, 6]);
    const noDataHeader = Buffer.from(rtpHeader);
    noDataHeader.writeUInt16BE(9, 2);
    noDataHeader.writeUInt32BE(960, 4);
    const noDataPacket = Buffer.concat([
      noDataHeader,
      Buffer.from([0x00, 0x68, 0x34, 0x00]),
    ]);
    for (let index = 0; index < 2; index++) {
      await new Promise((resolve, reject) => audio.send(
        noDataPacket,
        response.streams[1].dataPort,
        '127.0.0.1',
        (error) => error ? reject(error) : resolve(),
      ));
    }
    await new Promise((resolve, reject) => audio.send(
      Buffer.concat([rtpHeader, audioPayload]),
      response.streams[1].dataPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    await new Promise((resolve, reject) => audio.send(
      noDataPacket,
      response.streams[1].dataPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    await new Promise((resolve, reject) => audio.send(
      Buffer.concat([rtpHeader, audioPayload]),
      response.streams[1].dataPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(audioDelivered, false, 'audio waits for the first RTP/NTP sync anchor');
    const noData = await noDataReceived;
    assert.equal(noData.sequence, 9);
    assert.equal(noData.timestamp, 960);
    assert.equal(noData.bytes, 4);
    assert.equal(noDataPackets.length, 1, 'triplicated no-data RTP is reported once after sequencing');

    const synchronized = new Promise((resolve) => receiver.once('audio-sync', resolve));
    const syncPacket = Buffer.alloc(20);
    syncPacket[0] = 0x90;
    syncPacket[1] = 0xd4;
    syncPacket.writeUInt16BE(4, 2);
    syncPacket.writeUInt32BE(960, 4);
    syncPacket.writeBigUInt64BE(ntpNow(), 8);
    syncPacket.writeUInt32BE(1440, 16);
    audio.send(syncPacket, response.streams[1].controlPort, '127.0.0.1');
    const sync = await synchronized;
    assert.equal(sync.rtpTimestamp, 960);
    assert.equal(sync.timing.source, 'arrival');

    const audioPacket = await audioReceived;
    assert.equal(audioPacket.sequence, 10);
    assert.equal(audioPacket.encrypted, true);
    assert.equal(audioPacket.compressionType, 8);
    assert.equal(audioPacket.samplesPerFrame, 480);
    assert.equal(audioPacket.sampleRate, 44100);
    assert.equal(audioPacket.timing.source, 'arrival');
    assert.ok(Number.isFinite(audioPacket.timing.presentationTimeMs));
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
    const retransmitRequest = new Promise((resolve) => audio.once('message', resolve));
    const sequence12Header = Buffer.from(rtpHeader);
    sequence12Header.writeUInt16BE(12, 2);
    await new Promise((resolve, reject) => audio.send(
      Buffer.concat([sequence12Header, Buffer.from([12])]),
      response.streams[1].dataPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    assert.deepEqual(parseAudioRetransmitRequest(await retransmitRequest), {
      version: 2,
      marker: true,
      payloadType: AUDIO_PAYLOAD.RETRANSMIT_REQUEST,
      requestSequence: 0,
      sequence: 11,
      count: 1,
    });
    const sequence11Header = Buffer.from(rtpHeader);
    sequence11Header.writeUInt16BE(11, 2);
    const retransmitted = Buffer.concat([
      Buffer.from([0x80, 0x80 | AUDIO_PAYLOAD.RETRANSMITTED, 0, 0]),
      sequence11Header,
      Buffer.from([11]),
    ]);
    await new Promise((resolve, reject) => audio.send(
      retransmitted,
      response.streams[1].controlPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    await reorderedPackets;
    assert.deepEqual(reordered, [11, 12]);

    const flushed = new Promise((resolve) => receiver.once('flush', resolve));
    const flush = await client.request('FLUSH rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 2');
    assert.equal(flush.status, 200);
    await flushed;

    let deliveredAfterFlush = false;
    const postFlushAudio = new Promise((resolve) => receiver.once('audio-data', (packet) => {
      if (packet.sequence !== 13) return;
      deliveredAfterFlush = true;
      resolve(packet);
    }));
    const postFlushHeader = Buffer.from(rtpHeader);
    postFlushHeader.writeUInt16BE(13, 2);
    postFlushHeader.writeUInt32BE(1920, 4);
    await new Promise((resolve, reject) => audio.send(
      Buffer.concat([postFlushHeader, Buffer.from([13])]),
      response.streams[1].dataPort,
      '127.0.0.1',
      (error) => error ? reject(error) : resolve(),
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveredAfterFlush, false, 'FLUSH clears the previous audio clock anchor');
    syncPacket.writeUInt32BE(1920, 4);
    syncPacket.writeBigUInt64BE(ntpNow(), 8);
    syncPacket.writeUInt32BE(2400, 16);
    audio.send(syncPacket, response.streams[1].controlPort, '127.0.0.1');
    assert.equal((await postFlushAudio).sequence, 13);

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

    const teardown = await client.request('TEARDOWN rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 3');
    assert.equal(teardown.status, 200);
  } finally {
    video?.destroy();
    audio?.close();
    eventClient?.end();
    client.end();
    await receiver.stop();
  }
});

test('AirPlayReceiver closes media after an abnormal RTSP disconnect', async () => {
  const receiver = new AirPlayReceiver({ name: 'ReconnectE2E', port: 0 });
  const { port } = await receiver.start();
  const opened = new Promise((resolve) => receiver.once('session-opened', resolve));
  const client = await connect(port);
  const session = await opened;

  try {
    const mediaClosed = new Promise((resolve) => {
      const onState = (event) => {
        if (event.session === session && event.component === 'media' && event.state === 'closed') {
          receiver.off('media-state', onState);
          resolve(event);
        }
      };
      receiver.on('media-state', onState);
    });
    const sessionClosed = new Promise((resolve) => receiver.once('session-closed', resolve));
    const setup = await client.request(
      'SETUP rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 1',
      encodeBplist({ streams: [{ type: 110, streamConnectionID: 99 }] }),
    );
    assert.equal(setup.status, 200);

    client.destroy();
    assert.equal(await sessionClosed, session);
    assert.equal((await mediaClosed).reason, 'session-closed');
    assert.equal(session.state.media, undefined);
  } finally {
    client.destroy();
    await receiver.stop();
  }
});

test('AirPlayReceiver stop waits for active session media cleanup', async () => {
  const receiver = new AirPlayReceiver({ name: 'StopCleanupE2E', port: 0 });
  const { port } = await receiver.start();
  const opened = new Promise((resolve) => receiver.once('session-opened', resolve));
  const client = await connect(port);
  const session = await opened;
  let stopped = false;

  try {
    const setup = await client.request(
      'SETUP rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 1',
      encodeBplist({ streams: [{ type: 110, streamConnectionID: 100 }] }),
    );
    assert.equal(setup.status, 200);
    assert.ok(session.state.media);
    const closed = new Promise((resolve) => receiver.once('session-closed', resolve));

    await receiver.stop();
    stopped = true;
    assert.equal(await closed, session);
    assert.equal(session.state.media, undefined);
  } finally {
    client.destroy();
    if (!stopped) await receiver.stop();
  }
});

test('AirPlayReceiver decrypts H.264 and AAC-ELD after real PlayFair key unwrap', async () => {
  const receiver = new AirPlayReceiver({ name: 'EncryptedMediaE2E', port: 0 });
  const { port } = await receiver.start();
  const client = await connect(port);
  const audio = dgram.createSocket('udp4');
  let video;

  try {
    const fp1Body = Buffer.alloc(FP_SETUP1_LENGTH);
    FPLY_HEADER.copy(fp1Body);
    fp1Body[4] = 3;
    fp1Body[5] = 1;
    fp1Body[6] = 1;
    fp1Body[14] = 2;
    assert.equal(
      (await client.request('POST /fp-setup RTSP/1.0\r\nCSeq: 1', fp1Body)).status,
      200,
    );

    const fp2Body = Buffer.alloc(FP_SETUP2_LENGTH);
    for (let i = 0; i < fp2Body.length; i++) fp2Body[i] = (i * 17 + 3) & 0xff;
    FPLY_HEADER.copy(fp2Body);
    fp2Body[4] = 3;
    fp2Body[5] = 1;
    fp2Body[6] = 3;
    assert.equal(
      (await client.request('POST /fp-setup RTSP/1.0\r\nCSeq: 2', fp2Body)).status,
      200,
    );

    const encryptedKey = Buffer.alloc(72);
    for (let i = 0; i < encryptedKey.length; i++) encryptedKey[i] = (i * 29 + 11) & 0xff;
    const sessionKey = Buffer.from('0d0db0e88d4dc1fd80778894fb118305', 'hex');
    const audioIv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const connectionId = 7654321;
    const setupEvent = new Promise((resolve) => receiver.once('setup', resolve));
    const setup = await client.request(
      'SETUP rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 3',
      encodeBplist({
        ekey: encryptedKey,
        eiv: audioIv,
        streams: [
          { type: 110, streamConnectionID: connectionId },
          { type: 96, audioFormat: 0x40000, ct: 8, sr: 44100, spf: 480 },
        ],
      }),
    );
    assert.equal(setup.status, 200);
    const setupInfo = await setupEvent;
    assert.deepEqual(setupInfo.crypto, {
      sessionKeyReady: true,
      audioDecryptorReady: true,
      videoDecryptorReady: true,
    });
    const response = decodeBplist(setup.body);

    const sps = Buffer.from('67640016acd940a02ff97011000003000100000300020f162d96', 'hex');
    const pps = Buffer.from('68ebe3cb22c0', 'hex');
    const codecPromise = new Promise((resolve) => receiver.once('video-codec', resolve));
    const videoPromise = new Promise((resolve) => receiver.once('video-data', resolve));
    video = net.connect(response.streams[0].dataPort, '127.0.0.1');
    await new Promise((resolve, reject) => video.once('connect', resolve).once('error', reject));
    video.write(mirrorFrame(1, avcC(sps, pps), 1n));
    const codec = await codecPromise;
    assert.equal(codec.dimensions.width, 640);
    assert.equal(codec.dimensions.height, 360);

    const clearNal = Buffer.from([0x65, 0x88, 0x84, 0x21]);
    const clearVideo = Buffer.alloc(4 + clearNal.length);
    clearVideo.writeUInt32BE(clearNal.length);
    clearNal.copy(clearVideo, 4);
    const streamMaterial = deriveMirrorStreamKey(sessionKey, connectionId);
    const videoCipher = crypto.createCipheriv(
      'aes-128-ctr',
      streamMaterial.key,
      streamMaterial.iv,
    );
    video.write(mirrorFrame(0, videoCipher.update(clearVideo), 2n, 0x10));
    const videoUnit = await videoPromise;
    assert.equal(videoUnit.keyframe, true);
    assert.deepEqual(videoUnit.annexB, Buffer.concat([Buffer.from([0, 0, 0, 1]), clearNal]));

    const videoIdle = new Promise((resolve) => {
      const onState = (event) => {
        if (event.component !== 'video' || event.state !== 'idle') return;
        receiver.off('media-state', onState);
        resolve(event);
      };
      receiver.on('media-state', onState);
    });
    video.write(mirrorFrame(1, avcC(sps, pps), 3n, 0, 0x0156));
    assert.equal((await videoIdle).reason, 'sender-suspended');

    const videoResumed = new Promise((resolve) => {
      const onState = (event) => {
        if (event.component !== 'video' || event.reason !== 'resumed') return;
        receiver.off('media-state', onState);
        resolve(event);
      };
      receiver.on('media-state', onState);
    });
    video.write(mirrorFrame(0, videoCipher.update(clearVideo), 4n, 0x10));
    assert.equal((await videoResumed).state, 'streaming');

    const syncPromise = new Promise((resolve) => receiver.once('audio-sync', resolve));
    const syncPacket = Buffer.alloc(20);
    syncPacket[0] = 0x90;
    syncPacket[1] = 0xd4;
    syncPacket.writeUInt16BE(1, 2);
    syncPacket.writeUInt32BE(1000, 4);
    syncPacket.writeBigUInt64BE(ntpNow(), 8);
    syncPacket.writeUInt32BE(1480, 16);
    audio.send(syncPacket, response.streams[1].controlPort, '127.0.0.1');
    await syncPromise;

    const clearAudio = Buffer.concat([Buffer.from([0x8c]), crypto.randomBytes(40)]);
    const encryptedLength = clearAudio.length - (clearAudio.length % 16);
    const audioCipher = crypto.createCipheriv('aes-128-cbc', sessionKey, audioIv);
    audioCipher.setAutoPadding(false);
    const encryptedAudio = Buffer.concat([
      audioCipher.update(clearAudio.subarray(0, encryptedLength)),
      clearAudio.subarray(encryptedLength),
    ]);
    const audioPromise = new Promise((resolve) => receiver.once('audio-data', resolve));
    const rtp = Buffer.alloc(12);
    rtp[0] = 0x80;
    rtp[1] = 96;
    rtp.writeUInt16BE(1, 2);
    rtp.writeUInt32BE(1480, 4);
    audio.send(
      Buffer.concat([rtp, encryptedAudio]),
      response.streams[1].dataPort,
      '127.0.0.1',
    );
    const audioPacket = await audioPromise;
    assert.equal(audioPacket.encrypted, false);
    assert.equal(audioPacket.compressionType, 8);
    assert.deepEqual(audioPacket.payload, clearAudio);

    assert.equal(
      (await client.request('TEARDOWN rtsp://127.0.0.1/stream RTSP/1.0\r\nCSeq: 4')).status,
      200,
    );
  } finally {
    video?.destroy();
    audio.close();
    client.destroy();
    await receiver.stop();
  }
});
