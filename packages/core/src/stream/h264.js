// H.264 handling for the AirPlay mirroring stream.
//
// Mirror frame payload types (header byte at offset 4; byte 5 carries flags):
//   0 — video bitstream: AVCC framing, i.e. length-prefixed NAL units
//       (4-byte big-endian lengths), possibly AES-CTR encrypted
//   1 — codec data: an AVCDecoderConfigurationRecord (avcC) carrying SPS/PPS;
//       always sent in the clear, re-sent on orientation/resolution changes
//   2 — heartbeat: empty keep-alive
//   4 — time/synchronization data
//
// Decoders (ffmpeg/WebCodecs-AnnexB) want Annex-B byte streams, so this module
// converts AVCC → Annex-B and extracts parameter sets from avcC records.

export const MIRROR_PAYLOAD = {
  VIDEO: 0,
  CODEC: 1,
  HEARTBEAT: 2,
  TIME: 4,
  REPORT: 5,
};

export const MIRROR_VIDEO_OPTION = {
  H264_STREAMING: 0x16,
  H264_SUSPENDED: 0x56,
  H265_STREAMING: 0x1e,
  H265_SUSPENDED: 0x5e,
};

export function isMirrorVideoSuspended(payloadOption = 0) {
  const option = payloadOption & 0xff;
  return option === MIRROR_VIDEO_OPTION.H264_SUSPENDED
    || option === MIRROR_VIDEO_OPTION.H265_SUSPENDED;
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

export const NAL_TYPE = {
  SLICE: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
};

class BitReader {
  #buffer;
  #bitOffset = 0;

  constructor(buffer) {
    this.#buffer = buffer;
  }

  readBit() {
    if (this.#bitOffset >= this.#buffer.length * 8) throw new Error('SPS bitstream truncated');
    const byte = this.#buffer[this.#bitOffset >> 3];
    const value = (byte >> (7 - (this.#bitOffset & 7))) & 1;
    this.#bitOffset++;
    return value;
  }

  readBits(count) {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new Error('invalid SPS bit count');
    }
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.readBit();
    return value;
  }

  readUnsignedExpGolomb() {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) throw new Error('invalid SPS Exp-Golomb value');
    }
    if (leadingZeros === 0) return 0;
    return 2 ** leadingZeros - 1 + this.readBits(leadingZeros);
  }

  readSignedExpGolomb() {
    const code = this.readUnsignedExpGolomb();
    return code & 1 ? (code + 1) / 2 : -(code / 2);
  }
}

function removeEmulationPreventionBytes(buffer) {
  const output = [];
  for (let i = 0; i < buffer.length; i++) {
    if (i >= 2 && buffer[i] === 0x03 && buffer[i - 1] === 0x00 && buffer[i - 2] === 0x00) {
      continue;
    }
    output.push(buffer[i]);
  }
  return Buffer.from(output);
}

function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index++) {
    if (nextScale !== 0) {
      nextScale = (lastScale + reader.readSignedExpGolomb() + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function dimensionsDiffer(previous, current) {
  if (!previous || !current) return Boolean(previous || current);
  return previous.width !== current.width || previous.height !== current.height;
}

function displayDimensionsDiffer(previous, current) {
  if (!previous || !current) return Boolean(previous || current);
  return dimensionsDiffer(previous.source, current.source)
    || dimensionsDiffer(previous.encoded, current.encoded);
}

/**
 * Parse the coded and cropped dimensions from a sequence parameter set NAL.
 * The result describes the encoded orientation; it does not infer device UI
 * rotation beyond the width/height change signalled by the sender.
 */
export function parseSpsDimensions(sps) {
  if (!Buffer.isBuffer(sps) || sps.length < 4 || (sps[0] & 0x1f) !== NAL_TYPE.SPS) {
    throw new Error('Not an H.264 SPS NAL unit');
  }

  const reader = new BitReader(removeEmulationPreventionBytes(sps.subarray(1)));
  const profile = reader.readBits(8);
  reader.readBits(8); // constraint flags and reserved bits
  reader.readBits(8); // level_idc
  reader.readUnsignedExpGolomb(); // seq_parameter_set_id

  let chromaFormat = 1;
  let separateColourPlane = 0;
  const highProfiles = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244]);
  if (highProfiles.has(profile)) {
    chromaFormat = reader.readUnsignedExpGolomb();
    if (chromaFormat > 3) throw new Error(`Unsupported SPS chroma format ${chromaFormat}`);
    if (chromaFormat === 3) separateColourPlane = reader.readBit();
    reader.readUnsignedExpGolomb(); // bit_depth_luma_minus8
    reader.readUnsignedExpGolomb(); // bit_depth_chroma_minus8
    reader.readBit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.readBit()) {
      const scalingListCount = chromaFormat === 3 ? 12 : 8;
      for (let index = 0; index < scalingListCount; index++) {
        if (reader.readBit()) skipScalingList(reader, index < 6 ? 16 : 64);
      }
    }
  }

  reader.readUnsignedExpGolomb(); // log2_max_frame_num_minus4
  const pictureOrderCountType = reader.readUnsignedExpGolomb();
  if (pictureOrderCountType === 0) {
    reader.readUnsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pictureOrderCountType === 1) {
    reader.readBit(); // delta_pic_order_always_zero_flag
    reader.readSignedExpGolomb(); // offset_for_non_ref_pic
    reader.readSignedExpGolomb(); // offset_for_top_to_bottom_field
    const referenceFrames = reader.readUnsignedExpGolomb();
    for (let index = 0; index < referenceFrames; index++) reader.readSignedExpGolomb();
  }

  reader.readUnsignedExpGolomb(); // max_num_ref_frames
  reader.readBit(); // gaps_in_frame_num_value_allowed_flag
  const widthInMacroblocks = reader.readUnsignedExpGolomb() + 1;
  const heightInMapUnits = reader.readUnsignedExpGolomb() + 1;
  const frameMbsOnly = reader.readBit();
  if (!frameMbsOnly) reader.readBit(); // mb_adaptive_frame_field_flag
  reader.readBit(); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.readBit()) {
    cropLeft = reader.readUnsignedExpGolomb();
    cropRight = reader.readUnsignedExpGolomb();
    cropTop = reader.readUnsignedExpGolomb();
    cropBottom = reader.readUnsignedExpGolomb();
  }

  const codedWidth = widthInMacroblocks * 16;
  const codedHeight = (2 - frameMbsOnly) * heightInMapUnits * 16;
  const chromaArrayType = separateColourPlane ? 0 : chromaFormat;
  const subWidth = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
  const subHeight = chromaArrayType === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidth;
  const cropUnitY = chromaArrayType === 0 ? 2 - frameMbsOnly : subHeight * (2 - frameMbsOnly);
  const width = codedWidth - (cropLeft + cropRight) * cropUnitX;
  const height = codedHeight - (cropTop + cropBottom) * cropUnitY;
  if (width <= 0 || height <= 0) throw new Error('SPS contains invalid cropped dimensions');

  return {
    width,
    height,
    codedWidth,
    codedHeight,
    orientation: width === height ? 'square' : width > height ? 'landscape' : 'portrait',
    interlaced: !frameMbsOnly,
  };
}

