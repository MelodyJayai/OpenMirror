import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBplist, decodeBplist } from '../src/plist/bplist.js';

test('roundtrip: primitives', () => {
  const doc = {
    string: 'hello',
    unicode: '屏幕镜像 🎥',
    int: 42,
    bigOne: 4102444800,
    negative: -7,
    real: 3.5,
    yes: true,
    no: false,
    nothing: null,
    data: Buffer.from([1, 2, 3, 255]),
  };
  const decoded = decodeBplist(encodeBplist(doc));
  assert.equal(decoded.string, 'hello');
  assert.equal(decoded.unicode, '屏幕镜像 🎥');
  assert.equal(decoded.int, 42);
  assert.equal(decoded.bigOne, 4102444800);
  assert.equal(decoded.negative, -7);
  assert.equal(decoded.real, 3.5);
  assert.equal(decoded.yes, true);
  assert.equal(decoded.no, false);
  assert.equal(decoded.nothing, null);
  assert.deepEqual([...decoded.data], [1, 2, 3, 255]);
});

test('roundtrip: nested arrays and dicts (AirPlay /info shape)', () => {
  const doc = {
    name: 'OpenMirror',
    displays: [
      { widthPixels: 1920, heightPixels: 1080, refreshRate: 60, overscanned: false },
    ],
    audioFormats: [
      { type: 100, audioInputFormats: 0x3fffffc },
      { type: 101, audioInputFormats: 0x3fffffc },
    ],
  };
  const decoded = decodeBplist(encodeBplist(doc));
  assert.equal(decoded.displays[0].widthPixels, 1920);
  assert.equal(decoded.displays[0].overscanned, false);
  assert.equal(decoded.audioFormats.length, 2);
  assert.equal(decoded.audioFormats[1].type, 101);
});

test('roundtrip: date', () => {
  const when = new Date('2026-07-16T12:00:00.000Z');
  const decoded = decodeBplist(encodeBplist({ when }));
  assert.equal(decoded.when.getTime(), when.getTime());
});

test('roundtrip: long strings and >14-entry collections use extended length', () => {
  const doc = {
    long: 'x'.repeat(300),
    many: Array.from({ length: 20 }, (_, i) => i),
  };
  const decoded = decodeBplist(encodeBplist(doc));
  assert.equal(decoded.long.length, 300);
  assert.equal(decoded.many.length, 20);
  assert.equal(decoded.many[19], 19);
});

test('decode rejects non-bplist input', () => {
  assert.throws(() => decodeBplist(Buffer.from('not a plist at all, definitely')));
});

test('known-good fixture decodes (encoded by this impl, spot-check bytes)', () => {
  const buf = encodeBplist({ a: 1 });
  assert.equal(buf.toString('latin1', 0, 8), 'bplist00');
  // trailer: last 8 bytes hold the offset-table start
  const tableStart = Number(buf.readBigUInt64BE(buf.length - 8));
  assert.ok(tableStart > 8 && tableStart < buf.length - 32);
});
