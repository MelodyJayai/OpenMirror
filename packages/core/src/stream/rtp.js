// RTP depacketization for the AirPlay audio channel (RFC 3550 framing).
//
// Mirror-session audio arrives as AAC-ELD in RTP over UDP; RAOP (audio-only)
// uses ALAC or AAC-LC with the same framing. Payload types seen in practice:
//   0x60 (96) — audio data
//   0x56 (86) — audio retransmission (wraps another complete RTP packet)
//   0x54 (84) — sync
//   0x55 (85) — retransmit request

export const RTP_HEADER_BYTES = 12;
export const AUDIO_SYNC_PACKET_BYTES = 20;
export const AUDIO_RETRANSMIT_REQUEST_BYTES = 8;

export const AUDIO_PAYLOAD = {
  DATA: 0x60,
  SYNC: 0x54,
  RETRANSMIT_REQUEST: 0x55,
  RETRANSMITTED: 0x56,
};

/** Build the 8-byte AirPlay/RAOP request for one contiguous missing RTP range. */
export function buildAudioRetransmitRequest({
  requestSequence = 0,
  sequence,
  count = 1,
} = {}) {
  for (const [name, value] of Object.entries({ requestSequence, sequence, count })) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`${name} must be a 16-bit unsigned integer`);
    }
  }
  if (count < 1) throw new Error('retransmit count must be at least 1');
  const packet = Buffer.alloc(AUDIO_RETRANSMIT_REQUEST_BYTES);
  packet[0] = 0x80;
  packet[1] = 0x80 | AUDIO_PAYLOAD.RETRANSMIT_REQUEST;
  packet.writeUInt16BE(requestSequence, 2);
  packet.writeUInt16BE(sequence, 4);
  packet.writeUInt16BE(count, 6);
  return packet;
}

/** Parse an AirPlay/RAOP 0x55 retransmission request. */
export function parseAudioRetransmitRequest(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== AUDIO_RETRANSMIT_REQUEST_BYTES) {
    throw new Error(`audio retransmit request must be ${AUDIO_RETRANSMIT_REQUEST_BYTES} bytes`);
  }
  const version = buf[0] >> 6;
  const payloadType = buf[1] & 0x7f;
  if (version !== 2 || payloadType !== AUDIO_PAYLOAD.RETRANSMIT_REQUEST) {
    throw new Error(`not an audio retransmit request (version=${version}, type=${payloadType})`);
  }
  const count = buf.readUInt16BE(6);
  if (count < 1) throw new Error('audio retransmit request count must be at least 1');
  return {
    version,
    marker: Boolean(buf[1] & 0x80),
    payloadType,
    requestSequence: buf.readUInt16BE(2),
    sequence: buf.readUInt16BE(4),
    count,
  };
}

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
 * Parse an AirPlay/RAOP 0x56 response. Its four-byte control header is
 * followed by the original complete RTP packet.
 */
export function parseRetransmittedAudioPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + RTP_HEADER_BYTES) {
    throw new Error(`retransmitted audio packet must be at least ${4 + RTP_HEADER_BYTES} bytes`);
  }
  const version = buf[0] >> 6;
  const payloadType = buf[1] & 0x7f;
  if (version !== 2 || payloadType !== AUDIO_PAYLOAD.RETRANSMITTED) {
    throw new Error(`not a retransmitted audio packet (version=${version}, type=${payloadType})`);
  }
  const packet = parseRtpPacket(buf.subarray(4));
  if (packet.payloadType !== AUDIO_PAYLOAD.DATA) {
    throw new Error(`retransmitted inner RTP type must be ${AUDIO_PAYLOAD.DATA}`);
  }
  return {
    ...packet,
    retransmitted: true,
    retransmitSequence: buf.readUInt16BE(2),
  };
}

/**
 * Reorders out-of-order RTP audio packets and emits them sequentially.
 *
 * Missing ranges trigger bounded retransmit-request events. Requests are
 * retried only as more data arrives, so a stopped/locked stream does not
 * create a background request storm. Large sequence discontinuities resync
 * immediately instead of leaving the audio pipeline waiting forever.
 */
