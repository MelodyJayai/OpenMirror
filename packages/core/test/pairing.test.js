import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  DeviceIdentity, PairingSession,
  rawEd25519PublicKey, x25519PublicFromRaw, ed25519PublicFromRaw,
} from '../src/crypto/pairing.js';

function rawX25519Public(keyObject) {
  const der = keyObject.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

/** Simulate an iOS sender performing the legacy handshake. */
function clientHandshake(session) {
  // Client identity (ed25519) + ephemeral curve key (x25519).
  const clientId = crypto.generateKeyPairSync('ed25519');
  const clientCurve = crypto.generateKeyPairSync('x25519');
  const clientEdRaw = rawEd25519PublicKey(clientId.publicKey);
  const clientCurveRaw = rawX25519Public(clientCurve.publicKey);

  // POST /pair-setup
  const setupReply = session.pairSetup(clientEdRaw);
  assert.equal(setupReply.length, 32);

  // POST /pair-verify (step 1)
  const step1 = Buffer.concat([Buffer.from([1, 0, 0, 0]), clientCurveRaw, clientEdRaw]);
  const { body: reply1, done: done1 } = session.pairVerify(step1);
  assert.equal(done1, false);
  assert.equal(reply1.length, 96);

  const serverCurveRaw = reply1.subarray(0, 32);
  const encryptedServerSig = reply1.subarray(32, 96);

  // Client derives the same AES-CTR keystream.
  const shared = crypto.diffieHellman({
    privateKey: clientCurve.privateKey,
    publicKey: x25519PublicFromRaw(serverCurveRaw),
  });
  const aesKey = crypto.createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest().subarray(0, 16);
  const aesIv = crypto.createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest().subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-128-ctr', aesKey, aesIv);
  const serverSig = decipher.update(encryptedServerSig);

  // Verify the server signed (serverCurve ‖ clientCurve) with the advertised pk.
  const serverOk = crypto.verify(
    null,
    Buffer.concat([serverCurveRaw, clientCurveRaw]),
    ed25519PublicFromRaw(setupReply),
    serverSig,
  );
  assert.equal(serverOk, true, 'server signature must verify against its advertised key');

  // Step 2: client signs (clientCurve ‖ serverCurve), encrypts continuing the keystream.
  const clientSig = crypto.sign(null, Buffer.concat([clientCurveRaw, serverCurveRaw]), clientId.privateKey);
  const cipher = crypto.createCipheriv('aes-128-ctr', aesKey, aesIv);
  cipher.update(Buffer.alloc(64)); // burn the 64 bytes the server used
  const encryptedClientSig = cipher.update(clientSig);

  const step2 = Buffer.concat([Buffer.from([0, 0, 0, 0]), encryptedClientSig]);
  return session.pairVerify(step2);
}

test('full legacy pair-setup + pair-verify handshake succeeds', () => {
  const identity = new DeviceIdentity();
  const session = new PairingSession(identity);
  const { done } = clientHandshake(session);
  assert.equal(done, true);
  assert.equal(session.verified, true);
});

test('tampered client signature is rejected', () => {
  const identity = new DeviceIdentity();
  const session = new PairingSession(identity);

  const clientId = crypto.generateKeyPairSync('ed25519');
  const clientCurve = crypto.generateKeyPairSync('x25519');
  const clientEdRaw = rawEd25519PublicKey(clientId.publicKey);
  const clientCurveRaw = rawX25519Public(clientCurve.publicKey);

  session.pairSetup(clientEdRaw);
  session.pairVerify(Buffer.concat([Buffer.from([1, 0, 0, 0]), clientCurveRaw, clientEdRaw]));

  const garbage = Buffer.concat([Buffer.from([0, 0, 0, 0]), crypto.randomBytes(64)]);
  assert.throws(() => session.pairVerify(garbage), /signature invalid/);
  assert.equal(session.verified, false);
});

test('pair-verify step2 before step1 is rejected', () => {
  const session = new PairingSession(new DeviceIdentity());
  assert.throws(
    () => session.pairVerify(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(64)])),
    /step2 before step1/,
  );
});

test('DeviceIdentity is reproducible from a seed', () => {
  const seed = crypto.randomBytes(32);
  const a = new DeviceIdentity({ privateKeySeed: seed });
  const b = new DeviceIdentity({ privateKeySeed: seed });
  assert.equal(a.publicKeyHex, b.publicKeyHex);
  assert.equal(a.publicKeyRaw.length, 32);
});
