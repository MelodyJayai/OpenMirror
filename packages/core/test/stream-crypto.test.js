import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  deriveFairPlaySessionKey, deriveMirrorStreamKey, unsignedConnectionId,
  MirrorStreamDecryptor, AudioPacketDecryptor,
} from '../src/crypto/stream.js';

test('unsignedConnectionId renders signed 64-bit ids as unsigned decimal', () => {
  assert.equal(unsignedConnectionId(123456), '123456');
  assert.equal(unsignedConnectionId(-1n), '18446744073709551615');
  assert.equal(unsignedConnectionId(-9223372036854775808n), '9223372036854775808');
  assert.throws(() => unsignedConnectionId(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.throws(() => unsignedConnectionId(1n << 64n), /64-bit/);
});

test('deriveMirrorStreamKey matches the documented SHA512 derivation', () => {
  const sessionKey = Buffer.alloc(16, 0x11);
  const { key, iv } = deriveMirrorStreamKey(sessionKey, 42n);
  const expectKey = crypto.createHash('sha512')
    .update('AirPlayStreamKey42').update(sessionKey).digest().subarray(0, 16);
  const expectIv = crypto.createHash('sha512')
    .update('AirPlayStreamIV42').update(sessionKey).digest().subarray(0, 16);
  assert.deepEqual(key, expectKey);
  assert.deepEqual(iv, expectIv);
});

test('deriveFairPlaySessionKey binds paired sessions to the X25519 secret', () => {
  const unwrapped = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const shared = Buffer.alloc(32, 0x5a);
  const expected = crypto.createHash('sha512').update(unwrapped).update(shared).digest().subarray(0, 16);
  assert.deepEqual(deriveFairPlaySessionKey(unwrapped, shared), expected);
  assert.deepEqual(deriveFairPlaySessionKey(unwrapped), unwrapped);
  assert.throws(() => deriveFairPlaySessionKey(unwrapped, Buffer.alloc(31)), /32 bytes/);
});

test('MirrorStreamDecryptor decrypts a continuous AES-CTR stream across frames', () => {
  const sessionKey = crypto.randomBytes(16);
  const connId = 987654321n;
  const { key, iv } = deriveMirrorStreamKey(sessionKey, connId);

  const clear1 = crypto.randomBytes(100);
  const clear2 = crypto.randomBytes(37);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
  const enc1 = cipher.update(clear1);
  const enc2 = cipher.update(clear2);

  const decryptor = new MirrorStreamDecryptor(sessionKey, connId);
  assert.deepEqual(decryptor.decrypt(enc1), clear1);
  assert.deepEqual(decryptor.decrypt(enc2), clear2); // keystream continues
});

test('AudioPacketDecryptor resets per packet and passes the tail through', () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);

  const encryptPacket = (clear) => {
    const full = clear.length - (clear.length % 16);
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(clear.subarray(0, full)), clear.subarray(full)]);
  };

  const decryptor = new AudioPacketDecryptor(key, iv);
  const a = crypto.randomBytes(48);      // whole blocks
  const b = crypto.randomBytes(41);      // 2 blocks + 9 clear tail bytes
  assert.deepEqual(decryptor.decrypt(encryptPacket(a)), a);
  assert.deepEqual(decryptor.decrypt(encryptPacket(b)), b); // independent packets
});
