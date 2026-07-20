// Desktop receiver settings persisted as JSON. Kept free of Electron imports
// so it stays unit-testable under plain node:test.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  name: 'OpenMirror',
  port: 7000,
});

export function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.name === 'string') {
      const name = raw.name.trim();
      // mDNS instance labels must fit in a single DNS label (63 bytes).
      if (name && Buffer.byteLength(name, 'utf8') <= 63) settings.name = name;
    }
    const port = Number(raw.port);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) settings.port = port;
  }
  return settings;
}

export async function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(file, raw) {
  const settings = normalizeSettings(raw);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}
