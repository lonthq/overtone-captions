import { describe, expect, it } from 'vitest';
import { assertValid, validate } from 'overtone-format';
import { makeDoc } from './helpers';

/** Paths of all reported issues. */
function paths(doc: unknown): string[] {
  return validate(doc).errors.map((issue) => issue.path);
}

/** A deep copy of the test document that tests may mutate freely. */
function docAny(): any {
  return structuredClone(makeDoc());
}

describe('validate: document level', () => {
  it('accepts a valid document', () => {
    expect(validate(makeDoc())).toEqual({ valid: true, errors: [] });
  });

  it('never throws on garbage input', () => {
    for (const input of [null, undefined, 42, 'x', [], { turns: 'nope' }, { turns: [null], profiles: [null] }]) {
      expect(() => validate(input)).not.toThrow();
      expect(validate(input).valid).toBe(false);
    }
  });

  it('reports a non-object root at $', () => {
    expect(paths(null)).toEqual(['$']);
  });

  it('checks format, version, language and duration', () => {
    const doc = docAny();
    doc.format = 'other';
    doc.version = 2;
    doc.language = '';
    doc.duration = -1;
    expect(paths(doc)).toEqual(['format', 'version', 'language', 'duration']);
  });

  it('requires the speakers, turns and profiles arrays', () => {
    const doc = docAny();
    delete doc.speakers;
    delete doc.turns;
    delete doc.profiles;
    expect(paths(doc)).toEqual(['speakers', 'turns', 'profiles']);
  });

  it('allows unknown fields everywhere', () => {
    const doc = docAny();
    doc.future = { anything: true };
    doc.speakers[0].avatar = 'x.png';
    doc.turns[0].words[0].phonemes = ['h'];
    doc.profiles[0].cues[0].position = 'top';
    expect(validate(doc).valid).toBe(true);
  });

  it('accepts a document without optional edits and meta', () => {
    const doc = docAny();
    delete doc.edits;
    delete doc.meta;
    expect(validate(doc).valid).toBe(true);
  });

  it('requires meta to be an object when present', () => {
    const doc = docAny();
    doc.meta = 'x';
    expect(paths(doc)).toEqual(['meta']);
  });
});

describe('validate: meta', () => {
  it('checks the style enums', () => {
    const doc = docAny();
    doc.meta.style = { numbers: 'roman', currency: 'emoji', guide: 'x' };
    expect(paths(doc)).toEqual(['meta.style.numbers', 'meta.style.currency']);
  });

  it('accepts every allowed style value', () => {
    for (const numbers of ['digits', 'words', 'auto']) {
      for (const currency of ['symbol', 'code', 'words', 'auto']) {
        const doc = docAny();
        doc.meta.style = { numbers, currency, guide: 'Use digits.' };
        expect(validate(doc).valid).toBe(true);
      }
    }
  });

  it('requires string fields to be strings when present', () => {
    const doc = docAny();
    doc.meta = {
      title: 1,
      context: false,
      generator: {},
      createdAt: 20261007,
      style: { guide: 3 },
      models: { text: 1, timing: null, second: false, llm: [] },
      custom: 42,
    };
    expect(paths(doc)).toEqual([
      'meta.title',
      'meta.context',
      'meta.generator',
      'meta.createdAt',
      'meta.style.guide',
      'meta.models.text',
      'meta.models.timing',
      'meta.models.second',
      'meta.models.llm',
    ]);
  });

  it('requires style and models to be objects when present', () => {
    const doc = docAny();
    doc.meta.style = 'loose';
    doc.meta.models = ['a'];
    expect(paths(doc)).toEqual(['meta.style', 'meta.models']);
  });
});

describe('validate: speakers', () => {
  it('requires a non-empty unique id', () => {
    const doc = docAny();
    doc.speakers.push({ id: 'S1' }, { id: '' });
    expect(paths(doc)).toEqual(['speakers[2].id', 'speakers[3].id']);
  });

  it('requires label and role to be strings when present', () => {
    const doc = docAny();
    doc.speakers[0].label = 3;
    doc.speakers[1].role = false;
    expect(paths(doc)).toEqual(['speakers[0].label', 'speakers[1].role']);
  });
});

