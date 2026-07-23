// Pure-JS Apple Lossless (ALAC) frame decoder for RAOP audio streams.
//
// Implements the bitstream documented by Apple's open-source ALAC release
// (apache-2.0, github.com/macosforge/alac): per-frame SCE/CPE elements with
// adaptive-Golomb entropy coding, an adaptive FIR predictor, and matrixed
// stereo unmixing. RAOP senders describe the decoder parameters with the
// 11-field ALAC fmtp line (same layout as ALACSpecificConfig).
//
// Only 16-bit output is implemented; that is the only depth AirPlay senders
// use for ALAC (fmtp bitDepth field 16).

const ID_SCE = 0;
const ID_CPE = 1;
const ID_CCE = 2;
const ID_LFE = 3;
const ID_DSE = 4;
const ID_PCE = 5;
const ID_FIL = 6;
const ID_END = 7;

const QBSHIFT = 9;
const QB = 1 << QBSHIFT;
const MMULSHIFT = 2;
const MDENSHIFT = QBSHIFT - MMULSHIFT - 1;
const MOFF = 1 << (MDENSHIFT - 2);
const BITOFF = 24;
const N_MAX_MEAN_CLAMP = 0xffff;
const N_MEAN_CLAMP_VAL = 0xffff;
const MAX_PREFIX = 9;
const MAX_DATATYPE_BITS_16 = 16;

class BitReader {
  #buffer;
  #bitLength;
  bitPos = 0;

  constructor(buffer) {
    this.#buffer = buffer;
    this.#bitLength = buffer.length * 8;
  }

  get bitLength() {
    return this.#bitLength;
  }

  /** Read up to 32 bits MSB-first; throws past the end of the frame. */
  read(count) {
    if (this.bitPos + count > this.#bitLength) {
      throw new Error('ALAC frame truncated');
    }
    const value = this.peek(count);
    this.bitPos += count;
    return value;
  }

  /** Peek up to 32 bits MSB-first, zero-padded past the end of the frame. */
  peek(count) {
    let value = 0;
    let pos = this.bitPos;
    let remaining = count;
    const buffer = this.#buffer;
    while (remaining > 0) {
      const byteIndex = pos >> 3;
      const bitOffset = pos & 7;
      const available = 8 - bitOffset;
      const take = Math.min(available, remaining);
      const byte = byteIndex < buffer.length ? buffer[byteIndex] : 0;
      const chunk = (byte >> (available - take)) & ((1 << take) - 1);
      value = value * 2 ** take + chunk;
      pos += take;
      remaining -= take;
    }
    return value;
  }

