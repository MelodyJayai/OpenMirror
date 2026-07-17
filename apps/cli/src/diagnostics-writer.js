import { createWriteStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';

function jsonlRecord(runId, type, payload) {
  return `${JSON.stringify({ type, runId, ...payload })}\n`;
}

/**
 * Open an append-only diagnostics writer after completely writing the initial
 * run-start record. Awaiting that append prevents a forced console close from
 * leaving a zero-byte report after the CLI has begun a run.
 */
export async function openDiagnosticsWriter(filename, {
  runId,
  runStart,
  onError = () => {},
}) {
  await mkdir(dirname(filename), { recursive: true });
  await appendFile(filename, jsonlRecord(runId, 'run-start', runStart), 'utf8');

  const stream = createWriteStream(filename, { flags: 'a' });
  stream.on('error', onError);
  let closed = false;

  return {
    write(type, payload) {
      if (closed) throw new Error('diagnostics writer is closed');
      return stream.write(jsonlRecord(runId, type, payload));
    },
    async close() {
      if (closed) return;
      closed = true;
      const completion = finished(stream);
      stream.end();
      await completion;
    },
  };
}
