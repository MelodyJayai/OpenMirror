// AirPlay timing channel (NTP-style clock sync over UDP).
//
// The sender periodically probes the receiver's clock so it can schedule
// audio/video presentation. Packets are 32 bytes, RTP-flavored:
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
  return Number(seconds) * 1000 + Number((fraction * 1000n) >> 32n);
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
