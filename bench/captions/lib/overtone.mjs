// Load the Overtone source helpers (lib/overtone-src.ts) by bundling them with esbuild (a dev dependency of the
// repository, via tsup). The bundle is rebuilt on every run, so it always matches packages/cli/src.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = join(HERE, '../data/.build/overtone-src.mjs');

export async function loadOvertone() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    entryPoints: [join(HERE, 'overtone-src.ts')],
    outfile: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'error',
    alias: { 'overtone-format': join(ROOT, 'packages/format/src/index.ts') },
  });
  return import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);
}
