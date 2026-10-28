import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import schema from 'overtone-format/schema.json';
import { validate } from 'overtone-format';

const root = join(import.meta.dirname, '../../..');
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);

/** Every .overtone.json under examples/ (the hand-made fixture and the committed pipeline output). */
const exampleFiles = readdirSync(join(root, 'examples'), { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.overtone.json') && !path.split(/[\\/]/).includes('node_modules'))
  .sort();

/** The complete documents in the specification's examples (§19): JSON code blocks with "format": "overtone". */
const specDocs = [...readFileSync(join(root, 'docs/format/spec.md'), 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)]
  .map((match) => match[1])
  .filter((block) => /^\{[\s\S]*"format": "overtone"/.test(block));

describe('committed example documents', () => {
  it('finds the fixture and the pipeline output', () => {
    expect(exampleFiles).toEqual(expect.arrayContaining([
      join('fixtures', 'sample.overtone.json'),
      join('output', 'nasa', 'nasa-dutton.overtone.json'),
      join('output', 'sample', 'sample-16x9.overtone.json'),
    ]));
  });

  it.each(exampleFiles)('examples/%s passes the JSON Schema and validate()', (path) => {
    const doc = JSON.parse(readFileSync(join(root, 'examples', path), 'utf8'));
    expect(validateSchema(doc), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validate(doc).errors).toEqual([]);
  });

  it('the specification examples pass the JSON Schema and validate()', () => {
    expect(specDocs.length).toBeGreaterThanOrEqual(2);
    for (const block of specDocs) {
      const doc = JSON.parse(block);
      expect(validateSchema(doc), JSON.stringify(validateSchema.errors)).toBe(true);
      expect(validate(doc).errors).toEqual([]);
    }
  });
});
