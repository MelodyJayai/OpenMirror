// FairPlay SAPv2.5 key exchange (POST /fp-setup).
//
// iOS negotiates a FairPlay session before it will stream mirroring/audio when
// the receiver advertises the FairPlay feature bits. The exchange is two round
// trips over the RTSP control channel:
//
//   Phase 1 ("setup1"):  client → 16 bytes  "FPLY" 03 01 01 00 00 00 00 04 <…> <mode>
//                        server → 142 bytes  a fixed reply chosen by <mode> (0..3)
//   Phase 2 ("setup2"):  client → 164 bytes  "FPLY" 03 01 03 …  (key message)
//                        server → 32 bytes    12-byte FPLY reply header ‖ the
//                                              request's final 20 bytes
//
// The wire framing, phase detection and header validation live here. The
// reverse-engineered key material is isolated behind an injectable provider;
// production uses the vendored, GPL PlayFair WebAssembly provider while tests
// and alternate implementations can supply the same small interface.
//
// A provider implements:
//   phase1(mode: number, request: Buffer): Buffer   // 142-byte reply
//   phase2(request: Buffer): { reply: Buffer, sharedKey?: Buffer }
//
// `sharedKey` (when the provider can compute it) is the FairPlay-decrypted AES
// key used to unwrap the per-stream media keys later in SETUP.

export const FPLY_HEADER = Buffer.from([0x46, 0x50, 0x4c, 0x59]); // "FPLY"
export const FP_SETUP1_LENGTH = 16;
export const FP_SETUP2_LENGTH = 164;
export const FP_REPLY1_LENGTH = 142;
export const FP_REPLY2_LENGTH = 32;
export const FP_SETUP2_REPLY_HEADER = Buffer.from([
  0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x14,
]);

/** True when `body` begins with the FairPlay "FPLY" magic. */
export function isFairPlayMessage(body) {
  return Buffer.isBuffer(body) && body.length >= 7 && body.subarray(0, 4).equals(FPLY_HEADER);
}

/**
 * Classify an fp-setup request body into { phase, mode }.
 *   phase 1 → 16-byte setup; mode = body[14] (0..3)
 *   phase 2 → 164-byte setup; mode = null
 */
export function classifyFpSetup(body) {
  if (!isFairPlayMessage(body)) {
    throw new Error('fp-setup: not a FairPlay (FPLY) message');
  }
  if (body[4] !== 0x03 || body[5] !== 0x01) {
    throw new Error(`fp-setup: unsupported version ${body[4]}.${body[5]}`);
  }
  // body[4] = major version (3), body[5] = minor (1), body[6] = type.
  const type = body[6];
  if (type === 1) {
    if (body.length !== FP_SETUP1_LENGTH) {
      throw new Error(`fp-setup phase 1 must be ${FP_SETUP1_LENGTH} bytes, got ${body.length}`);
    }
    const mode = body[14];
    if (mode > 3) throw new Error(`fp-setup: invalid mode ${mode}`);
    return { phase: 1, mode };
  }
  if (type === 3) {
    if (body.length !== FP_SETUP2_LENGTH) {
      throw new Error(`fp-setup phase 2 must be ${FP_SETUP2_LENGTH} bytes, got ${body.length}`);
    }
    return { phase: 2, mode: null };
  }
  throw new Error(`fp-setup: unrecognized message (len=${body.length}, type=${type})`);
}

/**
 * Per-connection FairPlay session. Drives the two-phase handshake and, when the
 * provider yields it, exposes the negotiated `sharedKey` for stream-key unwrap.
 */
export class FairPlaySession {
  #provider;
  #mode = null;
  phase = 0;
  sharedKey = null;
  keyMessage = null;

  constructor(provider) {
    if (!provider || typeof provider.phase1 !== 'function' || typeof provider.phase2 !== 'function') {
      throw new Error('FairPlaySession requires a provider with phase1()/phase2()');
    }
    this.#provider = provider;
  }

  /** Handle a POST /fp-setup body; returns the reply Buffer to send back. */
  handle(body) {
    const { phase, mode } = classifyFpSetup(body);
    if (phase === 1) {
      this.#mode = mode;
      this.phase = 1;
      this.sharedKey = null;
      this.keyMessage = null;
      const reply = this.#provider.phase1(mode, body);
      assertLength(reply, FP_REPLY1_LENGTH, 'fp-setup phase 1 reply');
      return reply;
    }
    if (this.phase !== 1) throw new Error('fp-setup phase 2 before phase 1');
    this.phase = 2;
    this.keyMessage = Buffer.from(body);
    const result = this.#provider.phase2(body, this.#mode);
    if (!result || typeof result !== 'object') {
      throw new Error('fp-setup phase 2 provider must return { reply, sharedKey? }');
    }
    const { reply, sharedKey } = result;
    assertLength(reply, FP_REPLY2_LENGTH, 'fp-setup phase 2 reply');
    if (sharedKey) {
      if (!Buffer.isBuffer(sharedKey) || sharedKey.length < 16) {
        throw new Error('fp-setup sharedKey must be a Buffer of at least 16 bytes');
      }
      this.sharedKey = Buffer.from(sharedKey);
    }
    return reply;
  }
}

function assertLength(buf, expected, what) {
  if (!Buffer.isBuffer(buf) || buf.length !== expected) {
    throw new Error(`${what} must be ${expected} bytes, got ${Buffer.isBuffer(buf) ? buf.length : typeof buf}`);
  }
}

/**
 * A minimal provider used for protocol bring-up and tests. It produces
 * correctly *shaped* replies (right lengths, echoed header/mode) so the RTSP
 * state machine and senders that don't strictly validate FairPlay can proceed,
 * but it does NOT implement Apple's cipher — no real `sharedKey` is derived.
 *
 * Swap this for a verified `playfair` table provider to interoperate with a
 * real iOS sender end to end.
 */
export function createStubFairPlayProvider() {
  return {
    phase1(mode, request) {
      const reply = Buffer.alloc(FP_REPLY1_LENGTH);
      FPLY_HEADER.copy(reply, 0);
      reply[4] = 0x03;
      reply[5] = 0x01;
      reply[6] = 0x02;          // phase-1 reply type
      reply[14] = mode & 0xff;  // echo negotiated mode
      // Remaining bytes are left zeroed: this is a shape-only stub.
      return reply;
    },
    phase2(request) {
      const reply = Buffer.alloc(FP_REPLY2_LENGTH);
      FP_SETUP2_REPLY_HEADER.copy(reply, 0);
      request.subarray(request.length - 20).copy(reply, FP_SETUP2_REPLY_HEADER.length);
      return { reply };
    },
  };
}
