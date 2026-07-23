import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlacDecoder, alacDecoderFromAnnounce } from '../src/alac.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// FFmpeg FATE reference: fate-lossless-alac decodes lossless-audio/inside.m4a
// to s16le and expects this md5 (FFmpeg tests/ref/fate/lossless-alac).
const FATE_ALAC_URL = 'https://fate-suite.ffmpeg.org/lossless-audio/inside.m4a';
const FATE_ALAC_PCM_MD5 = 'd0beb768d860b4776358077dd9fcb1e9';

// Committed fixture: sine + seeded pink noise stereo, encoded to ALAC by
// ffmpeg (2025-09-08 git build). The md5 is of ffmpeg's own s16le decode of
// the same file; ALAC is lossless, so our decoder must match bit-exactly.
const CROSSCHECK_PCM_MD5 = '11235134a370dfd6bd0a6aa305181abd';

class BitWriter {
  bits = [];

  write(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }

  writeString(text) {
    for (const ch of text) this.bits.push(ch === '1' ? 1 : 0);
    return this;
  }

  toBuffer() {
    const bytes = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >> 3] |= 0x80 >> (index & 7);
    });
    return bytes;
  }
}

function elementHeader(writer, { tag, partial = 0, shift = 0, escape = 0 }) {
  writer.write(tag, 3);
  writer.write(0, 4); // element instance tag
  writer.write(0, 12); // unused header, must be zero
  writer.write(partial, 1).write(shift, 2).write(escape, 1);
}

test('decodes a verbatim (escape) stereo CPE frame bit-exactly', () => {
  const u = [100, -5, 32767, -32768];
  const v = [1, 2, -3, 0];
  const writer = new BitWriter();
  elementHeader(writer, { tag: 1, escape: 1 });
  for (let i = 0; i < u.length; i++) {
    writer.write(u[i] & 0xffff, 16);
    writer.write(v[i] & 0xffff, 16);
  }
  writer.write(7, 3); // ID_END

  const decoder = new AlacDecoder({ frameLength: 4, bitDepth: 16, channels: 2 });
  const { samples, sampleCount, channels } = decoder.decode(writer.toBuffer());
  assert.equal(sampleCount, 4);
  assert.equal(channels, 2);
  assert.deepEqual([...samples], [100, 1, -5, 2, 32767, -3, -32768, 0]);
});

test('decodes a compressed all-zero CPE frame through the entropy coder', () => {
  const writer = new BitWriter();
  elementHeader(writer, { tag: 1 });
  writer.write(0, 8); // mixBits
  writer.write(0, 8); // mixRes
  for (let ch = 0; ch < 2; ch++) {
    writer.write(0x00, 8); // mode=0, denShift=0
    writer.write(0x80, 8); // pbFactor=4, numCoefs=0
  }
  // Residuals per channel: first sample 0, then an adaptive-Golomb zero run
  // covering the remaining 7 samples (see ag params for pb=40, mb=10, kb=14).
  for (let ch = 0; ch < 2; ch++) writer.writeString('0' + '0' + '1000');
  writer.write(7, 3);

  const decoder = new AlacDecoder({
    frameLength: 8, bitDepth: 16, channels: 2, pb: 40, mb: 10, kb: 14,
  });
  const { samples, sampleCount } = decoder.decode(writer.toBuffer());
  assert.equal(sampleCount, 8);
  assert.deepEqual([...samples], new Array(16).fill(0));
});

test('decodes matrixed stereo and the sign/zigzag of residuals', () => {
  // Residuals decode to [1, -1, 2, 0] on both channels (numCoefs=0 keeps the
  // predictor a passthrough); mixRes=1/mixBits=0 exercises the stereo matrix:
  // L = u + v - ((mixRes*v) >> mixBits) = u, R = L - v = u - v = 0.
  const residualBits = '110' + '00' + '0' + '00' + '1110' + '0';
  const writer = new BitWriter();
  elementHeader(writer, { tag: 1 });
  writer.write(0, 8); // mixBits
  writer.write(1, 8); // mixRes
  for (let ch = 0; ch < 2; ch++) {
    writer.write(0x00, 8);
    writer.write(0x80, 8);
  }
  for (let ch = 0; ch < 2; ch++) writer.writeString(residualBits);
  writer.write(7, 3);

  const decoder = new AlacDecoder({ frameLength: 4, bitDepth: 16, channels: 2 });
  const { samples } = decoder.decode(writer.toBuffer());
  assert.deepEqual([...samples], [1, 0, -1, 0, 2, 0, 0, 0]);
});

