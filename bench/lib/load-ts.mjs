// Loads a regression-gate TypeScript module by bundling it with esbuild into bench/data/.build/, fresh every run.
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Offline, as in the tests: the CMU Pronouncing Dictionary from the dev dependency, not the download.
process.env.OVERTONE_CMUDICT ??= join(ROOT, 'node_modules/cmu-pronouncing-dictionary/index.js');

export async function loadTs(entry) {
  const out = join(ROOT, 'bench/data/.build', `${basename(entry, '.ts')}.mjs`);
  mkdirSync(dirname(out), { recursive: true });
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'error',
    alias: { 'overtone-format': join(ROOT, 'packages/format/src/index.ts') },
  });
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}
