import { describe, expect, it } from 'vitest';
import type { Profile } from 'overtone-format';
import { applyStyles, enforceKeyPerCue, enforceStyleBudget, personName, phrases, unbrandPeople } from '../src/refine/styling.js';
import { planWindows } from '../src/refine/windows.js';
import type { SpeakerWord } from '../src/turns.js';

function words(n: number, speakerAt: (i: number) => string = () => 'S1', text: (i: number) => string = (i) => `w${i}`): SpeakerWord[] {
  return Array.from({ length: n }, (_, i) => ({ text: text(i), start: i, end: i + 0.5, speaker: speakerAt(i) }));
}
const classes = (ws: SpeakerWord[]) => ws.map((w) => (w.classes ?? []).join('+'));

describe('applyStyles', () => {
  it('merges classes in canonical order and ignores invalid spans', () => {
    const ws = words(5);
    const n = applyStyles(ws, [
      { first: 1, last: 2, classes: ['number'] },
      { first: 2, last: 2, classes: ['brand'] },
      { first: 3, last: 9, classes: ['key'] },
      { first: 4, last: 4, classes: ['sparkle' as never] },
    ]);
    expect(n).toBe(2);
    expect(classes(ws)).toEqual(['', 'number', 'brand+number', '', '']);
  });
});

describe('phrases', () => {
  it('finds maximal runs', () => {
    const ws = words(6);
    applyStyles(ws, [{ first: 0, last: 1, classes: ['key'] }, { first: 3, last: 3, classes: ['key'] }, { first: 4, last: 4, classes: ['key'] }]);
    expect(phrases(ws, 'key')).toEqual([[0, 1], [3, 4]]);
    expect(phrases(ws, 'key', 2, 3)).toEqual([[3, 3]]);
  });
});

describe('enforceStyleBudget', () => {
  it('drops the lowest-priority classes first, largest phrase first', () => {
    const ws = words(20);
    applyStyles(ws, [
      { first: 0, last: 0, classes: ['brand'] },
      { first: 2, last: 3, classes: ['number'] },
      { first: 5, last: 7, classes: ['soft'] },
      { first: 9, last: 9, classes: ['soft'] },
      { first: 11, last: 12, classes: ['emphasis'] },
    ]);
    // 9 styled words, budget 15 % of 20 = 3
    const dropped = enforceStyleBudget(ws, 0.15);
    expect(dropped).toBe(3);
    expect(ws.filter((w) => w.classes).length).toBe(3);
    expect(classes(ws).slice(0, 4)).toEqual(['brand', '', 'number', 'number']);
  });

  it('does not drop a class from words that keep another class', () => {
    const ws = words(20);
    applyStyles(ws, [{ first: 0, last: 2, classes: ['number', 'key'] }, { first: 5, last: 6, classes: ['key'] }]);
    // 5 styled words, budget 3: dropping "key" from the number phrase would free nothing
    expect(enforceStyleBudget(ws, 0.15)).toBe(1);
    expect(classes(ws).slice(0, 7)).toEqual(['key+number', 'key+number', 'key+number', '', '', '', '']);
  });

  it('still meets the budget when every styled word carries two classes', () => {
    for (const both of [['key', 'number'], ['soft', 'emphasis']] as const) {
      const ws = words(20);
      applyStyles(ws, [{ first: 0, last: 19, classes: [...both] }]);
      enforceStyleBudget(ws, 0.15);
      expect(ws.filter((w) => w.classes).length).toBeLessThanOrEqual(3);
    }
  });

  it('does nothing within budget', () => {
    const ws = words(20);
    applyStyles(ws, [{ first: 0, last: 1, classes: ['key'] }]);
    expect(enforceStyleBudget(ws, 0.15)).toBe(0);
  });
});

describe('enforceKeyPerCue', () => {
  it('keeps the first key phrase in each cue of every profile', () => {
    const ws = words(8);
    applyStyles(ws, [{ first: 1, last: 1, classes: ['key'] }, { first: 3, last: 3, classes: ['key'] }, { first: 6, last: 6, classes: ['key', 'brand'] }]);
    const cue = (a: number, b: number) => ({ start: a, end: b + 0.5, speaker: 'S1', lines: [{ words: [a, b] as [number, number], text: '' }] });
    const horizontal: Profile = { id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [cue(0, 7)] };
    const vertical: Profile = { id: 'vertical', aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2 }, cues: [cue(0, 3), cue(4, 7)] };
    expect(enforceKeyPerCue(ws, [vertical, horizontal], 1)).toBe(2);
    expect(classes(ws)).toEqual(['', 'key', '', '', '', '', 'brand', '']);
  });
});

