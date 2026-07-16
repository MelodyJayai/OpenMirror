import test from 'node:test';
import assert from 'node:assert/strict';
import { RtspParser, encodeResponse } from '../src/rtsp/parser.js';

function collect() {
  const messages = [];
  const parser = new RtspParser((m) => messages.push(m));
  return { messages, parser };
}

test('parses a complete request with body', () => {
  const { messages, parser } = collect();
  const body = Buffer.from('0123456789');
  parser.push(Buffer.concat([
    Buffer.from('POST /pair-setup RTSP/1.0\r\nCSeq: 3\r\nContent-Length: 10\r\n\r\n', 'latin1'),
    body,
  ]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'POST');
  assert.equal(messages[0].uri, '/pair-setup');
  assert.equal(messages[0].headers['cseq'], '3');
  assert.deepEqual(messages[0].body, body);
});

test('handles byte-by-byte delivery', () => {
  const { messages, parser } = collect();
  const raw = Buffer.from('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n', 'latin1');
  for (const byte of raw) parser.push(Buffer.from([byte]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'OPTIONS');
});

test('handles multiple pipelined messages in one chunk', () => {
  const { messages, parser } = collect();
  parser.push(Buffer.from(
    'GET /info RTSP/1.0\r\nCSeq: 1\r\n\r\n' +
    'RECORD rtsp://x/y RTSP/1.0\r\nCSeq: 2\r\nContent-Length: 2\r\n\r\nhi',
    'latin1',
  ));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].method, 'GET');
  assert.equal(messages[1].method, 'RECORD');
  assert.equal(messages[1].body.toString(), 'hi');
});

test('parses HTTP-style requests too', () => {
  const { messages, parser } = collect();
  parser.push(Buffer.from('GET /info HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1'));
  assert.equal(messages[0].version, 'HTTP/1.1');
});

test('parses responses', () => {
  const { messages, parser } = collect();
  parser.push(Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 5\r\n\r\n', 'latin1'));
  assert.equal(messages[0].kind, 'response');
  assert.equal(messages[0].status, 200);
});

test('encodeResponse emits CSeq and Content-Length', () => {
  const out = encodeResponse({
    status: 200,
    headers: { CSeq: '4' },
    body: Buffer.from('abc'),
  }).toString('latin1');
  assert.match(out, /^RTSP\/1\.0 200 OK\r\n/);
  assert.match(out, /CSeq: 4\r\n/);
  assert.match(out, /Content-Length: 3\r\n/);
  assert.match(out, /\r\n\r\nabc$/);
});

test('rejects oversized bodies', () => {
  const { parser } = collect();
  assert.throws(() => parser.push(Buffer.from(
    'POST /x RTSP/1.0\r\nContent-Length: 999999999\r\n\r\n', 'latin1',
  )));
});
