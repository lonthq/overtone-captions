import { describe, expect, it } from 'vitest';
import { applyEdits, checkEdit, type EditGuards, type ProposedEdit } from '../src/refine/edits.js';
import { alternativesOf } from '../src/refine/llm-steps.js';
import { correctionsPrompt } from '../src/refine/prompts.js';
import type { SpeakerWord } from '../src/turns.js';

/** "With|S1 Drive|S1 Cover…" → words 1 s apart, 0.8 s long. */
function words(spec: string): SpeakerWord[] {
  return spec.split(' ').map((tok, k) => {
    const [text, speaker = 'S1'] = tok.split('|');
    return { text, start: k, end: k + 0.8, speaker, match: 'exact', confidence: 1 };
  });
}
const guards: EditGuards = { maxSpan: 6, language: 'en' };
const edit = (first: number, last: number, to: string, reason: ProposedEdit['reason'] = 'correction'): ProposedEdit => ({ first, last, to, reason });

describe('structure checks', () => {
  const w = words('With Drive Cover from Lamora, you are insured for twelve euros a month. Hi|S2');
  it.each([
    [edit(0, 6, 'With DriveCover from Lumora, you are', 'brand'), 'span of 7 words exceeds the maximum of 6'],
    [edit(12, 13, 'month hi', 'correction'), 'crosses a speaker change'],
    [edit(3, 2, 'x'), 'word range [3, 2] is reversed'],
    [edit(13, 14, 'x'), 'word range [13, 14] is out of range'],
    [edit(0, 0, '  '), 'empty replacement'],
  ])('%j → %s', (e, expected) => {
    expect(checkEdit(w, e, guards)).toBe(expected);
  });

  it('rejects reasons outside the format', () => {
    const r = applyEdits(words('pay 12 euros'), [{ first: 0, last: 0, to: 'Pay', reason: 'grammar' as ProposedEdit['reason'] }], guards);
    expect(r.edits).toEqual([]);
    expect(r.rejected.map((x) => x.why)).toEqual(['unknown reason "grammar"']);
  });

  it('rejects a split when the span is shorter than 1 ms per new word', () => {
    const w1: SpeakerWord[] = [{ text: 'abcd', start: 1, end: 1.002, speaker: 'S1', match: 'exact', confidence: 1 }];
    const r = applyEdits(w1, [edit(0, 0, 'ab cd', 'split-word')], guards);
    expect(r.words.map((x) => [x.text, x.start, x.end])).toEqual([['ab', 1, 1.001], ['cd', 1.001, 1.002]]);
    const tiny = applyEdits(w1, [edit(0, 0, 'a b c d', 'split-word')], guards);
    expect(tiny.words).toEqual(w1);
    expect(tiny.rejected.map((x) => x.why)).toEqual(['span too short (2 ms for 4 words)']);
  });

  it('gives every split word at least 1 ms', () => {
    const w1: SpeakerWord[] = [{ text: 'abcdefghij', start: 1, end: 1.003, speaker: 'S1', match: 'exact', confidence: 1 }];
    const r = applyEdits(w1, [edit(0, 0, 'a bcdefghij', 'split-word')], guards);
    expect(r.words.map((x) => [x.text, x.start, x.end])).toEqual([['a', 1, 1.001], ['bcdefghij', 1.001, 1.003]]);
  });

  it('reports rejected edits in input order and rejects exact duplicates', () => {
    const r = applyEdits(words('alpha beta gamma delta'), [edit(3, 3, 'xyz'), edit(1, 1, 'beta,', 'punctuation'), edit(0, 0, 'banana'), edit(1, 1, 'beta,', 'punctuation')], guards);
    expect(r.edits.map((e) => e.to)).toEqual(['banana', 'beta,', 'xyz']);
    expect(r.rejected.map((x) => [x.from, x.why])).toEqual([['beta', 'duplicate edit']]);
  });

  it('rejects an edit that repeats a word next to it', () => {
    expect(checkEdit(words('with theclass we'), edit(1, 1, 'the the class'), guards)).toMatch(/repeats "the"/);
    expect(checkEdit(words('the Peacocks. now'), edit(1, 1, 'Peacocks. Peacocks.'), guards)).toMatch(/repeats "peacocks"/);
  });
});

