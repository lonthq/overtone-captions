import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import schema from 'overtone-format/schema.json';
import { EDIT_REASONS, FORMAT_NAME, FORMAT_VERSION, MATCH_KINDS, STYLE_CLASSES, validate } from 'overtone-format';
import { ASPECT_PATTERN } from '../src/aspect';
import { PROFILE_ID_PATTERN } from '../src/validate-profiles';
import { CURRENCY_STYLES, NUMBER_STYLES } from '../src/validate-utils';
import { makeDoc } from './helpers';

const fixturePath = join(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);

function docAny(): any {
  return structuredClone(makeDoc());
}

describe('overtone.schema.json', () => {
  it('is a JSON Schema 2020-12 document', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('keeps enums and constants in sync with types.ts', () => {
    expect(schema.$defs.styleClass.enum).toEqual([...STYLE_CLASSES]);
    expect(schema.$defs.word.properties.match.enum).toEqual([...MATCH_KINDS]);
    expect(schema.$defs.edit.properties.reason.enum).toEqual([...EDIT_REASONS]);
    expect(schema.properties.format.const).toBe(FORMAT_NAME);
    expect(schema.properties.version.const).toBe(FORMAT_VERSION);
    expect(schema.$defs.meta.properties.style.properties.numbers.enum).toEqual([...NUMBER_STYLES]);
    expect(schema.$defs.meta.properties.style.properties.currency.enum).toEqual([...CURRENCY_STYLES]);
    expect(schema.$defs.profile.properties.aspect.pattern).toBe(ASPECT_PATTERN.source);
    expect(schema.$defs.profile.properties.id.pattern).toBe(PROFILE_ID_PATTERN.source);
  });

  it('accepts the sample fixture and the unit-test document', () => {
    expect(validateSchema(fixture), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateSchema(makeDoc()), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it('accepts unknown fields', () => {
    const doc = docAny();
    doc.future = 1;
    doc.turns[0].words[0].extra = 'x';
    expect(validateSchema(doc)).toBe(true);
  });

  it('rejects an unknown style class', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = ['sparkle'];
    expect(validateSchema(doc)).toBe(false);
  });

  it('rejects duplicate classes and whitespace-only word text', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = ['key', 'key'];
    expect(validateSchema(doc)).toBe(false);
    const doc2 = docAny();
    doc2.turns[0].words[0].text = ' \n ';
    expect(validateSchema(doc2)).toBe(false);
  });

  it('rejects unsafe profile ids like validate() does', () => {
    for (const id of ['my profile', 'a/b', '../x', 'a.b', '', 'a\n']) {
      const doc = docAny();
      doc.profiles[0].id = id;
      expect(validateSchema(doc), JSON.stringify(id)).toBe(false);
      expect(validate(doc).valid, JSON.stringify(id)).toBe(false);
    }
    const ok = docAny();
    ok.profiles[0].id = 'Social_9x16-v2';
    expect(validateSchema(ok)).toBe(true);
    expect(validate(ok).valid).toBe(true);
  });

  it('rejects whatever validate() rejects in meta (and vice versa)', () => {
    const bad = [
      { style: { numbers: 'roman' } },
      { style: { currency: 'emoji' } },
      { title: 1 },
      { context: false },
      { generator: {} },
      { createdAt: 1 },
      { models: { text: 1 } },
      { models: { timing: null } },
      { models: { llm: [] } },
    ];
    for (const meta of bad) {
      const doc = { ...docAny(), meta };
      expect(validateSchema(doc), JSON.stringify(meta)).toBe(false);
      expect(validate(doc).valid, JSON.stringify(meta)).toBe(false);
    }
  });

  it('agrees with validate() on duplicate classes and blank word text', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = ['key', 'key'];
    doc.turns[0].words[1].text = '   ';
    expect(validateSchema(doc)).toBe(false);
    expect(validate(doc).valid).toBe(false);
  });

  it('rejects a wrong format name, version or missing required fields', () => {
    expect(validateSchema({ ...makeDoc(), format: 'srt' })).toBe(false);
    expect(validateSchema({ ...makeDoc(), version: 2 })).toBe(false);
    const doc = docAny();
    delete doc.profiles;
    expect(validateSchema(doc)).toBe(false);
  });

  it('rejects an invalid edit reason and a malformed word range', () => {
    const doc = docAny();
    doc.edits[0].reason = 'taste';
    expect(validateSchema(doc)).toBe(false);
    const doc2 = docAny();
    doc2.profiles[0].cues[0].lines[0].words = [0];
    expect(validateSchema(doc2)).toBe(false);
  });
});

/**
 * Semantic rules (spec Appendix A) that JSON Schema cannot express. Each case breaks one rule:
 * validate() rejects it with the given message, the schema accepts it.
 */
const SEMANTIC_RULES: { kind: string; rule: string; mutate: (doc: any) => void; message: RegExp }[] = [
  { kind: 'precision', rule: 'times have at most 3 decimals', mutate: (d) => { d.duration = 5.0001; }, message: /at most 3 decimals/ },
  { kind: 'order', rule: 'word range first <= last', mutate: (d) => { d.edits[0].words = [3, 2]; }, message: /first <= last/ },
  { kind: 'order', rule: 'turn end >= start', mutate: (d) => { d.turns[1].end = 2.4; }, message: /must be >= start/ },
  { kind: 'order', rule: 'word end >= start', mutate: (d) => { d.turns[0].words[0].end = 0.4; }, message: /must be >= start/ },
  { kind: 'order', rule: 'cue end > start', mutate: (d) => { d.profiles[0].cues[1].end = 2.5; }, message: /must be after start/ },
  { kind: 'order', rule: 'window end > start', mutate: (d) => { d.profiles[0].window = { start: 3, end: 3 }; }, message: /start must be before end/ },
  { kind: 'order', rule: 'words in a turn are ordered and do not overlap', mutate: (d) => { d.turns[0].words[1].start = 0.8; }, message: /overlaps the previous word/ },
  { kind: 'order', rule: 'cues in a profile are ordered and do not overlap', mutate: (d) => { d.profiles[1].cues[1].start = 1.3; }, message: /overlaps the previous cue/ },
  {
    kind: 'order',
    rule: 'lines in a cue are ordered and do not share words',
    mutate: (d) => { d.profiles[0].cues[0].lines[1] = { words: [1, 3], text: 'everyone, welcome back.' }; },
    message: /must start after the previous line/,
  },
  { kind: 'uniqueness', rule: 'speaker ids are unique', mutate: (d) => { d.speakers.push({ id: 'S1', label: 'Other' }); }, message: /duplicate speaker id/ },
  { kind: 'uniqueness', rule: 'profile ids are unique', mutate: (d) => { d.profiles[1].id = 'horizontal'; }, message: /duplicate profile id/ },
  { kind: 'references', rule: 'turn speakers are declared', mutate: (d) => { d.turns[1].speaker = 'S9'; }, message: /unknown speaker "S9"/ },
  { kind: 'references', rule: 'cue speakers are declared', mutate: (d) => { d.profiles[0].cues[1].speaker = 'S9'; }, message: /unknown speaker "S9"/ },
  {
    kind: 'references',
    rule: 'every word of a cue belongs to the cue speaker',
    mutate: (d) => { d.profiles[1].cues[2].speaker = 'S1'; },
    message: /belongs to speaker "S2", not "S1"/,
  },
  { kind: 'references', rule: 'line ranges stay within the words', mutate: (d) => { d.profiles[0].cues[1].lines[0].words = [4, 5]; }, message: /out of bounds/ },
  { kind: 'references', rule: 'edit ranges stay within the words', mutate: (d) => { d.edits[0].words = [2, 9]; }, message: /out of bounds/ },
  { kind: 'references', rule: 'line text equals the referenced words', mutate: (d) => { d.profiles[0].cues[1].lines[0].text = 'Thanks'; }, message: /must equal the referenced words/ },
];

describe('semantic rules (checked by validate(), not by the schema)', () => {
  it.each(SEMANTIC_RULES)('$kind: $rule', ({ mutate, message }) => {
    const doc = docAny();
    mutate(doc);
    expect(validateSchema(doc), JSON.stringify(validateSchema.errors)).toBe(true);
    const { valid, errors } = validate(doc);
    expect(valid).toBe(false);
    expect(errors.map((e) => e.message).join('\n')).toMatch(message);
  });

  it('covers the four kinds named in the schema description', () => {
    expect([...new Set(SEMANTIC_RULES.map((r) => r.kind))]).toEqual(['precision', 'order', 'uniqueness', 'references']);
    for (const kind of ['time precision', 'order', 'uniqueness', 'references']) expect(schema.description).toContain(kind);
  });

  it('leaves time precision to validate(): multipleOf 0.001 would reject valid times', () => {
    const strict = new Ajv2020().compile({ type: 'number', multipleOf: 0.001 });
    expect(strict(0.823)).toBe(false);
    expect(validate({ ...docAny(), duration: 0.823 }).valid).toBe(true);
    expect(schema.$defs.time).not.toHaveProperty('multipleOf');
  });
});

/** Values that each leaf of the unit-test document is replaced with in the parity check below. */
const REPLACEMENTS: unknown[] = [null, '', ' ', 'x', 'S2', 'a b', -1, 0, 0.0001, 1.5, 2.2, 4, 1e9, true, [], {}, [0], [1, 0], [0, 0, 0], ['a']];

/** Every path from the root to a value in `value`, depth first. */
function allPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== 'object') return [path];
  const children = Object.entries(value).flatMap(([key, child]) =>
    allPaths(child, [...path, Array.isArray(value) ? Number(key) : key]),
  );
  return [path, ...children];
}

