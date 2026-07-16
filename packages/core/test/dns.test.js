import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPE, encodeName, decodeName, encodeMessage, decodeMessage,
  FLAG_RESPONSE, FLAG_AUTHORITATIVE,
} from '../src/discovery/dns.js';

test('encodeName/decodeName roundtrip', () => {
  const buf = encodeName('_airplay._tcp.local');
  const { name, next } = decodeName(buf, 0);
  assert.equal(name, '_airplay._tcp.local');
  assert.equal(next, buf.length);
});

test('decodeName follows compression pointers', () => {
  // "local" at offset 0, then a name "foo" + pointer to offset 0.
  const base = encodeName('local'); // 7 bytes: 5"local"0
  const compressed = Buffer.concat([
    base,
    Buffer.from([3]), Buffer.from('foo', 'latin1'),
    Buffer.from([0xc0, 0x00]),
  ]);
  const { name, next } = decodeName(compressed, base.length);
  assert.equal(name, 'foo.local');
  assert.equal(next, compressed.length);
});

test('decodeName rejects pointer loops', () => {
  // Pointer at offset 2 pointing back to offset 0 which points to itself is
  // caught by the forward/monotonic guard.
  const evil = Buffer.from([0xc0, 0x00]);
  assert.throws(() => decodeName(evil, 0));
});

test('full message roundtrip: PTR + SRV + TXT + A', () => {
  const message = {
    id: 0,
    flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE,
    answers: [
      { name: '_airplay._tcp.local', type: TYPE.PTR, ttl: 4500, data: 'OpenMirror._airplay._tcp.local' },
      {
        name: 'OpenMirror._airplay._tcp.local', type: TYPE.SRV, ttl: 120, cacheFlush: true,
        data: { priority: 0, weight: 0, port: 7000, target: 'myhost.local' },
      },
      {
        name: 'OpenMirror._airplay._tcp.local', type: TYPE.TXT, ttl: 4500, cacheFlush: true,
        data: { deviceid: 'AA:BB:CC:DD:EE:FF', features: '0x5A7FFEE6', model: 'AppleTV3,2' },
      },
    ],
    additionals: [
      { name: 'myhost.local', type: TYPE.A, ttl: 120, cacheFlush: true, data: '192.168.1.50' },
    ],
  };

  const decoded = decodeMessage(encodeMessage(message));
  assert.equal(decoded.flags & FLAG_RESPONSE, FLAG_RESPONSE);
  assert.equal(decoded.answers.length, 3);
  assert.equal(decoded.answers[0].data, 'OpenMirror._airplay._tcp.local');
  assert.deepEqual(decoded.answers[1].data, { priority: 0, weight: 0, port: 7000, target: 'myhost.local' });
  assert.equal(decoded.answers[1].cacheFlush, true);
  assert.equal(decoded.answers[2].data.deviceid, 'AA:BB:CC:DD:EE:FF');
  assert.equal(decoded.additionals[0].data, '192.168.1.50');
});

test('question roundtrip with unicast-response bit', () => {
  const decoded = decodeMessage(encodeMessage({
    questions: [{ name: '_raop._tcp.local', type: TYPE.PTR, unicastResponse: true }],
  }));
  assert.equal(decoded.questions[0].name, '_raop._tcp.local');
  assert.equal(decoded.questions[0].unicastResponse, true);
});

test('AAAA roundtrip', () => {
  const decoded = decodeMessage(encodeMessage({
    answers: [{ name: 'h.local', type: TYPE.AAAA, ttl: 120, data: 'fe80::1' }],
  }));
  assert.equal(decoded.answers[0].data, 'fe80:0:0:0:0:0:0:1');
});

test('TXT boolean-flag entries survive roundtrip', () => {
  const decoded = decodeMessage(encodeMessage({
    answers: [{ name: 's.local', type: TYPE.TXT, ttl: 10, data: { da: 'true', flag: true } }],
  }));
  assert.equal(decoded.answers[0].data.da, 'true');
  assert.equal(decoded.answers[0].data.flag, true);
});

test('decodeMessage rejects truncated packets', () => {
  assert.throws(() => decodeMessage(Buffer.alloc(5)));
  const good = encodeMessage({ answers: [{ name: 'a.local', type: TYPE.A, ttl: 1, data: '1.2.3.4' }] });
  assert.throws(() => decodeMessage(good.subarray(0, good.length - 3)));
});