describe('applyEdits', () => {
  it('re-tokenizes and spreads the span time by character length', () => {
    const w = words('With Drive Cover today');
    const r = applyEdits(w, [edit(1, 2, 'DriveCover', 'brand')], guards);
    expect(r.words.map((x) => x.text)).toEqual(['With', 'DriveCover', 'today']);
    expect(r.words[1]).toEqual({ text: 'DriveCover', start: 1, end: 2.8, speaker: 'S1', match: 'edited', confidence: 1 });
    expect(r.edits).toEqual([{ words: [1, 1], from: 'Drive Cover', to: 'DriveCover', reason: 'brand' }]);
    expect(r.rejected).toEqual([]);
  });

  it('splits one word into several proportionally', () => {
    const r = applyEdits(words('a welcome b'), [edit(1, 1, 'well come', 'split-word')], { ...guards });
    expect(r.words.slice(1, 3).map((x) => [x.text, x.start, x.end])).toEqual([['well', 1, 1.4], ['come', 1.4, 1.8]]);
    expect(r.edits[0].words).toEqual([1, 2]);
  });

  it('keeps original word times when the word count is unchanged', () => {
    const r = applyEdits(words('for twelve euros now'), [edit(1, 2, '12 euros', 'style')], guards);
    expect(r.words.slice(1, 3).map((x) => [x.text, x.start, x.end])).toEqual([['12', 1, 1.8], ['euros', 2, 2.8]]);
  });

  it('shifts later edit ranges into the new numbering', () => {
    const w = words('With Drive Cover from Lamora today');
    const r = applyEdits(w, [edit(4, 4, 'Lumora', 'brand'), edit(1, 2, 'DriveCover', 'brand')], guards);
    expect(r.words.map((x) => x.text)).toEqual(['With', 'DriveCover', 'from', 'Lumora', 'today']);
    expect(r.edits.map((e) => e.words)).toEqual([[1, 1], [3, 3]]);
  });

  it('records rejected edits with reasons, drops no-ops and overlapping edits', () => {
    const w = words('alpha beta gamma delta');
    const r = applyEdits(w, [edit(0, 0, 'alpha'), edit(1, 2, 'beta gamma,', 'punctuation'), edit(2, 3, 'gama delta'), edit(3, 3, 'xyz')], guards);
    expect(r.edits).toEqual([{ words: [1, 2], from: 'beta gamma', to: 'beta gamma,', reason: 'punctuation' }, { words: [3, 3], from: 'delta', to: 'xyz', reason: 'correction' }]);
    expect(r.rejected.map((x) => [x.from, x.why])).toEqual([['gamma delta', 'overlaps another edit']]);
  });

  it('keeps the lowest confidence of the replaced words', () => {
    const w = words('Drive Cover');
    w[1].confidence = 0.4;
    expect(applyEdits(w, [edit(0, 1, 'DriveCover', 'brand')], guards).words[0].confidence).toBe(0.4);
  });
});

describe('the editor is trusted', () => {
  it('applies any edit that passes the structure checks, also one that changes a name, a number or a negation', () => {
    const r = applyEdits(words('Tickets cost 15 euros, we can pay'), [edit(2, 2, '50'), edit(5, 5, "can't"), edit(0, 0, 'Tickets')], guards);
    expect(r.words.map((w) => w.text).join(' ')).toBe("Tickets cost 50 euros, we can't pay");
    expect(r.rejected).toEqual([]);
  });

  it('lists the edits it was not sure about, with its note, and applies them', () => {
    const r = applyEdits(words('the Telecom Cell network'), [{ ...edit(1, 2, 'Telkomsel', 'brand'), sure: false, note: 'a telecom brand' }, { ...edit(3, 3, 'network.', 'punctuation'), sure: true }], guards);
    expect(r.words.map((w) => w.text)).toEqual(['the', 'Telkomsel', 'network.']);
    expect(r.unsure).toEqual([{ edit: { ...edit(1, 2, 'Telkomsel', 'brand'), sure: false, note: 'a telecom brand' }, from: 'Telecom Cell', start: 1, end: 2.8 }]);
  });

  it('rejects a script without spaces changing more than maxSpan × 3 characters', () => {
    const ja: EditGuards = { maxSpan: 2, language: 'ja' };
    expect(checkEdit(words('あいうえおか'), edit(0, 0, '山川海空森林'), ja)).toBeNull();
    expect(checkEdit(words('あいうえおかき'), edit(0, 0, '山川海空森林木'), ja)).toMatch(/changes 7 characters, more than the maximum of 6/);
  });
});

describe('what the editor is shown', () => {
  const w = words('it was a kind day for us');
  const heard = w.map((x, k) => ({ text: k === 3 ? 'kite' : k === 5 ? 'four' : x.text, first: k, last: k }));

  it('lists where the timing engine heard something else, once per heard range', () => {
    expect(alternativesOf(w, heard, 'en')).toEqual([{ first: 3, last: 3, heard: 'kite' }, { first: 5, last: 5, heard: 'four' }]);
    const shared = { text: 'catalogue', first: 0, last: 0 };
    expect(alternativesOf(words('cat a log came'), [shared, shared, shared, { text: 'came', first: 1, last: 1 }], 'en')).toEqual([{ first: 0, last: 2, heard: 'catalogue' }]);
    expect(alternativesOf(w, undefined, 'en')).toEqual([]);
  });

  it('puts them in the corrections prompt for the words the window owns, and asks for sure and note', () => {
    const p = { glossary: [], style: {}, language: 'en', maxSpan: 6, maxStyledRatio: 0.15 };
    const prompt = correctionsPrompt(p, w, { first: 0, last: 6, ownFirst: 0, ownLast: 4 }, ['S1'], alternativesOf(w, heard, 'en'));
    expect(prompt.user).toContain('3: kind → kite');
    expect(prompt.user).not.toContain('5: for → four');
    expect(prompt.user).toContain('sure: true when');
    expect(prompt.user).not.toContain('Never change the meaning');
  });
});
