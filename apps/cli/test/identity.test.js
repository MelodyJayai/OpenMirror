import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AirPlayReceiver, pairingIdentifier } from '@openmirror/core';
import {
  defaultReceiverIdentityPath,
  loadOrCreateReceiverIdentity,
  parseReceiverIdentity,
} from '../src/identity.js';

async function temporaryIdentityPath(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmirror-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', 'receiver-identity.json');
}

test('defaultReceiverIdentityPath follows platform configuration conventions', () => {
  assert.equal(
    defaultReceiverIdentityPath({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      home: 'C:\\Users\\Test',
    }),
    'C:\\Users\\Test\\AppData\\Local\\OpenMirror\\receiver-identity.json',
  );
  assert.equal(
    defaultReceiverIdentityPath({
      platform: 'darwin',
      env: {},
      home: '/Users/test',
    }),
    '/Users/test/Library/Application Support/OpenMirror/receiver-identity.json',
  );
  assert.equal(
    defaultReceiverIdentityPath({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/custom/config' },
      home: '/home/test',
    }),
    '/custom/config/openmirror/receiver-identity.json',
  );
});

test('loadOrCreateReceiverIdentity persists one valid private identity', async (t) => {
  const identityPath = await temporaryIdentityPath(t);
  const created = await loadOrCreateReceiverIdentity(identityPath);
  const loaded = await loadOrCreateReceiverIdentity(identityPath);

  assert.equal(created.created, true);
  assert.equal(loaded.created, false);
  assert.equal(loaded.deviceId, created.deviceId);
  assert.deepEqual(loaded.privateKeySeed, created.privateKeySeed);
  assert.equal(loaded.path, path.resolve(identityPath));
  assert.match(created.deviceId, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  assert.equal(Number.parseInt(created.deviceId.slice(0, 2), 16) & 0x03, 0x02);
  if (process.platform !== 'win32') {
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  }
});

test('concurrent first starts converge on the same atomic identity', async (t) => {
  const identityPath = await temporaryIdentityPath(t);
  const identities = await Promise.all(
    Array.from({ length: 12 }, () => loadOrCreateReceiverIdentity(identityPath)),
  );

  assert.equal(identities.filter((identity) => identity.created).length, 1);
  assert.equal(new Set(identities.map((identity) => identity.deviceId)).size, 1);
  assert.equal(
    new Set(identities.map((identity) => identity.privateKeySeed.toString('hex'))).size,
    1,
  );
});

test('persistent identity keeps device id, pairing UUID and public key across receivers', async (t) => {
  const identityPath = await temporaryIdentityPath(t);
  const identity = await loadOrCreateReceiverIdentity(identityPath);
  const first = new AirPlayReceiver({
    deviceId: identity.deviceId,
    privateKeySeed: identity.privateKeySeed,
  });
  const second = new AirPlayReceiver({
    deviceId: identity.deviceId,
    privateKeySeed: identity.privateKeySeed,
  });

  assert.equal(first.options.deviceId, second.options.deviceId);
  assert.equal(first.options.pairingId, pairingIdentifier(identity.deviceId));
  assert.equal(first.options.pairingId, second.options.pairingId);
  assert.equal(first.identity.publicKeyHex, second.identity.publicKeyHex);
  await first.stop();
  await second.stop();
});

test('invalid identity files fail closed without silently rotating trust', async (t) => {
  const identityPath = await temporaryIdentityPath(t);
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, '{"schemaVersion":1,"deviceId":"invalid"}\n', {
    flag: 'wx',
  });
  const before = await readFile(identityPath, 'utf8');

  await assert.rejects(
    loadOrCreateReceiverIdentity(identityPath),
    /Cannot load receiver identity.*deviceId/,
  );
  assert.equal(await readFile(identityPath, 'utf8'), before);
});

test('parseReceiverIdentity requires canonical 32-byte seed material', () => {
  assert.throws(
    () => parseReceiverIdentity(JSON.stringify({
      schemaVersion: 1,
      deviceId: '02:00:00:00:00:01',
      privateKeySeed: Buffer.alloc(31).toString('base64'),
    })),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => parseReceiverIdentity(JSON.stringify({
      schemaVersion: 1,
      deviceId: '00:00:00:00:00:01',
      privateKeySeed: Buffer.alloc(32).toString('base64'),
    })),
    /locally administered unicast/,
  );
});
