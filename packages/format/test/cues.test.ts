import { describe, expect, it } from 'vitest';
import { clipCuesToWindow, findCueIndex, getProfile, type Cue } from 'overtone-format';
import { makeDoc } from './helpers';

const cue = (start: number, end: number): Cue => ({ start, end, speaker: 'S1', lines: [{ words: [0, 0], text: 'x' }] });

describe('findCueIndex', () => {
  const cues = [cue(1, 2), cue(2, 3), cue(5, 6)];

  it('returns -1 before the first cue, in gaps and after the last cue', () => {
    expect(findCueIndex(cues, 0)).toBe(-1);
    expect(findCueIndex(cues, 4)).toBe(-1);
    expect(findCueIndex(cues, 6)).toBe(-1);
    expect(findCueIndex(cues, 99)).toBe(-1);
  });

  it('treats start as inclusive and end as exclusive', () => {
    expect(findCueIndex(cues, 1)).toBe(0);
    expect(findCueIndex(cues, 1.999)).toBe(0);
    expect(findCueIndex(cues, 2)).toBe(1);
    expect(findCueIndex(cues, 5.5)).toBe(2);
  });

  it('returns -1 for an empty list', () => {
    expect(findCueIndex([], 1)).toBe(-1);
  });

  it('finds the right cue in a long list', () => {
    const many = Array.from({ length: 1000 }, (_, i) => cue(i * 2, i * 2 + 1));
    expect(findCueIndex(many, 1234.5)).toBe(617);
    expect(findCueIndex(many, 1235.5)).toBe(-1);
  });
});

describe('getProfile', () => {
  it('returns the profile with the id, or undefined', () => {
    const doc = makeDoc();
    expect(getProfile(doc, 'vertical')?.cues).toHaveLength(3);
    expect(getProfile(doc, 'square')).toBeUndefined();
  });
});

describe('clipCuesToWindow', () => {
  it('returns all cues when the profile has no window', () => {
    const cues = [cue(1, 2), cue(3, 4)];
    expect(clipCuesToWindow({ id: 'p', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues })).toEqual(cues);
  });

  it('drops cues outside the window and clamps cues crossing its edges', () => {
    const profile = { id: 'p', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, window: { start: 1.5, end: 3.5 }, cues: [cue(0, 1), cue(1, 2), cue(2.5, 3), cue(3, 4), cue(4, 5)] };
    expect(clipCuesToWindow(profile).map((c) => [c.start, c.end])).toEqual([
      [1.5, 2],
      [2.5, 3],
      [3, 3.5],
    ]);
  });

  it('does not modify the input cues', () => {
    const profile = { id: 'p', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, window: { start: 1.5, end: 3.5 }, cues: [cue(1, 2)] };
    clipCuesToWindow(profile);
    expect(profile.cues[0].start).toBe(1);
  });
});
