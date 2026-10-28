import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One variable from `<root>/.env`; the environment wins. */
export function envVar(root, name) {
  if (process.env[name]) return process.env[name];
  const file = join(root, '.env');
  if (!existsSync(file)) return undefined;
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm').exec(readFileSync(file, 'utf8'));
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2').trim() : undefined;
}
