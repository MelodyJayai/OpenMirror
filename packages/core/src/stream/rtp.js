// RTP depacketization for the AirPlay audio channel (RFC 3550 framing).
//
// Mirror-session audio arrives as AAC-ELD in RTP over UDP; RAOP (audio-only)
// uses ALAC or AAC-LC with the same framing. Payload types seen in practice:
//   0x60 (96)  — audio data
//   0x56 (86)  — audio retransmission (RAOP resend, wraps another RTP packet)
//   0x54 (84)  — sync
//   0x55 (85)  — retransmit request

export const RTP_HEADER_BYTES = 12;
export const AUDIO_SYNC_PACKET_BYTES = 20;

export const AUDIO_PAYLOAD = {
  DATA: 0x60,
  SYNC: 0x54,
  RETRANSMIT_REQUEST: 0x55,
  RETRANSMITTED: 0x56,
};

/** Parse the 20-byte AirPlay audio control-channel RTP↔NTP anchor. */
export function parseAudioSyncPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < AUDIO_SYNC_PACKET_BYTES) {
    throw new Error(`audio sync packet must be at least ${AUDIO_SYNC_PACKET_BYTES} bytes`);
  }
  const version = buf[0] >> 6;
  const payloadType = buf[1] & 0x7f;
  if (version !== 2 || payloadType !== AUDIO_PAYLOAD.SYNC) {
    throw new Error(`not an AirPlay audio sync packet (version=${version}, type=${payloadType})`);
  }
  return {
    version,
    first: Boolean(buf[0] & 0x10),
    sequence: buf.readUInt16BE(2),
    rtpTimestamp: buf.readUInt32BE(4),
    remoteNtp: buf.readBigUInt64BE(8),
    nextRtpTimestamp: buf.readUInt32BE(16),
  };
}

/**
 * Parse one RTP datagram. Returns:
 * { version, padding, extension, csrcCount, marker, payloadType,
 *   sequence, timestamp, ssrc, payload }
 */
export function parseRtpPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < RTP_HEADER_BYTES) {
    throw new Error(`RTP packet too short: ${buf?.length} bytes`);
  }
  const version = buf[0] >> 6;
  if (version !== 2) throw new Error(`Unsupported RTP version ${version}`);
  const padding = Boolean(buf[0] & 0x20);
  const extension = Boolean(buf[0] & 0x10);
  const csrcCount = buf[0] & 0x0f;
  const marker = Boolean(buf[1] & 0x80);
  const payloadType = buf[1] & 0x7f;
  const sequence = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let offset = RTP_HEADER_BYTES + csrcCount * 4;
  if (extension) {
    if (buf.length < offset + 4) throw new Error('RTP extension header truncated');
    const extWords = buf.readUInt16BE(offset + 2);
    offset += 4 + extWords * 4;
  }
  if (buf.length < offset) throw new Error('RTP packet shorter than its headers');

  let end = buf.length;
  if (padding && end > offset) {
    const padBytes = buf[end - 1];
    if (padBytes === 0 || end - padBytes < offset) throw new Error('Invalid RTP padding');
    end -= padBytes;
  }

  return {
    version, padding, extension, csrcCount, marker, payloadType,
    sequence, timestamp, ssrc,
    payload: Buffer.from(buf.subarray(offset, end)),
  };
}

/**
 * Reorders out-of-order RTP audio packets and emits them sequentially.
 * Small jitter buffer keyed by sequence number with wraparound handling;
 * packets more than `depth` behind the emitted head are dropped as late.
 */
export class RtpSequencer {
  #onPacket;
  #depth;
  #next = null;              // next expected sequence number
  #pending = new Map();      // seq → packet

  constructor(onPacket, { depth = 64 } = {}) {
    if (typeof onPacket !== 'function') throw new Error('RtpSequencer requires an onPacket callback');
    if (!Number.isInteger(depth) || depth < 1) throw new Error('RtpSequencer depth must be a positive integer');
    this.#onPacket = onPacket;
    this.#depth = depth;
  }

  push(packet) {
    const seq = packet.sequence;
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
      throw new Error('RTP sequence must be a 16-bit unsigned integer');
    }
    if (this.#next === null) this.#next = seq;

    const distance = (seq - this.#next + 0x10000) & 0xffff;
    if (distance >= 0x8000) return; // older than the head: late duplicate, drop

    this.#pending.set(seq, packet);
    this.#flush();

    // Bound the buffer: if the gap never fills, skip ahead.
    if (this.#pending.size > this.#depth) {
      const sorted = [...this.#pending.keys()]
        .sort((a, b) => ((a - this.#next + 0x10000) & 0xffff) - ((b - this.#next + 0x10000) & 0xffff));
      this.#next = sorted[0];
      this.#flush();
    }
  }

  #flush() {
    while (this.#pending.has(this.#next)) {
      const packet = this.#pending.get(this.#next);
      this.#pending.delete(this.#next);
      this.#onPacket(packet);
      this.#next = (this.#next + 1) & 0xffff;
    }
  }
}
