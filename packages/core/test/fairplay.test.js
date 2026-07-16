import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FairPlaySession, createStubFairPlayProvider, classifyFpSetup, isFairPlayMessage,
  FP_SETUP1_LENGTH, FP_SETUP2_LENGTH, FP_REPLY1_LENGTH, FP_REPLY2_LENGTH, FPLY_HEADER,
} from '../src/crypto/fairplay.js';

function setup1(mode = 0) {
  const buf = Buffer.alloc(FP_SETUP1_LENGTH);
  FPLY_HEADER.copy(buf, 0);
  buf[4] = 0x03; buf[5] = 0x01; buf[6] = 0x01;
  buf[14] = mode;
  return buf;
}

function setup2() {
  const buf = Buffer.alloc(FP_SETUP2_LENGTH);
  FPLY_HEADER.copy(buf, 0);
  buf[4] = 0x03; buf[5] = 0x01; buf[6] = 0x03;
  for (let i = 16; i < buf.length; i++) buf[i] = i & 0xff;
  return buf;
}

test('isFairPlayMessage / classifyFpSetup recognize both phases', () => {
  assert.equal(isFairPlayMessage(setup1()), true);
  assert.equal(isFairPlayMessage(Buffer.from('bplist00')), false);
  assert.deepEqual(classifyFpSetup(setup1(2)), { phase: 1, mode: 2 });
  assert.deepEqual(classifyFpSetup(setup2()), { phase: 2, mode: null });
  assert.throws(() => classifyFpSetup(setup1(7)), /invalid mode/);
  assert.throws(() => classifyFpSetup(Buffer.alloc(16)), /FPLY/);
  assert.throws(() => classifyFpSetup(setup1().subarray(0, 15)), /must be 16 bytes/);
  const wrongVersion = setup1();
  wrongVersion[4] = 2;
  assert.throws(() => classifyFpSetup(wrongVersion), /unsupported version/);
  const wrongType = setup1();
  wrongType[6] = 3;
  assert.throws(() => classifyFpSetup(wrongType), /must be 164 bytes/);
});

test('FairPlaySession drives the two-phase handshake with correct reply shapes', () => {
  const session = new FairPlaySession(createStubFairPlayProvider());

  const reply1 = session.handle(setup1(3));
  assert.equal(reply1.length, FP_REPLY1_LENGTH);
  assert.deepEqual(reply1.subarray(0, 4), FPLY_HEADER);
  assert.equal(reply1[14], 3); // mode echoed
  assert.equal(session.phase, 1);

  const reply2 = session.handle(setup2());
  assert.equal(reply2.length, FP_REPLY2_LENGTH);
  assert.equal(session.phase, 2);
});

test('FairPlaySession rejects phase 2 before phase 1', () => {
  const session = new FairPlaySession(createStubFairPlayProvider());
  assert.throws(() => session.handle(setup2()), /phase 2 before phase 1/);
});

test('FairPlaySession surfaces provider sharedKey', () => {
  const key = Buffer.alloc(16, 0xab);
  const session = new FairPlaySession({
    phase1: (mode) => Buffer.alloc(FP_REPLY1_LENGTH),
    phase2: () => ({ reply: Buffer.alloc(FP_REPLY2_LENGTH), sharedKey: key }),
  });
  session.handle(setup1());
  session.handle(setup2());
  assert.deepEqual(session.sharedKey, key);
});
