#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages', 'core', 'vendor', 'playfair');
const output = path.join(root, 'packages', 'core', 'src', 'crypto', 'playfair.wasm');
const zig = process.env.ZIG ?? 'zig';

const sources = [
  'wasm_api.c',
  'playfair.c',
  'omg_hax.c',
  'modified_md5.c',
  'sap_hash.c',
  'hand_garble.c',
].map((file) => path.join(source, file));

const args = [
  'cc',
  '-target', 'wasm32-freestanding',
  '-O3',
  '-fno-stack-protector',
  '-fno-builtin',
  '-nostdlib',
  '-I', path.join(source, 'freestanding'),
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,--strip-all',
  '-o', output,
  ...sources,
];

const result = spawnSync(zig, args, { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`Unable to launch Zig (${zig}): ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
