import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAvcC, parseSpsDimensions, avccToAnnexB, parameterSetsToAnnexB, hasKeyframe,
  H264StreamProcessor, MIRROR_PAYLOAD, MIRROR_VIDEO_OPTION, NAL_TYPE,
  isMirrorVideoSuspended,
} from '../src/stream/h264.js';

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac]); // type 7
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);       // type 8
const LANDSCAPE_SPS = Buffer.from(
  '67640016acd940a02ff97011000003000100000300020f162d96',
  'hex',
);
const PORTRAIT_SPS = Buffer.from(
  '67640016acd9417051e5f011000003000100000300020f162d96',
  'hex',
);

function buildAvcC({ nalLengthSize = 4, sps = SPS, pps = PPS } = {}) {
  return Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xfc | (nalLengthSize - 1), 0xe0 | 1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1]),
    Buffer.from([pps.length >> 8, pps.length & 0xff]), pps,
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

test('parseSpsDimensions reports cropped resolution and encoded orientation', () => {
  assert.deepEqual(parseSpsDimensions(LANDSCAPE_SPS), {
    width: 640,
    height: 360,
    codedWidth: 640,
    codedHeight: 368,
    orientation: 'landscape',
    interlaced: false,
  });
  assert.deepEqual(parseSpsDimensions(PORTRAIT_SPS), {
    width: 360,
    height: 640,
    codedWidth: 368,
    codedHeight: 640,
    orientation: 'portrait',
    interlaced: false,
  });
  assert.equal(parseAvcC(buildAvcC({ sps: LANDSCAPE_SPS })).dimensions.width, 640);
  assert.throws(() => parseSpsDimensions(PPS), /SPS/);
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

test('H264StreamProcessor reports codec revisions and orientation changes', () => {
  const codecs = [];
  const processor = new H264StreamProcessor({
    onCodec: (codec) => codecs.push(codec),
  });
  processor.push({
    type: MIRROR_PAYLOAD.CODEC,
    payload: buildAvcC({ sps: LANDSCAPE_SPS }),
    timestamp: 1n,
    payloadOption: 0x0156,
    displayDimensions: {
      source: { width: 640, height: 360, orientation: 'landscape' },
      encoded: { width: 640, height: 360, orientation: 'landscape' },
    },
  });
  processor.push({
    type: MIRROR_PAYLOAD.CODEC,
    payload: buildAvcC({ sps: PORTRAIT_SPS }),
    timestamp: 2n,
    displayDimensions: {
      source: { width: 360, height: 640, orientation: 'portrait' },
      encoded: { width: 360, height: 640, orientation: 'portrait' },
    },
  });

  assert.equal(codecs[0].revision, 1);
  assert.equal(codecs[0].payloadOption, 0x0156);
  assert.equal(codecs[0].dimensionsChanged, false);
  assert.equal(codecs[0].dimensions.orientation, 'landscape');
  assert.equal(codecs[1].revision, 2);
  assert.equal(codecs[1].dimensionsChanged, true);
  assert.equal(codecs[1].dimensions.orientation, 'portrait');
  assert.equal(codecs[1].displayDimensions.source.orientation, 'portrait');
  assert.equal(codecs[1].previousDimensions.width, 640);
  assert.equal(isMirrorVideoSuspended(0x0156), true);
  assert.equal(isMirrorVideoSuspended(0x0116), false);
  assert.equal(MIRROR_VIDEO_OPTION.H264_SUSPENDED, 0x56);
});
