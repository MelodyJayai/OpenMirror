import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings,
} from '../src/settings.js';

test('normalizeSettings validates name and port', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({ name: '  客厅投屏  ', port: '0' }),
    { name: '客厅投屏', port: 0 },
  );
  assert.deepEqual(normalizeSettings({ name: '', port: 65536 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ name: 'x'.repeat(64), port: -1 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ name: 42, port: 7100.5 }), DEFAULT_SETTINGS);
});

test('settings round-trip through disk and survive corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openmirror-settings-'));
  const file = join(dir, 'nested', 'settings.json');
  try {
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS);

    const saved = await saveSettings(file, { name: 'Studio', port: 7100 });
    assert.deepEqual(saved, { name: 'Studio', port: 7100 });
    assert.deepEqual(await loadSettings(file), saved);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json', 'utf8');
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