describe('planWindows', () => {
  it('uses one window for short transcripts', () => {
    expect(planWindows(words(10))).toEqual([{ first: 0, last: 9, ownFirst: 0, ownLast: 9 }]);
  });

  it('cuts at turn starts and overlaps for context', () => {
    const ws = words(25, (i) => (i < 8 ? 'S1' : i < 18 ? 'S2' : 'S1'));
    expect(planWindows(ws, 10, 2)).toEqual([
      { first: 0, last: 9, ownFirst: 0, ownLast: 7 },
      { first: 6, last: 19, ownFirst: 8, ownLast: 17 },
      { first: 16, last: 24, ownFirst: 18, ownLast: 24 },
    ]);
  });

  it('terminates for a zero, negative or fractional limit', () => {
    expect(planWindows(words(3), 0, 0)).toHaveLength(3);
    expect(planWindows(words(3), -5, -1)).toHaveLength(3);
    expect(planWindows(words(4), 2.5, 0).map((w) => [w.ownFirst, w.ownLast])).toEqual([[0, 1], [2, 3]]);
  });

  it('falls back to sentence starts, then to the limit', () => {
    const ws = words(12, () => 'S1', (i) => (i === 3 ? 'end.' : `w${i}`));
    expect(planWindows(ws, 5, 0).map((w) => [w.ownFirst, w.ownLast])).toEqual([[0, 3], [4, 8], [9, 11]]);
  });

  it('judges sentence ends with their neighbours, as turns.ts does', () => {
    // "plan B." ends a sentence (a lone capital after a lowercase word is no initial); "John F." does not
    const plan = words(12, () => 'S1', (i) => ({ 1: 'done.', 3: 'plan', 4: 'B.' } as Record<number, string>)[i] ?? `w${i}`);
    expect(planWindows(plan, 6, 0).map((w) => [w.ownFirst, w.ownLast])).toEqual([[0, 4], [5, 10], [11, 11]]);
    const initial = words(12, () => 'S1', (i) => ({ 1: 'done.', 3: 'John', 4: 'F.' } as Record<number, string>)[i] ?? `w${i}`);
    expect(planWindows(initial, 6, 0).map((w) => [w.ownFirst, w.ownLast])).toEqual([[0, 1], [2, 7], [8, 11]]);
    // "etc." ends a sentence before a capital
    const etc = words(12, () => 'S1', (i) => ({ 1: 'done.', 4: 'etc.', 5: 'Then' } as Record<number, string>)[i] ?? `w${i}`);
    expect(planWindows(etc, 6, 0).map((w) => [w.ownFirst, w.ownLast])).toEqual([[0, 4], [5, 10], [11, 11]]);
  });
});

describe('unbrandPeople', () => {
  /** Words of `text`; the (0-based, inclusive) word ranges in `brand` carry the class "brand". */
  const marked = (text: string, brand: Array<[number, number]>) => {
    const t = text.split(' ');
    const ws = words(t.length, () => 'S1', (i) => t[i]);
    applyStyles(ws, brand.map(([first, last]) => ({ first, last, classes: ['brand'] })));
    return ws;
  };
  const branded = (ws: SpeakerWord[]) => ws.filter((w) => w.classes?.includes('brand')).map((w) => w.text).join(' ');

  it('removes "brand" from a speaker\'s name, keeps real brands', () => {
    const ws = marked("Colonel Jim Dutton, flew Discovery for NASA. Dutton's son, jim and Jim,", [[1, 2], [4, 4], [6, 6], [7, 7], [9, 9], [11, 11]]);
    expect(unbrandPeople(ws, ['Jim Dutton', 'Allard Beutel'])).toBe(4);
    expect(branded(ws)).toBe('Discovery NASA. jim');
  });

  it('keeps brands that only share a word with a speaker\'s name', () => {
    const ws = marked('Jim Beam and Dutton Industries', [[0, 1], [3, 4]]);
    expect(unbrandPeople(ws, ['Jim Dutton'])).toBe(0);
    expect(branded(ws)).toBe('Jim Beam Dutton Industries');
  });

  it('ignores acronyms, roles, parenthesized parts and name particles in labels', () => {
    const nasa = () => marked('the NASA team', [[1, 1]]);
    for (const label of ['NASA Commentator', 'Jim Dutton (NASA)']) {
      const ws = nasa();
      unbrandPeople(ws, [label]);
      expect(branded(ws)).toBe('NASA');
    }
    const museum = marked('the Van Gogh Museum and Ruud van der Linden', [[1, 3], [5, 8]]);
    expect(unbrandPeople(museum, ['Ruud van der Linden'])).toBe(4);
    expect(branded(museum)).toBe('Van Gogh Museum');
  });

  it('changes nothing without names', () => {
    const ws = marked('Jim Dutton', [[0, 1]]);
    expect(unbrandPeople(ws, [])).toBe(0);
    expect(branded(ws)).toBe('Jim Dutton');
  });
});

describe('personName', () => {
  it('returns the name parts of a personal name, nothing for roles or single names', () => {
    expect(personName('Jim Dutton (NASA)')).toEqual(['jim', 'dutton']);
    expect(personName('Ruud van der Linden')).toEqual(['ruud', 'linden']);
    for (const label of ['NASA Commentator', 'Host', 'Maya', 'S1']) expect(personName(label)).toBeUndefined();
  });
});
