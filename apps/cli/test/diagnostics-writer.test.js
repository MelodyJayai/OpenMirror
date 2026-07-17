import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDiagnosticsWriter } from '../src/diagnostics-writer.js';

test('diagnostics writer persists run-start before returning and appends later records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmirror-diagnostics-'));
  const filename = path.join(directory, 'run.jsonl');
  await writeFile(filename, '{"type":"older-run"}\n', 'utf8');

  try {
    const writer = await openDiagnosticsWriter(filename, {
      runId: 'run-test',
      runStart: { schemaVersion: 1, capabilityProfile: { video: 'H264' } },
    });

    const initialRecords = (await readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(initialRecords, [
      { type: 'older-run' },
      {
        type: 'run-start',
        runId: 'run-test',
        schemaVersion: 1,
        capabilityProfile: { video: 'H264' },
      },
    ]);

    writer.write('snapshot', { sessions: [] });
    await writer.close();
    await writer.close();

    const finalRecords = (await readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(finalRecords.at(-1), {
      type: 'snapshot',
      runId: 'run-test',
      sessions: [],
    });
    assert.equal(finalRecords.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