describe('validate: turns and words', () => {
  it('requires a known speaker on every turn', () => {
    const doc = docAny();
    doc.turns[1].speaker = 'S9';
    expect(paths(doc)).toContain('turns[1].speaker');
  });

  it('requires numeric times with at most 3 decimals', () => {
    const doc = docAny();
    doc.turns[0].start = '0.5';
    doc.turns[0].words[0].end = 0.91234;
    doc.turns[0].words[1].start = Number.NaN;
    expect(paths(doc)).toEqual(['turns[0].start', 'turns[0].words[0].end', 'turns[0].words[1].start']);
  });

  it('accepts times that are exact to the millisecond despite float noise', () => {
    const doc = docAny();
    doc.turns[0].words[0].end = 0.1 + 0.2 + 0.6; // 0.9000000000000001
    expect(validate(doc).valid).toBe(true);
  });

  it('requires end >= start for turns and words', () => {
    const doc = docAny();
    doc.turns[1].end = 2.4;
    doc.turns[0].words[3].end = 1.8;
    expect(paths(doc)).toEqual(['turns[0].words[3].end', 'turns[1].end']);
  });

  it('requires words within a turn to be ordered and non-overlapping', () => {
    const doc = docAny();
    doc.turns[0].words[1].start = 0.8; // previous word ends at 0.9
    expect(paths(doc)).toEqual(['turns[0].words[1].start']);
  });

  it('requires at least one word with non-empty text', () => {
    const doc = docAny();
    doc.turns[1].words = [];
    doc.turns[0].words[0].text = '';
    expect(paths(doc)).toContain('turns[1].words');
    expect(paths(doc)).toContain('turns[0].words[0].text');
  });

  it('only allows the fixed style classes', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = ['emphasis', 'fancy'];
    doc.turns[0].words[1].classes = 'soft';
    const result = validate(doc);
    expect(result.errors.map((e) => e.path)).toEqual(['turns[0].words[0].classes[1]', 'turns[0].words[1].classes']);
    expect(result.errors[0].message).toContain('fancy');
  });

  it('rejects word text that is only whitespace', () => {
    const doc = docAny();
    doc.turns[0].words[0].text = ' \n\t ';
    const result = validate(doc);
    expect(result.errors.map((e) => e.path)).toContain('turns[0].words[0].text');
    expect(result.errors.find((e) => e.path === 'turns[0].words[0].text')?.message).toBe(
      'must contain non-whitespace text',
    );
  });

  it('rejects duplicate classes in a word', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = ['emphasis', 'key', 'emphasis'];
    const result = validate(doc);
    expect(result.errors.map((e) => e.path)).toEqual(['turns[0].words[0].classes[2]']);
    expect(result.errors[0].message).toBe('duplicate class "emphasis"');
  });

  it('checks match and confidence', () => {
    const doc = docAny();
    doc.turns[0].words[0].match = 'guess';
    doc.turns[0].words[1].confidence = 1.5;
    expect(paths(doc)).toEqual(['turns[0].words[0].match', 'turns[0].words[1].confidence']);
  });
});

describe('validate: edits', () => {
  it('checks the word range against the number of words', () => {
    const doc = docAny();
    doc.edits.push({ words: [4, 5], from: 'a', to: 'b', reason: 'style' });
    doc.edits.push({ words: [2, 1], from: 'a', to: 'b', reason: 'style' });
    expect(paths(doc)).toEqual(['edits[1].words', 'edits[2].words']);
  });

  it('checks from, to and reason', () => {
    const doc = docAny();
    doc.edits[0].from = 1;
    doc.edits[0].reason = 'taste';
    expect(paths(doc)).toEqual(['edits[0].from', 'edits[0].reason']);
  });
});

describe('assertValid', () => {
  it('returns the document when valid', () => {
    const doc = makeDoc();
    expect(assertValid(doc)).toBe(doc);
  });

  it('throws an Error listing every issue', () => {
    const doc = docAny();
    doc.version = 7;
    doc.language = 5;
    expect(() => assertValid(doc)).toThrow(/Invalid Overtone document \(2 issues\):\n- version: .*\n- language: /);
  });
});

describe('validate robustness', () => {
  const nullProto = (): unknown => Object.create(null);

  it('does not throw on a null-prototype turn speaker', () => {
    const doc = docAny();
    doc.turns[0].speaker = nullProto();
    expect(() => validate(doc)).not.toThrow();
    expect(validate(doc).valid).toBe(false);
  });

  it('does not throw on a null-prototype word text', () => {
    const doc = docAny();
    doc.turns[0].words[0].text = nullProto();
    expect(() => validate(doc)).not.toThrow();
    expect(validate(doc).valid).toBe(false);
  });

  it('does not throw on a null-prototype word class', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = [nullProto()];
    expect(() => validate(doc)).not.toThrow();
    expect(validate(doc).valid).toBe(false);
  });

  it('does not throw on a null-prototype cue speaker', () => {
    const doc = docAny();
    doc.profiles[0].cues[0].speaker = nullProto();
    expect(() => validate(doc)).not.toThrow();
    expect(validate(doc).valid).toBe(false);
  });
});
