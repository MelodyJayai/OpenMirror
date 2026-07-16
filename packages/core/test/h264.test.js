import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAvcC, avccToAnnexB, parameterSetsToAnnexB, hasKeyframe,
  H264StreamProcessor, MIRROR_PAYLOAD, NAL_TYPE,
} from '../src/stream/h264.js';

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac]); // type 7
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);       // type 8

function buildAvcC({ nalLengthSize = 4 } = {}) {
  return Buffer.concat([
    Buffer.from([1, SPS[1], SPS[2], SPS[3], 0xfc | (nalLengthSize - 1), 0xe0 | 1]),
    Buffer.from([SPS.length >> 8, SPS.length & 0xff]), SPS,
    Buffer.from([1]),
    Buffer.from([PPS.length >> 8, PPS.length & 0xff]), PPS,
  ]);
}

function avccUnit(...nals) {
  return Buffer.concat(nals.flatMap((nal) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length);
    return [len, nal];
  }));
}

test('parseAvcC extracts SPS/PPS and NAL length size', () => {
  const avcC = parseAvcC(buildAvcC());
  assert.equal(avcC.profile, SPS[1]);
  assert.equal(avcC.nalLengthSize, 4);
  assert.deepEqual(avcC.sps, [SPS]);
  assert.deepEqual(avcC.pps, [PPS]);
  assert.throws(() => parseAvcC(Buffer.from([2, 0, 0])), /avcC/);
  assert.throws(() => parseAvcC(buildAvcC().subarray(0, 13)), /PPS|truncated|overruns/);
});

test('parameterSetsToAnnexB prefixes start codes', () => {
  const annexB = parameterSetsToAnnexB(parseAvcC(buildAvcC()));
  assert.deepEqual(
    annexB,
    Buffer.concat([Buffer.from([0, 0, 0, 1]), SPS, Buffer.from([0, 0, 0, 1]), PPS]),
  );
});

test('avccToAnnexB converts length prefixes and reports NAL types', () => {
  const idr = Buffer.from([0x65, 1, 2, 3]);
  const sei = Buffer.from([0x06, 9]);
  const { annexB, nalTypes } = avccToAnnexB(avccUnit(sei, idr));
  assert.deepEqual(nalTypes, [NAL_TYPE.SEI, NAL_TYPE.IDR]);
  assert.equal(hasKeyframe(nalTypes), true);
  assert.deepEqual(
    annexB,
    Buffer.concat([Buffer.from([0, 0, 0, 1]), sei, Buffer.from([0, 0, 0, 1]), idr]),
  );
});

test('avccToAnnexB rejects NALs overrunning the payload', () => {
  const bad = Buffer.from([0, 0, 0, 10, 1, 2]);
  assert.throws(() => avccToAnnexB(bad), /overruns/);
  assert.throws(() => avccToAnnexB(Buffer.from([0, 0, 0])), /trailing/);
  assert.throws(() => avccToAnnexB(Buffer.alloc(0), 0), /between 1 and 4/);
});

test('H264StreamProcessor emits codec config then access units', () => {
  const codecs = [];
  const units = [];
  const processor = new H264StreamProcessor({
    onCodec: (c) => codecs.push(c),
    onVideo: (u) => units.push(u),
  });

  processor.push({ type: MIRROR_PAYLOAD.CODEC, payload: buildAvcC(), timestamp: 1n });
  processor.push({ type: MIRROR_PAYLOAD.HEARTBEAT, payload: Buffer.alloc(0), timestamp: 2n });
  processor.push({
    type: MIRROR_PAYLOAD.VIDEO,
    payload: avccUnit(Buffer.from([0x65, 0xaa])),
    timestamp: 3n,
  });

  assert.equal(codecs.length, 1);
  assert.deepEqual(codecs[0].sps, [SPS]);
  assert.equal(units.length, 1);
  assert.equal(units[0].keyframe, true);
  assert.equal(units[0].timestamp, 3n);
});
