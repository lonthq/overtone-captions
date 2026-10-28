import { describe, expect, it } from 'vitest';
import { validate } from 'overtone-format';
import { makeDoc } from './helpers';

function paths(doc: unknown): string[] {
  return validate(doc).errors.map((issue) => issue.path);
}

function docAny(): any {
  return structuredClone(makeDoc());
}

describe('validate: profiles', () => {
  it('requires a W:H aspect on every profile', () => {
    for (const aspect of [undefined, '16/9', '0:9', '09:16', 16 / 9]) {
      const doc = docAny();
      doc.profiles[0].aspect = aspect;
      const result = validate(doc);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({ path: 'profiles[0].aspect', message: 'must be a ratio "W:H" of two positive integers without leading zeros, such as "16:9"' });
    }
  });

  it('requires rules on every profile', () => {
    const doc = docAny();
    delete doc.profiles[1].rules;
    expect(validate(doc).errors).toContainEqual({ path: 'profiles[1].rules', message: 'must be an object' });
  });

  it('requires unique non-empty profile ids', () => {
    const doc = docAny();
    doc.profiles[1].id = 'horizontal';
    doc.profiles.push({ id: '', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [] });
    expect(paths(doc)).toEqual(['profiles[1].id', 'profiles[2].id']);
  });

  it("restricts profile ids to letters, digits, '-' and '_'", () => {
    for (const id of ['my profile', 'a/b', '../x', 'a.b', 'ü', 'a\n']) {
      const doc = docAny();
      doc.profiles[0].id = id;
      expect(validate(doc).errors, id).toEqual([
        { path: 'profiles[0].id', message: "must contain only letters, digits, '-' and '_'" },
      ]);
    }
    const ok = docAny();
    ok.profiles[0].id = 'Social_9x16-v2';
    expect(validate(ok).valid).toBe(true);
  });

  it('requires window start < end', () => {
    const doc = docAny();
    doc.profiles[0].window = { start: 4, end: 4 };
    expect(paths(doc)).toEqual(['profiles[0].window']);
  });

  it('checks rule values', () => {
    const doc = docAny();
    doc.profiles[0].rules = { maxCharsPerLine: 0, maxLines: 1.5, maxCps: -2 };
    expect(paths(doc)).toEqual([
      'profiles[0].rules.maxCharsPerLine',
      'profiles[0].rules.maxLines',
      'profiles[0].rules.maxCps',
    ]);
  });

  it('allows a profile without window and description', () => {
    const doc = docAny();
    delete doc.profiles[0].window;
    delete doc.profiles[0].description;
    expect(validate(doc).valid).toBe(true);
  });
});

describe('validate: cues', () => {
  it('requires the cue to end after it starts', () => {
    const doc = docAny();
    doc.profiles[0].cues[0].end = 0.5;
    expect(paths(doc)).toEqual(['profiles[0].cues[0].end']);
  });

  it('requires a known cue speaker', () => {
    const doc = docAny();
    doc.profiles[0].cues[1].speaker = 'S7';
    expect(paths(doc)).toContain('profiles[0].cues[1].speaker');
  });

  it('rejects overlapping cues', () => {
    const doc = docAny();
    doc.profiles[0].cues[1].start = 2.0; // previous cue ends at 2.2
    expect(paths(doc)).toEqual(['profiles[0].cues[1].start']);
  });

  it('requires at least one line', () => {
    const doc = docAny();
    doc.profiles[0].cues[1].lines = [];
    expect(paths(doc)).toEqual(['profiles[0].cues[1].lines']);
  });

  it('checks line ranges are in bounds and ascending', () => {
    const doc = docAny();
    doc.profiles[1].cues[2].lines[0].words = [4, 9];
    doc.profiles[0].cues[0].lines[1].words = [1, 3];
    doc.profiles[0].cues[0].lines[1].text = 'everyone, welcome back.';
    expect(paths(doc)).toEqual(['profiles[0].cues[0].lines[1].words', 'profiles[1].cues[2].lines[0].words']);
  });

  it('requires line text to equal the referenced words joined by spaces', () => {
    const doc = docAny();
    doc.profiles[0].cues[0].lines[0].text = 'Hello  everyone,';
    const result = validate(doc);
    expect(result.errors.map((e) => e.path)).toEqual(['profiles[0].cues[0].lines[0].text']);
    expect(result.errors[0].message).toContain('"Hello everyone,"');
  });

  it('rejects a cue whose words belong to another speaker', () => {
    const doc = docAny();
    doc.profiles[0].cues[0].end = 3.1;
    doc.profiles[0].cues[1].start = 3.2;
    doc.profiles[0].cues[0].lines[1] = { words: [2, 4], text: 'welcome back. Thanks!' };
    doc.profiles[0].cues[1].lines[0] = { words: [4, 4], text: 'Thanks!' };
    expect(paths(doc)).toEqual(['profiles[0].cues[0].lines[1].words']);
  });

  it('skips word cross-checks when the turns themselves are invalid', () => {
    const doc = docAny();
    doc.turns[0].words[0].start = 'x';
    expect(paths(doc)).toEqual(['turns[0].words[0].start']);
  });
});