  advance(count) {
    this.bitPos += count;
    if (this.bitPos > this.#bitLength) throw new Error('ALAC frame truncated');
  }

  byteAlign() {
    this.bitPos = (this.bitPos + 7) & ~7;
  }
}

function clz32NonBuiltin(value) {
  return value === 0 ? 32 : Math.clz32(value);
}

/** floor(log2(x + 3)) — Apple's lg3a() Golomb parameter estimate. */
function lg3a(x) {
  return 31 - clz32NonBuiltin((x + 3) | 0);
}

function countLeadingOnes(reader, limit) {
  let count = 0;
  while (count < limit && reader.peek(1) === 1) {
    reader.advance(1);
    count += 1;
  }
  return count;
}

/** Adaptive-Golomb decode of one 16-bit-escaped value (zero-run lengths). */
function dynGet(reader, m, k) {
  const pre = countLeadingOnes(reader, MAX_PREFIX);
  if (pre >= MAX_PREFIX) {
    return reader.read(MAX_DATATYPE_BITS_16);
  }
  reader.advance(1);
  if (k === 1) return pre;
  const v = reader.peek(k);
  if (v < 2) {
    reader.advance(k - 1);
    return pre * m;
  }
  reader.advance(k);
  return pre * m + v - 1;
}

/** Adaptive-Golomb decode of one residual with an maxBits raw escape. */
function dynGet32(reader, m, k, maxBits) {
  const pre = countLeadingOnes(reader, MAX_PREFIX);
  if (pre >= MAX_PREFIX) {
    return reader.read(maxBits);
  }
  reader.advance(1);
  let result = pre * m;
  if (k !== 1) {
    const v = reader.peek(k);
    if (v >= 2) {
      reader.advance(k);
      result += v - 1;
    } else {
      reader.advance(k - 1);
    }
  }
  return result;
}

/** Entropy-decode numSamples prediction residuals into out. */
function dynDecomp(reader, out, numSamples, maxSize, { mb0, pb, kb, wb }) {
  let mb = mb0;
  let zmode = 0;
  let c = 0;
  while (c < numSamples) {
    if (reader.bitPos >= reader.bitLength) throw new Error('ALAC frame truncated');
    let m = mb >>> QBSHIFT;
    let k = Math.min(lg3a(m), kb);
    m = (1 << k) - 1;

    const n = dynGet32(reader, m, k, maxSize);

    // The least significant bit of the decoded value is the sign bit.
    const ndecode = n + zmode;
    const multiplier = (-(ndecode & 1)) | 1;
    out[c] = Math.imul((ndecode + 1) >>> 1, multiplier);
    c += 1;

    mb = (Math.imul(pb, n + zmode) + mb - ((Math.imul(pb, mb) >>> QBSHIFT))) >>> 0;
    if (n > N_MAX_MEAN_CLAMP) mb = N_MEAN_CLAMP_VAL;
    zmode = 0;

    if (((mb << MMULSHIFT) >>> 0) < QB && c < numSamples) {
      zmode = 1;
      k = clz32NonBuiltin(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT);
      const mz = ((1 << k) - 1) & wb;
      const runLength = dynGet(reader, mz, k);
      if (c + runLength > numSamples) throw new Error('ALAC zero run overflows frame');
      out.fill(0, c, c + runLength);
      c += runLength;
      if (runLength >= 65535) zmode = 0;
      mb = 0;
    }
  }
}

function signOfInt(value) {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/**
 * Reverse the adaptive FIR predictor (Apple's unpc_block). coefs adapt during
 * decoding, so callers pass a scratch Int16Array copy.
 */
function unpcBlock(residuals, out, num, coefs, numActive, chanBits, denShift) {
  const chanShift = 32 - chanBits;
  const denHalf = denShift > 0 ? 1 << (denShift - 1) : 0;

  out[0] = residuals[0];
  if (numActive === 0) {
    if (out !== residuals) for (let j = 1; j < num; j++) out[j] = residuals[j];
    return;
  }
  if (numActive === 31) {
    // Special "one raw sample" mode: plain first-order accumulation.
    let prev = out[0];
    for (let j = 1; j < num; j++) {
      const del = (residuals[j] + prev) | 0;
      prev = (del << chanShift) >> chanShift;
      out[j] = prev;
    }
    return;
  }

  for (let j = 1; j <= numActive; j++) {
    const del = (residuals[j] + out[j - 1]) | 0;
    out[j] = (del << chanShift) >> chanShift;
  }

  const lim = numActive + 1;
  for (let j = lim; j < num; j++) {
    const top = out[j - lim];
    let sum1 = 0;
    for (let k = 0; k < numActive; k++) {
      sum1 = (sum1 + Math.imul(coefs[k], (out[j - 1 - k] - top) | 0)) | 0;
    }

    let del = residuals[j] | 0;
    let del0 = del;
    const sg = signOfInt(del);
    del = (del + top + ((sum1 + denHalf) >> denShift)) | 0;
    out[j] = (del << chanShift) >> chanShift;

    if (sg > 0) {
      for (let k = numActive - 1; k >= 0; k--) {
        const dd = (top - out[j - 1 - k]) | 0;
        const sgn = signOfInt(dd);
        coefs[k] -= sgn;
        del0 -= (numActive - k) * ((Math.imul(sgn, dd)) >> denShift);
        if (del0 <= 0) break;
      }
    } else if (sg < 0) {
      for (let k = numActive - 1; k >= 0; k--) {
        const dd = (top - out[j - 1 - k]) | 0;
        const sgn = signOfInt(dd);
        coefs[k] += sgn;
        del0 -= (numActive - k) * ((Math.imul(-sgn, dd)) >> denShift);
        if (del0 >= 0) break;
      }
    }
  }
}

/** Matrixed stereo unmix into interleaved 16-bit output (Apple's unmix16). */
function unmix16(u, v, out, outOffset, stride, numSamples, mixBits, mixRes) {
  let offset = outOffset;
  if (mixRes !== 0) {
    for (let j = 0; j < numSamples; j++) {
      const l = (u[j] + v[j] - (Math.imul(mixRes, v[j]) >> mixBits)) | 0;
      out[offset] = l;
      out[offset + 1] = (l - v[j]) | 0;
      offset += stride;
    }
  } else {
    for (let j = 0; j < numSamples; j++) {
      out[offset] = u[j];
      out[offset + 1] = v[j];
      offset += stride;
    }
  }
}

/**
 * Stateless ALAC frame decoder configured from the 11 RAOP fmtp fields (the
 * ALACSpecificConfig layout): frameLength, compatibleVersion, bitDepth, pb,
 * mb, kb, channels, maxRun, maxFrameBytes, avgBitRate, sampleRate.
 */
export class AlacDecoder {
  #config;
  #mixU;
  #mixV;
  #residuals;
  #coefs;

  constructor(config = {}) {
    const frameLength = config.frameLength;
    const bitDepth = config.bitDepth ?? 16;
    const channels = config.channels ?? 2;
    if (!Number.isInteger(frameLength) || frameLength < 1 || frameLength > 65536) {
      throw new Error('ALAC frameLength must be an integer between 1 and 65536');
    }
    if (bitDepth !== 16) {
      throw new Error(`ALAC bit depth ${bitDepth} is not supported (only 16)`);
    }
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
      throw new Error('ALAC channels must be an integer between 1 and 8');
    }
    this.#config = {
      frameLength,
      bitDepth,
      channels,
      pb: config.pb ?? 40,
      mb: config.mb ?? 10,
      kb: config.kb ?? 14,
      sampleRate: config.sampleRate ?? 44100,
    };
    this.#mixU = new Int32Array(frameLength);
    this.#mixV = new Int32Array(frameLength);
    this.#residuals = new Int32Array(frameLength);
    this.#coefs = new Int16Array(32);
  }

