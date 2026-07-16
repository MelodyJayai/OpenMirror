import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FairPlaySession,
  FPLY_HEADER,
  FP_SETUP1_LENGTH,
  FP_SETUP2_LENGTH,
  FP_REPLY1_LENGTH,
  FP_SETUP2_REPLY_HEADER,
} from '../src/crypto/fairplay.js';
import {
  createPlayFairProvider,
  PLAYFAIR_ENCRYPTED_KEY_BYTES,
} from '../src/crypto/playfair-provider.js';

function setup1(mode) {
  const request = Buffer.alloc(FP_SETUP1_LENGTH);
  FPLY_HEADER.copy(request);
  request[4] = 3;
  request[5] = 1;
  request[6] = 1;
  request[14] = mode;
  return request;
}

function setup2() {
  const request = Buffer.alloc(FP_SETUP2_LENGTH);
  for (let i = 0; i < request.length; i++) request[i] = (i * 17 + 3) & 0xff;
  FPLY_HEADER.copy(request);
  request[4] = 3;
  request[5] = 1;
  request[6] = 3;
  return request;
}

test('PlayFair WASM is sandboxed and has no host imports', () => {
  const bytes = readFileSync(new URL('../src/crypto/playfair.wasm', import.meta.url));
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(WebAssembly.Module.exports(module).map(({ name }) => name), [
    'memory', 'playfair_io_ptr', 'playfair_decrypt_io',
  ]);
});

test('real PlayFair provider serves the four SAPv2.5 setup replies', () => {
  const provider = createPlayFairProvider();
  const replies = Array.from({ length: 4 }, (_, mode) => provider.phase1(mode, setup1(mode)));
  for (let mode = 0; mode < replies.length; mode++) {
    assert.equal(replies[mode].length, FP_REPLY1_LENGTH);
    assert.deepEqual(replies[mode].subarray(0, 12), Buffer.from('46504c590301020000000082', 'hex'));
    assert.equal(replies[mode][13], mode);
  }
  assert.equal(new Set(replies.map((reply) => reply.toString('hex'))).size, 4);
  assert.throws(() => provider.phase1(4), /0\.\.3/);
});

test('real PlayFair provider unwraps a 72-byte media key with a completed session', () => {
  const provider = createPlayFairProvider();
  const session = new FairPlaySession(provider);
  session.handle(setup1(2));
  const request = setup2();
  const reply = session.handle(request);
  assert.deepEqual(reply.subarray(0, 12), FP_SETUP2_REPLY_HEADER);
  assert.deepEqual(reply.subarray(12), request.subarray(144));

  const encryptedKey = Buffer.alloc(PLAYFAIR_ENCRYPTED_KEY_BYTES);
  for (let i = 0; i < encryptedKey.length; i++) encryptedKey[i] = (i * 29 + 11) & 0xff;
  assert.equal(
    provider.decryptKey(encryptedKey, session).toString('hex'),
    '0d0db0e88d4dc1fd80778894fb118305',
  );
  assert.throws(() => provider.decryptKey(Buffer.alloc(16), session), /72 bytes/);
  assert.throws(
    () => provider.decryptKey(encryptedKey, new FairPlaySession(provider)),
    /phase 2 must complete/,
  );
});
