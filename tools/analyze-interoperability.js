#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { analyzeInteroperabilityRecords } from '../packages/core/src/diagnostics.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const confirmObservations = args.includes('--confirm');
const filename = args.find((arg) => !arg.startsWith('--'));
if (!filename) {
  console.error(
    'Usage: node tools/analyze-interoperability.js <diagnostics.jsonl> [--confirm] [--json]',
  );
  process.exit(2);
}

const resolvedFilename = resolve(filename);
let records;
try {
  const text = await readFile(resolvedFilename, 'utf8');
  records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON on line ${index + 1}: ${error.message}`);
      }
    });
} catch (error) {
  console.error(`Cannot analyze diagnostics: ${error.message}`);
  process.exit(2);
}

if (confirmObservations) {
  const questions = [
    ['videoPlayback', 'Was decoded video visibly rendered?'],
    ['audioPlayback', 'Was AAC-ELD audio clearly audible?'],
    ['rotationRecovery', 'Did playback recover after every rotation?'],
    ['lockResume', 'Did playback recover after lock and unlock?'],
    ['reconnect', 'Did playback work after disconnect and reconnect?'],
  ];
  const input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout.isTTY) });
  const observations = {};
  let confirmationError = null;
  try {
    console.log('Confirm what you personally observed during this run.');
    if (stdin.isTTY) {
      for (const [key, question] of questions) {
        let answer;
        do {
          answer = (await input.question(`${question} [y/N] `)).trim().toLowerCase();
          if (!['', 'y', 'yes', 'n', 'no'].includes(answer)) {
            console.log('Please answer y or n.');
          }
        } while (!['', 'y', 'yes', 'n', 'no'].includes(answer));
        observations[key] = answer === 'y' || answer === 'yes';
      }
    } else {
      const answers = [];
      for await (const line of input) answers.push(line.trim().toLowerCase());
      if (answers.length < questions.length) {
        throw new Error(`expected ${questions.length} y/n answers, received ${answers.length}`);
      }
      for (const [index, [key]] of questions.entries()) {
        const answer = answers[index];
        if (!['', 'y', 'yes', 'n', 'no'].includes(answer)) {
          throw new Error(`invalid y/n answer ${index + 1}: ${JSON.stringify(answer)}`);
        }
        observations[key] = answer === 'y' || answer === 'yes';
      }
    }
  } catch (error) {
    confirmationError = error;
  } finally {
    input.close();
  }
  if (confirmationError) {
    console.error(`Cannot record manual observations: ${confirmationError.message}`);
    process.exit(2);
  }
  const manualVerification = {
    type: 'manual-verification',
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    observations,
  };
  const latestRunId = [...records].reverse().find(
    (record) => record?.type === 'run-start' && record.runId,
  )?.runId;
  if (latestRunId) manualVerification.runId = latestRunId;
  try {
    await appendFile(resolvedFilename, `${JSON.stringify(manualVerification)}\n`, 'utf8');
    records.push(manualVerification);
  } catch (error) {
    console.error(`Cannot append manual observations: ${error.message}`);
    process.exit(2);
  }
}

const result = analyzeInteroperabilityRecords(records);
if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `OpenMirror interoperability result: ${result.passed ? 'PASS' : 'INCOMPLETE/FAIL'}`,
  );
  console.log(
    `Sessions: ${result.sessionCount}; media sessions: ${result.mediaSessionCount}`,
  );
  for (const item of result.checks) {
    console.log(`${item.passed ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
  }
}
process.exitCode = result.passed ? 0 : 1;