describe('schema and validate() agree on structure', () => {
  it('replacing or deleting any value: the schema never rejects what validate() accepts, and every extra validate() issue is a semantic rule', () => {
    // the semantic-rule messages of validate(), without the document values in them
    const semantic = /at most 3 decimals|first <= last|must be >= start|must be after start|start must be before end|overlaps the previous (word|cue)|must start after the previous line|duplicate (speaker|profile) id|unknown speaker|belongs to speaker|out of bounds|must equal the referenced words/;
    let checked = 0;
    for (const path of allPaths(makeDoc()).filter((p) => p.length > 0)) {
      for (const replacement of [...REPLACEMENTS, undefined]) {
        const doc = docAny();
        const parent = path.slice(0, -1).reduce((obj, key) => obj[key], doc);
        const key = path[path.length - 1];
        if (replacement === undefined) {
          if (Array.isArray(parent)) continue;
          delete parent[key];
        } else parent[key] = structuredClone(replacement);
        const where = `${path.join('.')} = ${replacement === undefined ? '(deleted)' : JSON.stringify(replacement)}`;
        const schemaOk = validateSchema(doc);
        const { valid, errors } = validate(doc);
        checked++;
        if (!schemaOk) expect(valid, where).toBe(false);
        else if (!valid) for (const e of errors) expect(e.message, `${where}: ${e.path}`).toMatch(semantic);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
