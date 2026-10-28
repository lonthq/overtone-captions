#!/usr/bin/env node
// The regression gate's full table: WER and timing per clip for every frozen hearing and the current pipeline, then
// the gated metrics against the baseline. Offline, on packages/cli/test/fixtures/bench/ (and bench/private/).
// The gate itself is packages/cli/test/bench-gate.test.ts.
//
//   node bench/gate.mjs [clip ...]     all clips, or only the ones named
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib/load-ts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { report } = await loadTs('packages/cli/test/bench/gate.ts');
console.log(await report([
  { name: 'committed clips', dir: join(ROOT, 'packages/cli/test/fixtures/bench') },
  { name: 'private clips (bench/private)', dir: join(ROOT, 'bench/private') },
], process.argv.slice(2)));
