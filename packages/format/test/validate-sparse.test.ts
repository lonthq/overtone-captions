import { describe, expect, it } from 'vitest';
import { validate } from 'overtone-format';
import { makeDoc } from './helpers';

/** A deep copy of the test document that tests may mutate freely. */
function docAny(): any {
  return structuredClone(makeDoc());
}

/** Holes cannot come from JSON.parse but can from code; a hole is reported like any other non-object item. */
describe('validate: sparse arrays', () => {
  it('reports a hole in speakers', () => {
    const doc = docAny();
    doc.speakers = new Array(1);
    expect(validate(doc).errors).toContainEqual({ path: 'speakers[0]', message: 'must be an object' });
  });

  it('reports a hole in turns', () => {
    const doc = docAny();
    doc.turns.push(doc.turns[1]);
    delete doc.turns[1];
    expect(validate(doc).errors).toContainEqual({ path: 'turns[1]', message: 'must be an object' });
  });

  it('reports a hole in the words of a turn', () => {
    const doc = docAny();
    delete doc.turns[0].words[1];
    expect(validate(doc).errors).toContainEqual({ path: 'turns[0].words[1]', message: 'must be an object' });
  });

  it('reports a hole in the classes of a word', () => {
    const doc = docAny();
    doc.turns[0].words[0].classes = new Array(1);
    const result = validate(doc);
    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.path)).toEqual(['turns[0].words[0].classes[0]']);
  });

  it('reports a hole in edits', () => {
    const doc = docAny();
    doc.edits = new Array(1);
    expect(validate(doc).errors).toContainEqual({ path: 'edits[0]', message: 'must be an object' });
  });

  it('reports a hole in profiles', () => {
    const doc = docAny();
    delete doc.profiles[1];
    expect(validate(doc).errors).toContainEqual({ path: 'profiles[1]', message: 'must be an object' });
  });

  it('reports a hole in the cues of a profile', () => {
    const doc = docAny();
    delete doc.profiles[0].cues[1];
    expect(validate(doc).errors).toContainEqual({ path: 'profiles[0].cues[1]', message: 'must be an object' });
  });

  it('reports a hole in the lines of a cue', () => {
    const doc = docAny();
    doc.profiles[1].cues[0].lines = new Array(1);
    expect(validate(doc).errors).toContainEqual({ path: 'profiles[1].cues[0].lines[0]', message: 'must be an object' });
  });

  it('reports a trailing hole that only the length shows', () => {
    const doc = docAny();
    doc.profiles[1].cues.length = 4;
    expect(validate(doc).errors).toContainEqual({ path: 'profiles[1].cues[3]', message: 'must be an object' });
  });

  it('reports a hole the same way as the null that JSON makes of it', () => {
    const doc = docAny();
    delete doc.profiles[0].cues[0];
    doc.turns[1].words = new Array(1);
    const roundTripped = JSON.parse(JSON.stringify(doc));
    expect(roundTripped.profiles[0].cues[0]).toBeNull();
    expect(validate(doc).errors).toEqual(validate(roundTripped).errors);
  });
});
