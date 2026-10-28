import { coverageOf, fieldsOf, LEVELS } from '../lang/coverage.js';
import { PACKS, findPack } from '../lang/index.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';

const GUIDE = 'https://github.com/lonthq/overtone-captions/blob/main/docs/contributing/languages.md';

const pad = (s: string, n: number) => s.padEnd(n);

/** `overtone languages [code]`: each language pack's coverage, or every field of one pack, so contributors see what is left. Returns the exit code. */
export function runLanguages(code: string | undefined, log: Logger): number {
  if (code === undefined) {
    const nameWidth = Math.max(8, ...PACKS.map((p) => p.name.length)) + 2;
    log.out(`${pad('code', 6)}${pad('language', nameWidth)}${LEVELS.map((l) => pad(l.label, l.label.length + 2)).join('')}coverage`);
    for (const p of PACKS) {
      const marks = LEVELS.map((l) => pad(l.has(p) ? 'yes' : '-', l.label.length + 2)).join('');
      log.out(`${pad(p.code, 6)}${pad(p.name, nameWidth)}${marks}${coverageOf(p)}`);
    }
    log.out('');
    log.out('Other languages use the neutral rules: punctuation, names and digits only.');
    log.out(`Details of one pack: overtone languages <code>. Add or improve a language: ${GUIDE}`);
    return 0;
  }
  const pack = findPack(code);
  if (!pack) throw new UserError(`No language pack for "${code}" yet; it uses the neutral rules. Add one: ${GUIDE}`);
  log.out(`${pack.code}  ${pack.name}${pack.nativeName && pack.nativeName !== pack.name ? ` (${pack.nativeName})` : ''}: ${coverageOf(pack)}`);
  const fields = fieldsOf(pack);
  const width = Math.max(...fields.map((f) => f.section.length + f.field.length + 1)) + 2;
  let section = '';
  for (const f of fields) {
    if (f.section !== section) {
      section = f.section;
      log.out('');
    }
    const name = pad(`${f.section}.${f.field}`, width);
    log.out(`  ${f.size > 0 ? '+' : '-'} ${name}${pad(f.size > 0 ? String(f.size) : '', 5)}${f.gives}`);
  }
  log.out('');
  log.out(`+ filled, - not filled yet (falls back to the neutral rules). Field docs: packages/cli/src/lang/types.ts`);
  return 0;
}
