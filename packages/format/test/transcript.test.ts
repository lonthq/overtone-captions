import { describe, expect, it } from 'vitest';
import { toTranscript } from 'overtone-format';
import { makeDoc } from './helpers';

describe('toTranscript', () => {
  it('writes one "Label: text" paragraph per turn', () => {
    expect(toTranscript(makeDoc())).toBe('Sarah: Hello everyone, welcome back.\n\nS2: Thanks!\n');
  });

  it('keeps consecutive turns of the same speaker as separate paragraphs', () => {
    const doc = makeDoc();
    doc.turns[1].speaker = 'S1';
    expect(toTranscript(doc)).toBe('Sarah: Hello everyone, welcome back.\n\nSarah: Thanks!\n');
  });

  it('returns an empty string for a document without turns', () => {
    expect(toTranscript({ ...makeDoc(), turns: [] })).toBe('');
  });

  it('collapses whitespace inside word text so a paragraph stays one line', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].text = 'a\n\nb';
    expect(toTranscript(doc)).toBe('Sarah: Hello everyone, welcome back.\n\nS2: a b\n');
  });
});
