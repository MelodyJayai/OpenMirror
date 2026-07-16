// AirPlay timing channel (NTP-style clock sync over UDP).
//
// The receiver periodically probes the sender's clock so it can map the
// sender's boot-relative media timestamps onto the local wall clock. Packets
// are 32 bytes, RTP-flavored:
//
//   byte 0      0x80                    (RTP version 2)
//   byte 1      0xd2 = timing request / 0xd3 = timing reply (marker | PT)
//   bytes 2-3   sequence (big-endian; echoed in the reply)
//   bytes 4-7   zero
//   bytes 8-15  origin   timestamp  (NTP 64-bit)
//   bytes 16-23 receive  timestamp
//   bytes 24-31 transmit timestamp
//
// Reply semantics (like SNTP): origin ← request.transmit, receive ← time the
// request arrived, transmit ← time the reply leaves. NTP timestamps count
// seconds since 1900-01-01 as a 32.32 fixed-point big-endian value.

export const TIMING_PACKET_BYTES = 32;
export const TIMING_REQUEST = 0xd2;
export const TIMING_REPLY = 0xd3;

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
export const NTP_UNIX_OFFSET_SECONDS = 2208988800n;

/** Current time as a 64-bit NTP timestamp (BigInt: high 32 = seconds, low 32 = fraction). */
export function ntpNow(nowMs = Date.now()) {
  const ms = BigInt(Math.floor(nowMs));
  const seconds = ms / 1000n + NTP_UNIX_OFFSET_SECONDS;
  const fraction = ((ms % 1000n) * (1n << 32n)) / 1000n;
  return (seconds << 32n) | fraction;
}

/** Convert a 64-bit NTP timestamp back to Unix milliseconds (Number). */
export function ntpToUnixMs(ntp) {
  const seconds = (ntp >> 32n) - NTP_UNIX_OFFSET_SECONDS;
  const fraction = ntp & 0xffffffffn;
  return Number(seconds) * 1000 + Number(fraction) * 1000 / 0x100000000;
}

/** Convert NTP 32.32 fixed point to milliseconds without applying an epoch. */
export function ntpFixedToMs(ntp) {
  if (typeof ntp !== 'bigint') throw new Error('NTP timestamp must be a BigInt');
  const seconds = ntp >> 32n;
  const fraction = ntp & 0xffffffffn;
  return Number(seconds) * 1000 + Number(fraction) * 1000 / 0x100000000;
}

/** Decode a 32-byte timing packet into its fields. */
export function decodeTimingPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== TIMING_PACKET_BYTES) {
    throw new Error(`timing packet must be ${TIMING_PACKET_BYTES} bytes, got ${buf?.length}`);
  }
  return {
    version: buf[0] >> 6,
    type: buf[1],
    sequence: buf.readUInt16BE(2),
    origin: buf.readBigUInt64BE(8),
    receive: buf.readBigUInt64BE(16),
    transmit: buf.readBigUInt64BE(24),
  };
}

/** Encode a timing packet from fields. */
export function encodeTimingPacket({ type, sequence = 0, origin = 0n, receive = 0n, transmit = 0n }) {
  const buf = Buffer.alloc(TIMING_PACKET_BYTES);
  buf[0] = 0x80;
  buf[1] = type;
  buf.writeUInt16BE(sequence & 0xffff, 2);
  buf.writeBigUInt64BE(BigInt(origin), 8);
  buf.writeBigUInt64BE(BigInt(receive), 16);
  buf.writeBigUInt64BE(BigInt(transmit), 24);
  return buf;
}

/**
 * Build the reply for an incoming timing request, or null if the datagram is
 * not a timing request (multicast/UDP ports see stray traffic).
 * `clock` is injectable for tests.
 */
export function buildTimingReply(requestBuf, clock = ntpNow) {
  if (!Buffer.isBuffer(requestBuf) || requestBuf.length !== TIMING_PACKET_BYTES) return null;
  const request = decodeTimingPacket(requestBuf);
  if (request.version !== 2 || request.type !== TIMING_REQUEST) return null;
  const now = clock();
  return encodeTimingPacket({
    type: TIMING_REPLY,
    sequence: request.sequence,
    origin: request.transmit, // per SNTP: our origin = sender's transmit
    receive: now,
    transmit: clock(),
  });
}

