import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OvertoneDocument } from 'overtone-format';

// import.meta.dirname rather than new URL(): under jsdom, URL is jsdom's class, which node:fs rejects.
const fixturePath = join(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');

/** A fresh copy of examples/fixtures/sample.overtone.json (Lumora / DriveCover sample). */
export function loadFixture(): OvertoneDocument {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as OvertoneDocument;
}
