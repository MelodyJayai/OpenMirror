// AirPlay legacy pairing (pair-setup / pair-verify), as spoken by iOS to
// UxPlay/RPiPlay-class receivers advertising SUPPORTS_LEGACY_PAIRING:
//
//   POST /pair-setup   → client sends its ed25519 public key (32 bytes),
//                        receiver replies with its own ed25519 public key.
//   POST /pair-verify  → two round trips:
//     1) client: 0x01 000000 | client x25519 pub (32) | client ed25519 pub (32)
//        server: server x25519 pub (32) | AES-CTR(sig_ed25519(server_pub‖client_pub)) (64)
//     2) client: 0x00 000000 | AES-CTR(client signature) (64)
//        server: verifies sig over (client_pub‖server_pub), replies 200.
//
// AES-128-CTR key/iv are derived from the x25519 shared secret:
//   key = SHA512("Pair-Verify-AES-Key" ‖ shared)[0..16)
//   iv  = SHA512("Pair-Verify-AES-IV"  ‖ shared)[0..16)
// The same CTR keystream continues across the server's encryption (step 1)
// and the client's ciphertext (step 2), so the decryptor must first burn
// 64 bytes of keystream.

import crypto from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function rawEd25519PublicKey(keyObject) {
  const der = keyObject.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function ed25519PublicFromRaw(raw32) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

export function x25519PublicFromRaw(raw32) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The receiver's long-lived identity: an ed25519 keypair. Its raw public key
 * is advertised in the mDNS TXT records as `pk`.
 */
export class DeviceIdentity {
  constructor({ privateKeySeed } = {}) {
    if (privateKeySeed) {
      this.privateKey = crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKeySeed]),
        format: 'der',
        type: 'pkcs8',
      });
      this.publicKey = crypto.createPublicKey(this.privateKey);
    } else {
      const pair = crypto.generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    this.publicKeyRaw = rawEd25519PublicKey(this.publicKey);
  }

  get publicKeyHex() {
    return this.publicKeyRaw.toString('hex');
  }

  sign(data) {
    return crypto.sign(null, data, this.privateKey);
  }
}

/** Per-connection pairing state machine. */
export class PairingSession {
  #identity;
  #clientEd25519 = null;   // raw 32-byte client identity key from pair-setup
  #clientCurvePub = null;  // raw 32-byte client x25519 key from pair-verify 1
  #serverCurvePub = null;
  #decipher = null;
  verified = false;

  constructor(identity) {
    this.#identity = identity;
  }

  /** Handle POST /pair-setup body. Returns the 32-byte response body. */
  pairSetup(body) {
    if (body.length !== 32) throw new Error(`pair-setup expects 32 bytes, got ${body.length}`);
    this.#clientEd25519 = Buffer.from(body);
    return this.#identity.publicKeyRaw;
  }

  /** Handle POST /pair-verify body. Returns { body, done }. */
  pairVerify(body) {
    if (body.length < 4) throw new Error('pair-verify body too short');
    const isFirst = body[0] === 1;
    return isFirst ? this.#verifyStep1(body) : this.#verifyStep2(body);
  }

  #verifyStep1(body) {
    if (body.length < 4 + 32 + 32) throw new Error('pair-verify step1 body too short');
    this.#clientCurvePub = Buffer.from(body.subarray(4, 36));
    const clientEdFromVerify = Buffer.from(body.subarray(36, 68));
    // Some senders skip pair-setup; take the identity key from here then.
    if (!this.#clientEd25519) this.#clientEd25519 = clientEdFromVerify;

    const ecdh = crypto.generateKeyPairSync('x25519');
    this.#serverCurvePub = (() => {
      const der = ecdh.publicKey.export({ format: 'der', type: 'spki' });
      return Buffer.from(der.subarray(der.length - 32));
    })();

    const shared = crypto.diffieHellman({
      privateKey: ecdh.privateKey,
      publicKey: x25519PublicFromRaw(this.#clientCurvePub),
    });

    const aesKey = crypto.createHash('sha512')
      .update('Pair-Verify-AES-Key').update(shared).digest().subarray(0, 16);
    const aesIv = crypto.createHash('sha512')
      .update('Pair-Verify-AES-IV').update(shared).digest().subarray(0, 16);

    const signature = this.#identity.sign(
      Buffer.concat([this.#serverCurvePub, this.#clientCurvePub]),
    );

    const cipher = crypto.createCipheriv('aes-128-ctr', aesKey, aesIv);
    const encryptedSig = cipher.update(signature); // 64 bytes of keystream consumed

    // The client's step-2 ciphertext continues the same keystream, so keep a
    // decryptor that has already consumed 64 bytes.
    this.#decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, aesIv);
    this.#decipher.update(Buffer.alloc(64));

    return {
      body: Buffer.concat([this.#serverCurvePub, encryptedSig]),
      done: false,
    };
  }

  #verifyStep2(body) {
    if (!this.#decipher || !this.#clientCurvePub) {
      throw new Error('pair-verify step2 before step1');
    }
    if (body.length < 4 + 64) throw new Error('pair-verify step2 body too short');
    const clientSig = this.#decipher.update(body.subarray(4, 68));

    const ok = crypto.verify(
      null,
      Buffer.concat([this.#clientCurvePub, this.#serverCurvePub]),
      ed25519PublicFromRaw(this.#clientEd25519),
      clientSig,
    );
    if (!ok) throw new Error('pair-verify: client signature invalid');
    this.verified = true;
    return { body: Buffer.alloc(0), done: true };
  }
}
