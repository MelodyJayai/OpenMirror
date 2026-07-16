// Persistent receiver identity for the CLI. AirPlay senders associate the
// advertised device id, pairing UUID and Ed25519 public key with one receiver,
// so all three must survive process restarts.

import crypto from 'node:crypto';
import {
  chmod, link, lstat, mkdir, readFile, unlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomDeviceId } from '@openmirror/core';

const IDENTITY_SCHEMA_VERSION = 1;
const MAX_IDENTITY_FILE_BYTES = 4096;
const DEVICE_ID_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function defaultReceiverIdentityPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA
      ?? env.APPDATA
      ?? path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'OpenMirror', 'receiver-identity.json');
  }
  if (platform === 'darwin') {
    return path.posix.join(
      home,
      'Library',
      'Application Support',
      'OpenMirror',
      'receiver-identity.json',
    );
  }
  const base = env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config');
  return path.posix.join(base, 'openmirror', 'receiver-identity.json');
}

function validateDeviceId(value) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new Error('deviceId must be a colon-separated 6-byte identifier');
  }
  const normalized = value.toUpperCase();
  const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
  if ((firstOctet & 0x03) !== 0x02) {
    throw new Error('deviceId must be a locally administered unicast identifier');
  }
  return normalized;
}

function decodeSeed(value) {
  if (typeof value !== 'string') {
    throw new Error('privateKeySeed must be canonical base64');
  }
  const seed = Buffer.from(value, 'base64');
  if (seed.length !== 32 || seed.toString('base64') !== value) {
    throw new Error('privateKeySeed must encode exactly 32 bytes as canonical base64');
  }
  return seed;
}

export function parseReceiverIdentity(contents) {
  let record;
  try {
    record = JSON.parse(contents);
  } catch {
    throw new Error('identity file is not valid JSON');
  }
  if (!record || Array.isArray(record) || record.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    throw new Error(`identity file must use schemaVersion ${IDENTITY_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    deviceId: validateDeviceId(record.deviceId),
    privateKeySeed: decodeSeed(record.privateKeySeed),
  };
}

function createReceiverIdentity() {
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    deviceId: randomDeviceId(),
    privateKeySeed: crypto.randomBytes(32),
  };
}

function serializeReceiverIdentity(identity) {
  return `${JSON.stringify({
    schemaVersion: identity.schemaVersion,
    deviceId: identity.deviceId,
    privateKeySeed: identity.privateKeySeed.toString('base64'),
  }, null, 2)}\n`;
}

async function readReceiverIdentity(identityPath) {
  const file = await lstat(identityPath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('identity path must refer to a regular file, not a link');
  }
  if (file.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error(`identity file exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
  }
  const identity = parseReceiverIdentity(await readFile(identityPath, 'utf8'));
  if (process.platform !== 'win32') {
    await chmod(identityPath, 0o600);
  }
  return identity;
}

/**
 * Load the CLI's long-lived AirPlay identity, creating it exactly once.
 * A completed temporary file is atomically linked into place so concurrent
 * starts cannot observe partial JSON or publish different identities.
 */
export async function loadOrCreateReceiverIdentity(identityPath) {
  const resolvedPath = path.resolve(identityPath);
  try {
    return {
      ...(await readReceiverIdentity(resolvedPath)),
      path: resolvedPath,
      created: false,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Cannot load receiver identity "${resolvedPath}": ${error.message}`, {
        cause: error,
      });
    }
  }

  await mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const identity = createReceiverIdentity();
  const temporaryPath = `${resolvedPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeReceiverIdentity(identity), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(temporaryPath, resolvedPath);
      if (process.platform !== 'win32') {
        await chmod(resolvedPath, 0o600);
      }
      return { ...identity, path: resolvedPath, created: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return {
        ...(await readReceiverIdentity(resolvedPath)),
        path: resolvedPath,
        created: false,
      };
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