  get config() {
    return { ...this.#config };
  }

  /**
   * Decode one ALAC frame (an RTP payload after decryption). Returns
   * interleaved signed 16-bit samples and the per-channel sample count.
   */
  decode(frame) {
    if (!Buffer.isBuffer(frame) && !(frame instanceof Uint8Array)) {
      throw new Error('ALAC frame must be a Buffer or Uint8Array');
    }
    const { frameLength, bitDepth, channels } = this.#config;
    const reader = new BitReader(frame);
    const pcm = new Int16Array(frameLength * channels);
    let channelIndex = 0;
    let numSamples = frameLength;

    for (;;) {
      const tag = reader.read(3);
      if (tag === ID_END) break;
      switch (tag) {
        case ID_SCE:
        case ID_LFE: {
          if (channelIndex + 1 > channels) throw new Error('ALAC frame has too many channels');
          numSamples = this.#decodeElement(reader, pcm, channelIndex, 1);
          channelIndex += 1;
          break;
        }
        case ID_CPE: {
          if (channelIndex + 2 > channels) throw new Error('ALAC frame has too many channels');
          numSamples = this.#decodeElement(reader, pcm, channelIndex, 2);
          channelIndex += 2;
          break;
        }
        case ID_DSE: {
          reader.read(4);
          const byteAlignFlag = reader.read(1);
          let count = reader.read(8);
          if (count === 255) count += reader.read(8);
          if (byteAlignFlag) reader.byteAlign();
          reader.advance(count * 8);
          break;
        }
        case ID_FIL: {
          let count = reader.read(4);
          if (count === 15) count += reader.read(8) - 1;
          reader.advance(count * 8);
          break;
        }
        default:
          throw new Error(`ALAC element ${tag === ID_CCE ? 'CCE' : 'PCE'} is not supported`);
      }
    }
    if (channelIndex < channels) throw new Error('ALAC frame is missing channels');

    const samples = numSamples === frameLength
      ? pcm
      : pcm.subarray(0, numSamples * channels);
    return { samples, sampleCount: numSamples, channels, bitDepth };
  }

  #decodeElement(reader, pcm, channelIndex, elementChannels) {
    const { frameLength, bitDepth, channels, pb, mb, kb } = this.#config;
    reader.read(4); // element instance tag
    if (reader.read(12) !== 0) throw new Error('ALAC element header is corrupt');
    const headerByte = reader.read(4);
    const partialFrame = headerByte >> 3;
    const bytesShifted = (headerByte >> 1) & 0x3;
    if (bytesShifted === 3) throw new Error('ALAC element uses an invalid shift');
    const escapeFlag = headerByte & 0x1;

    let numSamples = frameLength;
    if (partialFrame) {
      numSamples = reader.read(16) * 65536 + reader.read(16);
      if (numSamples > frameLength) throw new Error('ALAC partial frame is larger than frameLength');
    }

    let mixBits = 0;
    let mixRes = 0;
    if (!escapeFlag) {
      const chanBits = bitDepth - bytesShifted * 8 + (elementChannels - 1);
      mixBits = reader.read(8);
      mixRes = (reader.read(8) << 24) >> 24;

      const headers = [];
      for (let ch = 0; ch < elementChannels; ch++) {
        const modeByte = reader.read(8);
        const factorByte = reader.read(8);
        const header = {
          mode: modeByte >> 4,
          denShift: modeByte & 0xf,
          pbFactor: factorByte >> 5,
          num: factorByte & 0x1f,
          coefs: new Int16Array(32),
        };
        for (let i = 0; i < header.num; i++) {
          header.coefs[i] = (reader.read(16) << 16) >> 16;
        }
        headers.push(header);
      }

      if (bytesShifted !== 0) {
        // 16-bit streams never shift bytes off; the shift buffer only exists
        // for 24/32-bit sources, which constructor validation already rejects.
        reader.advance(bytesShifted * 8 * numSamples * elementChannels);
      }

      for (let ch = 0; ch < elementChannels; ch++) {
        const header = headers[ch];
        const agParams = {
          mb0: mb,
          pb: Math.floor((pb * header.pbFactor) / 4),
          kb,
          wb: (1 << kb) - 1,
        };
        dynDecomp(reader, this.#residuals, numSamples, chanBits, agParams);
        const mix = ch === 0 ? this.#mixU : this.#mixV;
        if (header.mode === 0) {
          unpcBlock(this.#residuals, mix, numSamples, header.coefs, header.num, chanBits, header.denShift);
        } else {
          // Fused mode: undo an extra first-order pass before the FIR filter.
          unpcBlock(this.#residuals, this.#residuals, numSamples, null, 31, chanBits, 0);
          unpcBlock(this.#residuals, mix, numSamples, header.coefs, header.num, chanBits, header.denShift);
        }
      }
    } else {
      // Verbatim (escape) frame: raw sign-extended samples.
      const chanBits = bitDepth;
      const shift = 32 - chanBits;
      for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < elementChannels; ch++) {
          const mix = ch === 0 ? this.#mixU : this.#mixV;
          mix[i] = (reader.read(chanBits) << shift) >> shift;
        }
      }
      mixBits = 0;
      mixRes = 0;
    }

    if (elementChannels === 2) {
      unmix16(this.#mixU, this.#mixV, pcm, channelIndex, channels, numSamples, mixBits, mixRes);
    } else {
      for (let i = 0, j = channelIndex; i < numSamples; i++, j += channels) {
        pcm[j] = this.#mixU[i];
      }
    }
    return numSamples;
  }
}

/** Build an AlacDecoder from a parsed RAOP announce (`announce.alac` fmtp). */
export function alacDecoderFromAnnounce(announce) {
  const alac = announce?.alac;
  if (!alac) throw new Error('announce does not carry ALAC fmtp parameters');
  return new AlacDecoder({
    frameLength: alac.frameLength,
    bitDepth: alac.bitDepth,
    pb: alac.pb,
    mb: alac.mb,
    kb: alac.kb,
    channels: alac.channels,
    sampleRate: alac.sampleRate,
  });
}