/** Build one receiver-to-sender AirPlay timing request. */
export function buildTimingRequest(sequence = 0, clock = ntpNow) {
  return encodeTimingPacket({
    type: TIMING_REQUEST,
    sequence,
    transmit: clock(),
  });
}

/**
 * Calculate the standard NTP remote-minus-local clock offset from a sender
 * reply. Sender timestamps intentionally use its boot-relative clock while
 * retaining NTP's epoch bias, so ntpToUnixMs() yields remote monotonic ms.
 */
export function timingReplySample(replyOrBuffer, receivedAtNtp = ntpNow()) {
  const reply = Buffer.isBuffer(replyOrBuffer) ? decodeTimingPacket(replyOrBuffer) : replyOrBuffer;
  if (!reply || reply.version !== 2 || reply.type !== TIMING_REPLY) {
    throw new Error('not an AirPlay timing reply');
  }
  if (typeof receivedAtNtp !== 'bigint') throw new Error('receivedAtNtp must be a BigInt');
  const localSendMs = ntpToUnixMs(reply.origin);
  const remoteReceiveMs = ntpToUnixMs(reply.receive);
  const remoteTransmitMs = ntpToUnixMs(reply.transmit);
  const localReceiveMs = ntpToUnixMs(receivedAtNtp);
  return {
    ...reply,
    receivedAtNtp,
    localSendMs,
    remoteReceiveMs,
    remoteTransmitMs,
    localReceiveMs,
    offsetMs: ((remoteReceiveMs - localSendMs) + (remoteTransmitMs - localReceiveMs)) / 2,
    roundTripMs: (localReceiveMs - localSendMs) - (remoteTransmitMs - remoteReceiveMs),
  };
}

/** Signed distance between two wrapping 32-bit RTP timestamps. */
export function signedRtpDelta(timestamp, anchor) {
  const delta = (Number(timestamp) - Number(anchor)) >>> 0;
  return delta > 0x7fffffff ? delta - 0x100000000 : delta;
}

/** Add a signed number of sample ticks to an NTP 32.32 timestamp. */
export function addRtpTicksToNtp(ntp, ticks, sampleRate = 44100) {
  if (typeof ntp !== 'bigint') throw new Error('NTP timestamp must be a BigInt');
  if (!Number.isInteger(ticks)) throw new Error('RTP ticks must be an integer');
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('sampleRate must be positive');
  return ntp + (BigInt(ticks) * (1n << 32n)) / BigInt(sampleRate);
}

/**
 * Maps AirPlay's audio RTP clock and remote NTP timestamps onto the receiver's
 * wall clock. Sync packets establish the shared anchor; a small smoothed
 * offset and target latency turn jittery arrival times into presentation times.
 */
export class AirPlayMediaClock {
  #sampleRate;
  #targetLatencyMs;
  #smoothing;
  #clock;
  #audioAnchor = null;
  #timingOffsetMs = null;
  #fallbackRemoteToLocalMs = null;
  #bestRoundTripMs = Infinity;

  constructor({
    sampleRate = 44100,
    targetLatencyMs = 120,
    smoothing = 0.125,
    clock = Date.now,
  } = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('sampleRate must be positive');
    if (!Number.isFinite(targetLatencyMs) || targetLatencyMs < 0) {
      throw new Error('targetLatencyMs must be non-negative');
    }
    if (!Number.isFinite(smoothing) || smoothing <= 0 || smoothing > 1) {
      throw new Error('smoothing must be in (0, 1]');
    }
    if (typeof clock !== 'function') throw new Error('clock must be a function');
    this.#sampleRate = sampleRate;
    this.#targetLatencyMs = targetLatencyMs;
    this.#smoothing = smoothing;
    this.#clock = clock;
  }

  get synchronized() {
    return this.#timingOffsetMs !== null || this.#fallbackRemoteToLocalMs !== null;
  }