/**
 * Parse an AVCDecoderConfigurationRecord (ISO 14496-15 §5.2.4.1).
 * Returns { profile, compat, level, nalLengthSize, sps: Buffer[], pps: Buffer[] }.
 */
export function parseAvcC(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 7 || buf[0] !== 1) {
    throw new Error('Not an avcC record (configurationVersion must be 1)');
  }
  const profile = buf[1];
  const compat = buf[2];
  const level = buf[3];
  const nalLengthSize = (buf[4] & 0x03) + 1;

  let pos = 5;
  const readSets = (count) => {
    const sets = [];
    for (let i = 0; i < count; i++) {
      if (pos + 2 > buf.length) throw new Error('avcC truncated');
      const len = buf.readUInt16BE(pos);
      pos += 2;
      if (pos + len > buf.length) throw new Error('avcC parameter set overruns record');
      sets.push(Buffer.from(buf.subarray(pos, pos + len)));
      pos += len;
    }
    return sets;
  };

  const sps = readSets(buf[pos++] & 0x1f);
  if (pos >= buf.length) throw new Error('avcC truncated before PPS count');
  const pps = readSets(buf[pos++]);
  let dimensions = null;
  try {
    dimensions = sps.length ? parseSpsDimensions(sps[0]) : null;
  } catch {
    // Parameter-set extraction must remain usable for truncated/novel SPS data.
  }
  return { profile, compat, level, nalLengthSize, sps, pps, dimensions };
}