export class RtpSequencer {
  #onPacket;
  #onEvent;
  #depth;
  #maxGapDistance;
  #retransmitIntervalPackets;
  #maxRetransmitAttempts;
  #maxRetransmitBatch;
  #next = null;
  #pending = new Map();
  #missing = new Map();
  #stats = RtpSequencer.#emptyStats();

  constructor(onPacket, {
    depth = 64,
    maxGapDistance = depth * 4,
    retransmitIntervalPackets = 8,
    maxRetransmitAttempts = 3,
    maxRetransmitBatch = 32,
    onEvent,
  } = {}) {
    if (typeof onPacket !== 'function') throw new Error('RtpSequencer requires an onPacket callback');
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error('RtpSequencer depth must be a positive integer');
    }
    if (!Number.isInteger(maxGapDistance) || maxGapDistance < depth) {
      throw new Error('RtpSequencer maxGapDistance must be an integer at least as large as depth');
    }
    if (!Number.isInteger(retransmitIntervalPackets) || retransmitIntervalPackets < 1) {
      throw new Error('RtpSequencer retransmitIntervalPackets must be a positive integer');
    }
    if (!Number.isInteger(maxRetransmitAttempts) || maxRetransmitAttempts < 1) {
      throw new Error('RtpSequencer maxRetransmitAttempts must be a positive integer');
    }
    if (
      !Number.isInteger(maxRetransmitBatch)
      || maxRetransmitBatch < 1
      || maxRetransmitBatch > 0xffff
    ) {
      throw new Error('RtpSequencer maxRetransmitBatch must be between 1 and 65535');
    }
    if (onEvent !== undefined && typeof onEvent !== 'function') {
      throw new Error('RtpSequencer onEvent must be a function');
    }
    this.#onPacket = onPacket;
    this.#onEvent = onEvent ?? (() => {});
    this.#depth = depth;
    this.#maxGapDistance = maxGapDistance;
    this.#retransmitIntervalPackets = retransmitIntervalPackets;
    this.#maxRetransmitAttempts = maxRetransmitAttempts;
    this.#maxRetransmitBatch = maxRetransmitBatch;
  }

  get stats() {
    return {
      ...this.#stats,
      pending: this.#pending.size,
      missing: this.#missing.size,
      nextSequence: this.#next,
    };
  }

  push(packet) {
    const seq = packet.sequence;
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
      throw new Error('RTP sequence must be a 16-bit unsigned integer');
    }
    this.#stats.received++;
    if (packet.retransmitted) this.#stats.retransmittedReceived++;
    if (this.#next === null) this.#next = seq;

    let distance = (seq - this.#next + 0x10000) & 0xffff;
    if (distance >= 0x8000) {
      this.#stats.late++;
      if (packet.retransmitted) this.#stats.retransmittedLate++;
      this.#emitEvent({ type: 'late', sequence: seq });
      return;
    }
    if (this.#pending.has(seq)) {
      this.#stats.duplicates++;
      if (packet.retransmitted) this.#stats.retransmittedDuplicates++;
      this.#emitEvent({ type: 'duplicate', sequence: seq });
      return;
    }

    if (distance > this.#maxGapDistance) {
      const skipped = distance;
      this.#stats.gapsSkipped += skipped;
      this.#stats.retransmitUnrecovered += skipped;
      this.#stats.discontinuities++;
      this.#pending.clear();
      this.#missing.clear();
      this.#next = seq;
      distance = 0;
      this.#emitEvent({ type: 'discontinuity', sequence: seq, skipped });
    }
    if (distance > 0) this.#stats.reordered++;

    const missing = this.#missing.get(seq);
    if (missing) {
      this.#missing.delete(seq);
      this.#stats.retransmitRecovered++;
      if (packet.retransmitted) this.#stats.retransmittedRecovered++;
      this.#emitEvent({
        type: 'recovered',
        sequence: seq,
        retransmitted: Boolean(packet.retransmitted),
        attempts: missing.attempts,
      });
    }

    this.#pending.set(seq, packet);
    this.#stats.maxPending = Math.max(this.#stats.maxPending, this.#pending.size);
    if (distance > 0) this.#trackMissingThrough(seq);
    this.#flush();
    this.#retryMissing();

    if (this.#pending.size > this.#depth) {
      const sorted = [...this.#pending.keys()]
        .sort((a, b) => (
          ((a - this.#next + 0x10000) & 0xffff)
          - ((b - this.#next + 0x10000) & 0xffff)
        ));
      const nextAvailable = sorted[0];
      const skipped = (nextAvailable - this.#next + 0x10000) & 0xffff;
      this.#stats.gapsSkipped += skipped;
      this.#stats.retransmitUnrecovered += skipped;
      this.#emitEvent({
        type: 'gap',
        fromSequence: this.#next,
        toSequence: nextAvailable,
        skipped,
      });
      for (let index = 0, sequence = this.#next; index < skipped; index++) {
        this.#missing.delete(sequence);
        sequence = (sequence + 1) & 0xffff;
      }
      this.#next = nextAvailable;
      this.#flush();
    }
  }

  reset({ resetStats = false } = {}) {
    const discarded = this.#pending.size;
    const missing = this.#missing.size;
    this.#pending.clear();
    this.#missing.clear();
    this.#next = null;
    if (resetStats) this.#stats = RtpSequencer.#emptyStats();
    this.#emitEvent({ type: 'reset', discarded, missing, resetStats });
  }

  #flush() {
    while (this.#pending.has(this.#next)) {
      const packet = this.#pending.get(this.#next);
      this.#pending.delete(this.#next);
      this.#missing.delete(this.#next);
      this.#onPacket(packet);
      this.#stats.emitted++;
      this.#next = (this.#next + 1) & 0xffff;
    }
  }

  #trackMissingThrough(lastSequence) {
    const added = [];
    for (
      let sequence = this.#next;
      sequence !== lastSequence;
      sequence = (sequence + 1) & 0xffff
    ) {
      if (this.#pending.has(sequence) || this.#missing.has(sequence)) continue;
      this.#missing.set(sequence, { attempts: 0, lastRequestAtReceived: -Infinity });
      added.push(sequence);
    }
    this.#requestMissing(added);
  }

  #retryMissing() {
    const retry = [];
    for (const [sequence, metadata] of this.#missing) {
      if (metadata.attempts >= this.#maxRetransmitAttempts) continue;
      if (
        this.#stats.received - metadata.lastRequestAtReceived
        < this.#retransmitIntervalPackets
      ) {
        continue;
      }
      retry.push(sequence);
    }
    this.#requestMissing(retry);
  }

  #requestMissing(sequences) {
    if (!sequences.length) return;
    sequences.sort(
      (a, b) => (
        ((a - this.#next + 0x10000) & 0xffff)
        - ((b - this.#next + 0x10000) & 0xffff)
      ),
    );
    for (let index = 0; index < sequences.length;) {
      const first = sequences[index];
      const metadata = this.#missing.get(first);
      if (!metadata || metadata.attempts >= this.#maxRetransmitAttempts) {
        index++;
        continue;
      }
      const attempt = metadata.attempts + 1;
      let count = 1;
      while (
        count < this.#maxRetransmitBatch
        && index + count < sequences.length
        && sequences[index + count] === ((first + count) & 0xffff)
        && this.#missing.get(sequences[index + count])?.attempts + 1 === attempt
      ) {
        count++;
      }
      for (let offset = 0; offset < count; offset++) {
        const entry = this.#missing.get((first + offset) & 0xffff);
        entry.attempts = attempt;
        entry.lastRequestAtReceived = this.#stats.received;
      }
      this.#stats.retransmitRequests++;
      this.#stats.retransmitPacketsRequested += count;
      this.#emitEvent({
        type: 'retransmit-request',
        sequence: first,
        count,
        attempt,
      });
      index += count;
    }
  }

  #emitEvent(event) {
    this.#onEvent({ ...event, stats: this.stats });
  }

  static #emptyStats() {
    return {
      received: 0,
      emitted: 0,
      late: 0,
      duplicates: 0,
      reordered: 0,
      gapsSkipped: 0,
      maxPending: 0,
      discontinuities: 0,
      retransmitRequests: 0,
      retransmitPacketsRequested: 0,
      retransmitRecovered: 0,
      retransmitUnrecovered: 0,
      retransmittedReceived: 0,
      retransmittedRecovered: 0,
      retransmittedLate: 0,
      retransmittedDuplicates: 0,
    };
  }
}