  get source() {
    if (this.#timingOffsetMs !== null) return 'ntp';
    if (this.#fallbackRemoteToLocalMs !== null) return 'arrival';
    return null;
  }

  updateTimingReply(replyOrSample, receivedAtNtp = ntpNow()) {
    const sample = replyOrSample?.offsetMs === undefined
      ? timingReplySample(replyOrSample, receivedAtNtp)
      : replyOrSample;
    if (!Number.isFinite(sample.offsetMs) || !Number.isFinite(sample.roundTripMs)
      || sample.roundTripMs < -1 || sample.roundTripMs > 10000) {
      throw new Error('invalid timing sample');
    }
    this.#bestRoundTripMs = Math.min(this.#bestRoundTripMs, sample.roundTripMs);
    if (sample.roundTripMs > this.#bestRoundTripMs + 20) {
      return {
        source: 'ntp',
        offsetMs: this.#timingOffsetMs,
        roundTripMs: sample.roundTripMs,
        ignored: true,
      };
    }
    this.#timingOffsetMs = this.#timingOffsetMs === null
      ? sample.offsetMs
      : this.#timingOffsetMs + (sample.offsetMs - this.#timingOffsetMs) * this.#smoothing;
    return {
      source: 'ntp',
      offsetMs: this.#timingOffsetMs,
      roundTripMs: sample.roundTripMs,
    };
  }

  updateAudioSync({ rtpTimestamp, remoteNtp, nextRtpTimestamp = rtpTimestamp, receivedAtMs = this.#clock() }) {
    if (!Number.isInteger(rtpTimestamp) || rtpTimestamp < 0 || rtpTimestamp > 0xffffffff) {
      throw new Error('rtpTimestamp must be a 32-bit unsigned integer');
    }
    if (!Number.isInteger(nextRtpTimestamp) || nextRtpTimestamp < 0 || nextRtpTimestamp > 0xffffffff) {
      throw new Error('nextRtpTimestamp must be a 32-bit unsigned integer');
    }
    if (typeof remoteNtp !== 'bigint') throw new Error('remoteNtp must be a BigInt');
    if (!Number.isFinite(receivedAtMs)) throw new Error('receivedAtMs must be finite');

    this.#audioAnchor = { rtpTimestamp, remoteNtp };
    const observedRemoteToLocal = receivedAtMs - ntpToUnixMs(remoteNtp);
    this.#fallbackRemoteToLocalMs = this.#fallbackRemoteToLocalMs === null
      ? observedRemoteToLocal
      : this.#fallbackRemoteToLocalMs
        + (observedRemoteToLocal - this.#fallbackRemoteToLocalMs) * this.#smoothing;
    return this.mapAudio(rtpTimestamp, receivedAtMs);
  }

  mapAudio(rtpTimestamp, nowMs = this.#clock()) {
    if (!this.#audioAnchor || !this.synchronized) return null;
    const ticks = signedRtpDelta(rtpTimestamp, this.#audioAnchor.rtpTimestamp);
    const remoteNtp = addRtpTicksToNtp(this.#audioAnchor.remoteNtp, ticks, this.#sampleRate);
    return this.#mapRemoteMs(ntpToUnixMs(remoteNtp), remoteNtp, nowMs);
  }

  mapRemoteNtp(remoteNtp, nowMs = this.#clock()) {
    if (typeof remoteNtp !== 'bigint' || remoteNtp === 0n) return null;
    return this.#mapRemoteMs(ntpToUnixMs(remoteNtp), remoteNtp, nowMs);
  }

  /** Mirror video timestamps are NTP fixed point without the 1900 epoch. */
  mapVideo(remoteTimestamp, nowMs = this.#clock()) {
    if (typeof remoteTimestamp !== 'bigint' || remoteTimestamp === 0n) return null;
    return this.#mapRemoteMs(ntpFixedToMs(remoteTimestamp), remoteTimestamp, nowMs);
  }

  #mapRemoteMs(remoteTimeMs, remoteTimestamp, nowMs) {
    if (!this.synchronized) return null;
    const remoteToLocalMs = this.#timingOffsetMs === null
      ? this.#fallbackRemoteToLocalMs
      : -this.#timingOffsetMs;
    const presentationTimeMs = remoteTimeMs + remoteToLocalMs + this.#targetLatencyMs;
    return {
      source: this.source,
      remoteTimestamp,
      remoteTimeMs,
      presentationTimeMs,
      delayMs: presentationTimeMs - nowMs,
    };
  }
}
