import { describe, expect, it } from 'vitest';
import { flattenWords, rangeText } from 'overtone-format';
import { makeDoc } from './helpers';

describe('flattenWords', () => {
  it('numbers words globally in turn order then word order', () => {
    const flat = flattenWords(makeDoc());
    expect(flat.map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
    expect(flat.map((w) => w.text)).toEqual(['Hello', 'everyone,', 'welcome', 'back.', 'Thanks!']);
  });

  it('adds the speaker and turn index of each word and keeps word fields', () => {
    const flat = flattenWords(makeDoc());
    expect(flat[4]).toMatchObject({ index: 4, speaker: 'S2', turn: 1, text: 'Thanks!', classes: ['key'] });
    expect(flat[2]).toMatchObject({ speaker: 'S1', turn: 0, match: 'fuzzy', confidence: 0.82 });
  });

  it('returns an empty list for a document without turns', () => {
    expect(flattenWords({ ...makeDoc(), turns: [] })).toEqual([]);
  });
});

describe('rangeText', () => {
  const words = flattenWords(makeDoc());

  it('joins the inclusive range with single spaces', () => {
    expect(rangeText(words, [0, 1])).toBe('Hello everyone,');
    expect(rangeText(words, [2, 4])).toBe('welcome back. Thanks!');
  });

  it('handles a single-word range', () => {
    expect(rangeText(words, [4, 4])).toBe('Thanks!');
  });

  it('throws a RangeError for reversed or out-of-bounds ranges', () => {
    expect(() => rangeText(words, [3, 2])).toThrow(RangeError);
    expect(() => rangeText(words, [-1, 0])).toThrow(RangeError);
    expect(() => rangeText(words, [4, 5])).toThrow(RangeError);
    expect(() => rangeText(words, [0.5, 1])).toThrow(RangeError);
  });
});