/** Render an avcC's parameter sets as an Annex-B byte stream (SPS then PPS). */
export function parameterSetsToAnnexB({ sps, pps }) {
  const parts = [];
  for (const nal of [...sps, ...pps]) parts.push(START_CODE, nal);
  return Buffer.concat(parts);
}

/**
 * Convert AVCC (length-prefixed) NAL units to an Annex-B byte stream.
 * Returns { annexB, nalTypes } where nalTypes lists each NAL's type for
 * keyframe detection (5 = IDR).
 */
export function avccToAnnexB(payload, nalLengthSize = 4) {
  if (!Buffer.isBuffer(payload)) throw new Error('AVCC payload must be a Buffer');
  if (!Number.isInteger(nalLengthSize) || nalLengthSize < 1 || nalLengthSize > 4) {
    throw new Error('AVCC NAL length size must be between 1 and 4 bytes');
  }
  const parts = [];
  const nalTypes = [];
  let pos = 0;
  while (pos + nalLengthSize <= payload.length) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = len * 256 + payload[pos + i];
    pos += nalLengthSize;
    if (len === 0) continue;
    if (pos + len > payload.length) {
      throw new Error(`AVCC NAL overruns payload (${len} bytes at offset ${pos})`);
    }
    const nal = payload.subarray(pos, pos + len);
    nalTypes.push(nal[0] & 0x1f);
    parts.push(START_CODE, nal);
    pos += len;
  }
  if (pos !== payload.length) {
    throw new Error(`AVCC payload has ${payload.length - pos} trailing length byte(s)`);
  }
  return { annexB: Buffer.concat(parts), nalTypes };
}

/** True if the NAL type list contains an IDR slice (keyframe). */
export function hasKeyframe(nalTypes) {
  return nalTypes.includes(NAL_TYPE.IDR);
}

/**
 * Stateful processor turning raw mirror frames into decoder-ready events.
 * Feed it { type, payload, timestamp } (from MirrorFrameParser, after any
 * decryption) and it emits via the callbacks:
 *   onCodec({ avcC, annexB, ... })   — new SPS/PPS (send to decoder as config)
 *   onVideo({ annexB, nalTypes, keyframe, timestamp }) — one access unit
 */
export class H264StreamProcessor {
  #onCodec;
  #onVideo;
  #nalLengthSize = 4;
  #codecRevision = 0;
  codec = null;

  constructor({ onCodec, onVideo } = {}) {
    this.#onCodec = onCodec ?? (() => {});
    this.#onVideo = onVideo ?? (() => {});
  }

  push({
    type,
    payload,
    timestamp,
    payloadFlags = 0,
    payloadOption = 0,
    displayDimensions = null,
  }) {
    switch (type) {
      case MIRROR_PAYLOAD.CODEC: {
        const avcC = parseAvcC(payload);
        const previousCodec = this.codec;
        const previousDimensions = previousCodec?.dimensions ?? null;
        const previousDisplayDimensions = previousCodec?.displayDimensions ?? null;
        this.codec = { ...avcC, displayDimensions };
        this.#nalLengthSize = avcC.nalLengthSize;
        this.#codecRevision++;
        const dimensionsChanged = Boolean(
          previousCodec
          && (
            dimensionsDiffer(previousDimensions, avcC.dimensions)
            || displayDimensionsDiffer(previousDisplayDimensions, displayDimensions)
          ),
        );
        this.#onCodec({
          ...this.codec,
          annexB: parameterSetsToAnnexB(avcC),
          timestamp,
          payloadFlags,
          payloadOption,
          revision: this.#codecRevision,
          dimensionsChanged,
          previousDimensions,
          previousDisplayDimensions,
        });
        return;
      }
      case MIRROR_PAYLOAD.VIDEO: {
        const { annexB, nalTypes } = avccToAnnexB(payload, this.#nalLengthSize);
        this.#onVideo({ annexB, nalTypes, keyframe: hasKeyframe(nalTypes), timestamp });
        return;
      }
      default:
        // Heartbeats and time data carry no bitstream.
        return;
    }
  }
}
