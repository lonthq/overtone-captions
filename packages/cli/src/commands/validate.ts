import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flattenWords, validate, type OvertoneDocument } from 'overtone-format';
import { fsCode } from '../errors.js';
import type { Logger } from '../log.js';
import { stripBom } from '../text/decode.js';

/** Read a JSON file (a leading BOM is ignored); returns the value or an error message naming the file as `shown`. */
export async function readJson(path: string, shown = path): Promise<{ value: unknown } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = fsCode(err);
    if (code === 'ENOENT') return { error: `${shown}: file not found` };
    if (code === 'EISDIR') return { error: `${shown}: is a directory` };
    if (code === 'EACCES' || code === 'EPERM') return { error: `${shown}: permission denied` };
    return { error: `${shown}: cannot read file (${code ?? (err as Error).message})` };
  }
  try {
    return { value: JSON.parse(stripBom(raw)) as unknown };
  } catch (err) {
    return { error: `${shown}: not valid JSON (${(err as Error).message})` };
  }
}

/** `overtone validate <file>`: prints "valid" or one line per issue; returns the exit code. Resolved against `cwd`; messages show the path as given. */
export async function runValidate(path: string, log: Logger, cwd = process.cwd()): Promise<number> {
  const read = await readJson(resolve(cwd, path), path);
  if ('error' in read) {
    log.error(read.error);
    return 1;
  }
  const result = validate(read.value);
  if (!result.valid) {
    log.out(`${path}: invalid (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'})`);
    for (const e of result.errors) log.out(`  ${e.path || '(root)'}: ${e.message}`);
    return 1;
  }
  const doc = read.value as OvertoneDocument;
  const cues = doc.profiles.map((p) => `${p.id} ${p.cues.length}`).join(', ');
  log.out(`${path}: valid (${flattenWords(doc).length} words, ${doc.turns.length} turns, cues: ${cues || 'none'})`);
  return 0;
}
