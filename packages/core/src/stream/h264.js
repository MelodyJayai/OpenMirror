// H.264 handling for the AirPlay mirroring stream.
//
// Mirror frame payload types (header uint16 at offset 4):
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
};

const START_CODE = Buffer.from([0, 0, 0, 1]);

export const NAL_TYPE = {
  SLICE: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
};

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
  return { profile, compat, level, nalLengthSize, sps, pps };
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
  codec = null;

  constructor({ onCodec, onVideo } = {}) {
    this.#onCodec = onCodec ?? (() => {});
    this.#onVideo = onVideo ?? (() => {});
  }

  push({ type, payload, timestamp }) {
    switch (type) {
      case MIRROR_PAYLOAD.CODEC: {
        const avcC = parseAvcC(payload);
        this.codec = avcC;
        this.#nalLengthSize = avcC.nalLengthSize;
        this.#onCodec({ ...avcC, annexB: parameterSetsToAnnexB(avcC), timestamp });
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