test('decodes a mono SCE frame and rejects malformed configs/frames', () => {
  const writer = new BitWriter();
  elementHeader(writer, { tag: 0, escape: 1 });
  for (const value of [7, -7]) writer.write(value & 0xffff, 16);
  writer.write(7, 3);
  const decoder = new AlacDecoder({ frameLength: 2, bitDepth: 16, channels: 1 });
  assert.deepEqual([...decoder.decode(writer.toBuffer()).samples], [7, -7]);

  assert.throws(() => new AlacDecoder({ frameLength: 0 }), /frameLength/);
  assert.throws(() => new AlacDecoder({ frameLength: 352, bitDepth: 24 }), /bit depth/);
  assert.throws(() => new AlacDecoder({ frameLength: 352, channels: 9 }), /channels/);
  const stereo = new AlacDecoder({ frameLength: 4, bitDepth: 16, channels: 2 });
  // Leading bits 010 → ID_CCE, which the decoder does not implement.
  assert.throws(() => stereo.decode(Buffer.from([0x40, 0x00])), /not supported/);
  assert.throws(() => stereo.decode(Buffer.alloc(0)), /truncated/);
  // An immediate ID_END leaves the declared channels undecoded.
  assert.throws(() => stereo.decode(Buffer.from([0xe0])), /missing channels/);
});

test('builds a decoder from parsed RAOP announce fmtp fields', () => {
  const announce = {
    alac: {
      frameLength: 352, compatibleVersion: 0, bitDepth: 16, pb: 40, mb: 10,
      kb: 14, channels: 2, maxRun: 255, maxFrameBytes: 0, avgBitRate: 0,
      sampleRate: 44100,
    },
  };
  const decoder = alacDecoderFromAnnounce(announce);
  assert.equal(decoder.config.frameLength, 352);
  assert.equal(decoder.config.sampleRate, 44100);
  assert.throws(() => alacDecoderFromAnnounce({}), /fmtp/);
});

// --- Minimal MP4 (ISO BMFF) reader, test-only: enough to pull the ALAC magic
// cookie and per-sample payloads out of a FATE .m4a fixture. ---

function* boxes(buffer, start = 0, end = buffer.length) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    yield { type, start: offset + headerSize, end: offset + size };
    offset += size;
  }
}

function findBox(buffer, path, start = 0, end = buffer.length) {
  const [head, ...rest] = path;
  for (const box of boxes(buffer, start, end)) {
    if (box.type !== head) continue;
    if (rest.length === 0) return box;
    const inner = findBox(buffer, rest, box.start, box.end);
    if (inner) return inner;
  }
  return null;
}

