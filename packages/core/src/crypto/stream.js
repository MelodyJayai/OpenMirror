// Media-stream ciphers. Once fp-setup has yielded the session AES key (the
// FairPlay-decrypted `ekey` from SETUP), the actual per-stream ciphers are
// plain OpenSSL primitives:
//
//  • Mirroring video (TCP): AES-128-CTR. Key/IV are derived per stream from
//    the session key and the SETUP `streamConnectionID`:
//      key = SHA512("AirPlayStreamKey<connID>" ‖ sessionKey)[0..16)
//      iv  = SHA512("AirPlayStreamIV<connID>"  ‖ sessionKey)[0..16)
//    (<connID> is the connection ID rendered as an unsigned decimal string.)
//
//  • Audio (UDP RTP): AES-128-CBC, IV = SETUP `eiv`, cipher state reset every
//    packet; a trailing partial block (< 16 bytes) stays in the clear.

import crypto from 'node:crypto';

/** Render a (possibly signed) 64-bit stream connection ID as unsigned decimal. */
export function unsignedConnectionId(id) {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) {
    throw new Error('streamConnectionID number must be a safe integer; use BigInt for 64-bit values');
  }
  let big;
  try {
    big = typeof id === 'bigint' ? id : BigInt(id);
  } catch {
    throw new Error('streamConnectionID must be an integer or BigInt');
  }
  if (big < -(1n << 63n) || big > (1n << 64n) - 1n) {
    throw new Error('streamConnectionID is outside the 64-bit range');
  }
  if (big < 0n) big += 1n << 64n;
  return big.toString(10);
}

/**
 * Legacy-paired senders bind the PlayFair-unwrapped key to pair-verify's
 * X25519 secret with SHA-256. Unpaired/old-protocol senders use it directly.
 */
export function deriveFairPlaySessionKey(unwrappedKey, pairingSecret = null) {
  if (!Buffer.isBuffer(unwrappedKey) || unwrappedKey.length < 16) {
    throw new Error('unwrappedKey must be at least 16 bytes');
  }
  const key = unwrappedKey.subarray(0, 16);
  if (pairingSecret === null || pairingSecret === undefined) return Buffer.from(key);
  if (!Buffer.isBuffer(pairingSecret) || pairingSecret.length !== 32) {
    throw new Error('pairingSecret must be 32 bytes');
  }
  return crypto.createHash('sha256').update(key).update(pairingSecret).digest().subarray(0, 16);
}

/** Derive the AES-CTR key/iv for a mirroring video stream. */
export function deriveMirrorStreamKey(sessionKey, streamConnectionId) {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length < 16) {
    throw new Error('deriveMirrorStreamKey: sessionKey must be >= 16 bytes');
  }
  const connId = unsignedConnectionId(streamConnectionId);
  const key = crypto.createHash('sha512')
    .update(`AirPlayStreamKey${connId}`)
    .update(sessionKey.subarray(0, 16))
    .digest().subarray(0, 16);
  const iv = crypto.createHash('sha512')
    .update(`AirPlayStreamIV${connId}`)
    .update(sessionKey.subarray(0, 16))
    .digest().subarray(0, 16);
  return { key: Buffer.from(key), iv: Buffer.from(iv) };
}

/**
 * Streaming AES-128-CTR decryptor for the mirror video channel. The CTR
 * keystream runs continuously across frames, so keep one instance per stream.
 */
export class MirrorStreamDecryptor {
  #decipher;

  constructor(sessionKey, streamConnectionId) {
    const { key, iv } = deriveMirrorStreamKey(sessionKey, streamConnectionId);
    this.#decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  }

  decrypt(payload) {
    if (!Buffer.isBuffer(payload)) throw new Error('mirror payload must be a Buffer');
    return this.#decipher.update(payload);
  }
}

/**
 * Per-packet AES-128-CBC decryptor for RAOP / mirror audio. Each RTP payload
 * is decrypted independently with the same key/iv; bytes past the last full
 * 16-byte block are not encrypted and are passed through.
 */
export class AudioPacketDecryptor {
  #key;
  #iv;

  constructor(key, iv) {
    if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error('audio key must be 16 bytes');
    if (!Buffer.isBuffer(iv) || iv.length !== 16) throw new Error('audio iv must be 16 bytes');
    this.#key = Buffer.from(key);
    this.#iv = Buffer.from(iv);
  }

  decrypt(payload) {
    if (!Buffer.isBuffer(payload)) throw new Error('audio payload must be a Buffer');
    const encryptedLen = payload.length - (payload.length % 16);
    if (encryptedLen === 0) return Buffer.from(payload);
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.#key, this.#iv);
    decipher.setAutoPadding(false);
    const clear = decipher.update(payload.subarray(0, encryptedLen));
    return encryptedLen === payload.length
      ? clear
      : Buffer.concat([clear, payload.subarray(encryptedLen)]);
  }
}
