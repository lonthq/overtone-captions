import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Package version from packages/cli/package.json (one level up from both src/ and dist/). */
export const VERSION: string = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

/** Value for `meta.generator`. */
export const GENERATOR = `overtone-captions@${VERSION}`;