function parseAlacMp4(buffer) {
  for (const moovChild of boxes(
    buffer,
    findBox(buffer, ['moov']).start,
    findBox(buffer, ['moov']).end,
  )) {
    if (moovChild.type !== 'trak') continue;
    const stbl = findBox(buffer, ['mdia', 'minf', 'stbl'], moovChild.start, moovChild.end);
    if (!stbl) continue;
    const stsd = findBox(buffer, ['stsd'], stbl.start, stbl.end);
    const entry = [...boxes(buffer, stsd.start + 8, stsd.end)][0];
    if (entry?.type !== 'alac') continue;
    // Audio sample entry: 28 fixed bytes, then the nested 'alac' cookie box.
    const cookieBox = findBox(buffer, ['alac'], entry.start + 28, entry.end);
    const cookie = buffer.subarray(cookieBox.start + 4, cookieBox.end);
    const config = {
      frameLength: cookie.readUInt32BE(0),
      compatibleVersion: cookie.readUInt8(4),
      bitDepth: cookie.readUInt8(5),
      pb: cookie.readUInt8(6),
      mb: cookie.readUInt8(7),
      kb: cookie.readUInt8(8),
      channels: cookie.readUInt8(9),
      maxRun: cookie.readUInt16BE(10),
      maxFrameBytes: cookie.readUInt32BE(12),
      avgBitRate: cookie.readUInt32BE(16),
      sampleRate: cookie.readUInt32BE(20),
    };

    const stsz = findBox(buffer, ['stsz'], stbl.start, stbl.end);
    const fixedSize = buffer.readUInt32BE(stsz.start + 4);
    const sampleCount = buffer.readUInt32BE(stsz.start + 8);
    const sizes = [];
    for (let i = 0; i < sampleCount; i++) {
      sizes.push(fixedSize || buffer.readUInt32BE(stsz.start + 12 + i * 4));
    }

    const stsc = findBox(buffer, ['stsc'], stbl.start, stbl.end);
    const stscCount = buffer.readUInt32BE(stsc.start + 4);
    const runs = [];
    for (let i = 0; i < stscCount; i++) {
      const base = stsc.start + 8 + i * 12;
      runs.push({
        firstChunk: buffer.readUInt32BE(base),
        samplesPerChunk: buffer.readUInt32BE(base + 4),
      });
    }

    const stco = findBox(buffer, ['stco'], stbl.start, stbl.end);
    const co64 = stco ? null : findBox(buffer, ['co64'], stbl.start, stbl.end);
    const chunkBox = stco ?? co64;
    const chunkCount = buffer.readUInt32BE(chunkBox.start + 4);
    const chunkOffsets = [];
    for (let i = 0; i < chunkCount; i++) {
      chunkOffsets.push(stco
        ? buffer.readUInt32BE(chunkBox.start + 8 + i * 4)
        : Number(buffer.readBigUInt64BE(chunkBox.start + 8 + i * 8)));
    }

    const frames = [];
    let sampleIndex = 0;
    for (let chunk = 0; chunk < chunkCount && sampleIndex < sampleCount; chunk++) {
      let samplesPerChunk = runs[0].samplesPerChunk;
      for (const run of runs) {
        if (run.firstChunk <= chunk + 1) samplesPerChunk = run.samplesPerChunk;
      }
      let offset = chunkOffsets[chunk];
      for (let i = 0; i < samplesPerChunk && sampleIndex < sampleCount; i++) {
        const size = sizes[sampleIndex];
        frames.push(buffer.subarray(offset, offset + size));
        offset += size;
        sampleIndex += 1;
      }
    }
    return { config, frames };
  }
  throw new Error('no ALAC track found');
}

async function fetchFixture(url, filename) {
  const path = join(fixturesDir, filename);
  try {
    return await readFile(path);
  } catch {
    // fall through to download
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(path, data);
  return data;
}

function decodeMp4ToPcmMd5(m4a) {
  const { config, frames } = parseAlacMp4(m4a);
  assert.equal(config.bitDepth, 16);
  const decoder = new AlacDecoder(config);
  const hash = createHash('md5');
  let totalSamples = 0;
  for (const frame of frames) {
    const { samples, sampleCount, channels } = decoder.decode(frame);
    const bytes = Buffer.alloc(sampleCount * channels * 2);
    for (let i = 0; i < sampleCount * channels; i++) bytes.writeInt16LE(samples[i], i * 2);
    hash.update(bytes);
    totalSamples += sampleCount;
  }
  assert.ok(totalSamples > 0);
  return hash.digest('hex');
}

test('decodes the committed ffmpeg-encoded cross-check fixture bit-exactly', async () => {
  const m4a = await readFile(join(fixturesDir, 'crosscheck.m4a'));
  assert.equal(decodeMp4ToPcmMd5(m4a), CROSSCHECK_PCM_MD5);
});

test('decodes the FFmpeg FATE ALAC sample bit-exactly (md5 vs FATE reference)', async (t) => {
  let m4a;
  try {
    m4a = await fetchFixture(FATE_ALAC_URL, 'inside.m4a');
  } catch (error) {
    t.skip(`FATE sample unavailable (${error.message}); offline vectors still ran`);
    return;
  }
  assert.equal(decodeMp4ToPcmMd5(m4a), FATE_ALAC_PCM_MD5);
});
