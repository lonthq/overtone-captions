import { describe, expect, it } from 'vitest';
import { alignWords, hearGaps } from '../src/align/align.js';
import { alignUnits } from '../src/align/dp.js';
import { splitSpan } from '../src/align/rate.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { AlignedWord, TimedWord } from '../src/types.js';
import { az } from './helpers.js';

const run = (text: string, timed: TimedWord[], language = 'en', extra = {}): AlignedWord[] =>
  alignWords(tokenizeDisplay(text), timed, { language, ...extra });
const kinds = (r: AlignedWord[]): string[] => r.map((w) => `${w.text}|${w.match}`);

function expectWellFormed(r: AlignedWord[], words: number): void {
  expect(r).toHaveLength(words);
  let prevEnd = 0;
  for (const w of r) {
    expect(w.start).toBeGreaterThanOrEqual(prevEnd);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    expect(Number.isFinite(w.confidence)).toBe(true);
    expect(w.confidence).toBeGreaterThanOrEqual(0);
    expect(w.confidence).toBeLessThanOrEqual(1);
    expect(Math.round(w.start * 1000) / 1000).toBe(w.start);
    prevEnd = w.end;
  }
}

interface Case { name: string; text: string; timing: string; lang?: string; expected: string[] }

const CASES: Case[] = [
  { name: 'punctuation and casing', text: 'Hello, everyone. Welcome back!', timing: 'hello everyone welcome back',
    expected: ['Hello,|exact', 'everyone.|exact', 'Welcome|exact', 'back!|exact'] },
  { name: 'merge: CarCover ↔ car cover', text: 'With CarCover today', timing: 'with car cover today',
    expected: ['With|exact', 'CarCover|merge', 'today|exact'] },
  { name: 'split: car cover ↔ CarCover', text: 'the car cover is', timing: 'the CarCover is',
    expected: ['the|exact', 'car|split', 'cover|split', 'is|exact'] },
  { name: 'Dutch compound merge', text: 'uw autoverzekering vandaag', timing: 'uw auto verzekering vandaag', lang: 'nl',
    expected: ['uw|exact', 'autoverzekering|merge', 'vandaag|exact'] },
  { name: 'Dutch compound split', text: 'uw auto verzekering vandaag', timing: 'uw autoverzekering vandaag', lang: 'nl',
    expected: ['uw|exact', 'auto|split', 'verzekering|split', 'vandaag|exact'] },
  { name: 'number words ↔ digits', text: 'one in five drivers', timing: '1 in 5 drivers',
    expected: ['one|exact', 'in|exact', 'five|exact', 'drivers|exact'] },
  { name: 'currency symbol ↔ words', text: 'for just €12 a month.', timing: 'for just twelve euros a month',
    expected: ['for|exact', 'just|exact', '€12|merge', 'a|exact', 'month.|exact'] },
  { name: 'currency code ↔ symbol', text: 'costs EUR 12 now', timing: 'costs €12 now',
    expected: ['costs|exact', 'EUR|split', '12|split', 'now|exact'] },
  { name: 'Dutch number words ↔ digits, same word count', text: 'voor maar twaalf euro per maand', timing: 'voor maar 12 euro per maand', lang: 'nl',
    expected: ['voor|exact', 'maar|exact', 'twaalf|exact', 'euro|exact', 'per|exact', 'maand|exact'] },
  { name: 'Dutch compound number + percent', text: 'eenentwintig procent', timing: '21%', lang: 'nl',
    expected: ['eenentwintig|split', 'procent|split'] },
  { name: 'percent words ↔ digits', text: 'about 20 percent', timing: 'about twenty per cent',
    expected: ['about|exact', '20|split', 'percent|split'] },
  { name: 'large numbers', text: '1,000,000 users', timing: 'one million users',
    expected: ['1,000,000|merge', 'users|exact'] },
  { name: 'ordinals en', text: 'the 1st time', timing: 'the first time',
    expected: ['the|exact', '1st|exact', 'time|exact'] },
  { name: 'ordinals nl', text: 'de 3e keer', timing: 'de derde keer', lang: 'nl',
    expected: ['de|exact', '3e|exact', 'keer|exact'] },
  { name: 'contraction ↔ full form', text: "you're insured", timing: 'you are insured',
    expected: ["you're|merge", 'insured|exact'] },
  { name: 'full form ↔ contraction', text: 'do not worry', timing: "don't worry",
    expected: ['do|split', 'not|split', 'worry|exact'] },
  { name: 'Dutch clitics', text: "'t is m'n auto", timing: 'het is mijn auto', lang: 'nl',
    expected: ["'t|exact", 'is|exact', "m'n|exact", 'auto|exact'] },
  { name: 'hyphens', text: 'Drive worry-free.', timing: 'drive worry free',
    expected: ['Drive|exact', 'worry-free.|merge'] },
  { name: 'accents', text: 'café crème', timing: 'cafe creme',
    expected: ['café|exact', 'crème|exact'] },
  { name: 'fillers only in timing', text: 'so we can', timing: 'so uh we um can',
    expected: ['so|exact', 'we|exact', 'can|exact'] },
  { name: 'stutter only in timing', text: 'the car', timing: 'the the car',
    expected: ['the|exact', 'car|exact'] },
  { name: 'stutter only in text', text: 'I I think', timing: 'I think',
    expected: ['I|interpolated', 'I|exact', 'think|exact'] },
  { name: 'word missing in text', text: 'hello world', timing: 'hello big world',
    expected: ['hello|exact', 'world|exact'] },
  { name: 'word missing in timing', text: 'hello big world', timing: 'hello world',
    expected: ['hello|exact', 'big|interpolated', 'world|exact'] },
  { name: 'misheard brand (fuzzy)', text: 'from Lumora today', timing: 'from Lamora today',
    expected: ['from|exact', 'Lumora|fuzzy', 'today|exact'] },
  { name: 'long disagreeing stretch, equal length', text: 'alpha beta gamma delta epsilon zeta', timing: 'alpha qqq www rrr ttt zeta',
    expected: ['alpha|exact', 'beta|fuzzy', 'gamma|fuzzy', 'delta|fuzzy', 'epsilon|fuzzy', 'zeta|exact'] },
  { name: 'long disagreeing stretch, unequal length', text: 'alpha beta gamma delta epsilon zeta', timing: 'alpha qqq www zeta',
    expected: ['alpha|exact', 'beta|fuzzy', 'gamma|fuzzy', 'delta|fuzzy', 'epsilon|fuzzy', 'zeta|exact'] },
  { name: 'unknown language: digits only', text: 'zwölf Äpfel', timing: 'zwolf apfel', lang: 'de',
    expected: ['zwölf|exact', 'Äpfel|exact'] },
];

describe('alignWords — edge cases', () => {
  it.each(CASES)('$name', ({ text, timing, lang, expected }) => {
    const r = run(text, az(timing), lang ?? 'en');
    expect(kinds(r)).toEqual(expected);
    expectWellFormed(r, expected.length);
  });
});

describe('alignWords — a number longer than a double holds', () => {
  it('times it (it used to loop forever: "9" × 309 is Infinity)', () => {
    const huge = '9'.repeat(309);
    const r = alignWords(['the', 'code', huge, 'ends'], az('the code ends', { step: 1 }), { language: 'en', duration: 4 });
    expect(r.map((w) => w.text)).toEqual(['the', 'code', huge, 'ends']);
    expectWellFormed(r, 4);
  });
});

describe('alignWords — timing details', () => {
  it('copies exact timings and speakers', () => {
    const r = run('Hello world', az('hello world', { speakers: ['S1', 'S2'] }));
    expect(r).toEqual([
      { text: 'Hello', start: 0, end: 0.4, speaker: 'S1', match: 'exact', confidence: 1, heard: { text: 'hello', first: 0, last: 0 } },
      { text: 'world', start: 0.5, end: 0.9, speaker: 'S2', match: 'exact', confidence: 1, heard: { text: 'world', first: 1, last: 1 } },
    ]);
  });

  it('a merged word spans all its timing words', () => {
    const r = run('With CarCover today', az('with car cover today'));
    expect(r[1]).toMatchObject({ start: 0.5, end: 1.4 });
  });

  it('a split timing word is shared proportionally to character length', () => {
    const r = run('the car cover is', az('the CarCover is', { step: 1, dur: 0.8 }));
    // "car" (3 chars) and "cover" (5 chars) share 1.0–1.8
    expect(r[1]).toMatchObject({ start: 1, end: 1.3 });
    expect(r[2]).toMatchObject({ start: 1.3, end: 1.8 });
  });

  it('interpolates a missing word inside the gap between neighbours', () => {
    const r = run('hello big world', az('hello world', { step: 1, dur: 0.5 }));
    expect(r[1].start).toBeGreaterThanOrEqual(0.5);
    expect(r[1].end).toBeLessThanOrEqual(1);
    expect(r[1].confidence).toBe(0);
    expect(r[1].speaker).toBe('S1');
  });

  it('borrows time from neighbours when the gap is too small', () => {
    const r = run('hello big world', az('hello world', { step: 0.4, dur: 0.4 }));
    expect(r[1].end - r[1].start).toBeGreaterThanOrEqual(0.099);
    expectWellFormed(r, 3);
  });

  it('interpolates words at the start and end', () => {
    const r = run('Well hello world indeed', az('hello world', { start: 1 }));
    expect(kinds(r)).toEqual(['Well|interpolated', 'hello|exact', 'world|exact', 'indeed|interpolated']);
    expect(r[0].end).toBeLessThanOrEqual(1);
    expect(r[3].start).toBeGreaterThanOrEqual(1.9);
    expectWellFormed(r, 4);
  });

  it('repair windows stay inside the disagreeing timing span', () => {
    const r = run('alpha beta gamma delta epsilon zeta', az('alpha qqq www zeta', { step: 1, dur: 0.9 }));
    for (const w of r.slice(1, 5)) {
      expect(w.start).toBeGreaterThanOrEqual(1);
      expect(w.end).toBeLessThanOrEqual(2.9);
    }
    expect(r[1].confidence).toBeLessThan(0.5);
  });

  it('keeps the timing speaker for a speaker change mid-sentence', () => {
    const r = run('I think so. Yes indeed.', az('I think so yes indeed', { speakers: ['S1', 'S1', 'S1', 'S1', 'S2'] }));
    expect(r.map((w) => w.speaker)).toEqual(['S1', 'S1', 'S1', 'S1', 'S2']);
  });

  it('handles overlapping speech (timing words out of text order)', () => {
    const timed: TimedWord[] = [
      ...az('we should go now', { speakers: 'S1' }),
      { text: 'yeah', start: 0.7, end: 0.9, speaker: 'S2' },
    ];
    const r = run('We should go now. Yeah.', timed);
    expectWellFormed(r, 5);
    expect(r.slice(0, 4).every((w) => w.match === 'exact')).toBe(true);
    expect(r[4].start).toBeGreaterThanOrEqual(r[3].end);
  });

  it('handles empty inputs', () => {
    expect(alignWords([], az('hello world'))).toEqual([]);
    expect(alignWords([], [])).toEqual([]);
    const r = alignWords(['hello', 'world'], [], { duration: 2 });
    expect(kinds(r)).toEqual(['hello|interpolated', 'world|interpolated']);
    expect(r[0].start).toBe(0);
    expect(r[1].end).toBe(2);
  });

  it('aligns the sample script against a noisy timing transcript', () => {
    const text =
      'Every year, one in five drivers has some kind of car damage. With DriveCover from Lumora, you’re insured from day one, for just €12 a month. And the best part? You can claim directly in the app. So remember: DriveCover. Drive worry-free.';
    const timing =
      'every year um one in 5 drivers has some kind of car damage with drive cover from lamora you are insured from day 1 for just twelve euros a month and the best part you can claim directly in the app so remember drive cover drive worry free';
    const r = run(text, az(timing));
    expectWellFormed(r, tokenizeDisplay(text).length);
    const by = (t: string) => r.filter((w) => w.text.replace(/[.,]$/, '') === t).map((w) => w.match);
    expect(by('DriveCover')).toEqual(['merge', 'merge']);
    expect(by('Lumora')).toEqual(['fuzzy']);
    expect(by('€12')).toEqual(['merge']);
    expect(by('you’re')).toEqual(['merge']);
    expect(r.filter((w) => w.match === 'interpolated')).toEqual([]);
  });
});

describe('banded DP', () => {
  it('gives the same result as the full matrix on long, drifting input', () => {
    const vocab = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'black', 'white', 'orange', 'purple', 'pink', 'brown'];
    const A = Array.from({ length: 400 }, (_, i) => ({ key: `${vocab[(i * 7) % vocab.length]}${i % 13}`, filler: false }));
    const B = A.filter((_, i) => i % 9 !== 4).flatMap((u, i) => (i % 25 === 3 ? [u, { key: 'uh', filler: true }, { key: 'extra', filler: false }] : [u]));
    const narrow = alignUnits(A, B, { band: 4 });
    const full = alignUnits(A, B, { band: 10_000 });
    expect(narrow).toEqual(full);
  });

  it('aligns an hour-sized input in reasonable time', () => {
    const words = Array.from({ length: 9000 }, (_, i) => `word${i % 500}x${i % 7}`);
    const timed = words.map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3, speaker: 'S1' }));
    const t0 = Date.now();
    const r = alignWords(words, timed, { language: 'en' });
    expect(r.every((w) => w.match === 'exact')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe('splitSpan', () => {
  it('splits proportionally and ends exactly at the end', () => {
    expect(splitSpan(0, 1, [1, 3])).toEqual([[0, 0.25], [0.25, 1]]);
    expect(splitSpan(2, 2, [1])).toEqual([[2, 2]]);
  });
});

describe('alignWords — what the timing side heard (the edit guards\' second witness)', () => {
  it('records the timing words of each anchor', () => {
    const r = run('we hear a door slam now', az('we hear a de slam now'));
    expect(r[3]).toMatchObject({ text: 'door', match: 'fuzzy', heard: { text: 'de', first: 3, last: 3 } });
    expect(r[4].heard).toEqual({ text: 'slam', first: 4, last: 4 });
  });

  it('gives a merged word all its timing words', () => {
    const r = run('With CarCover today', az('with car cover today'));
    expect(r[1].heard).toEqual({ text: 'car cover', first: 1, last: 2 });
  });

  it('gives split words the same timing range, so a span lists it once', () => {
    const r = run('the car cover is', az('the CarCover is'));
    expect(r[1].heard).toEqual({ text: 'CarCover', first: 1, last: 1 });
    expect(r[2].heard).toEqual(r[1].heard);
  });

  it('pairs a repair window word for word, and by time when the counts differ', () => {
    const r = run('hello Oliver Sacks wrote this', az('hello al over sex wrote this'));
    expect(r[2]).toMatchObject({ text: 'Sacks', heard: { text: 'sex' } });
    const t = run('one two three four five six', az('one two zork five six').map((w, k) => ({ ...w, start: [0, 0.4, 2, 4, 4.4][k], end: [0.3, 0.7, 2.2, 4.3, 4.7][k] })));
    expect(t.slice(2, 4).map((w) => [w.text, w.heard?.text])).toEqual([['three', 'zork'], ['four', undefined]]);
  });

  it('heard nothing where the timing side is empty', () => {
    expect(run('hello world', []).map((w) => w.heard)).toEqual([undefined, undefined]);
  });

  it('gives interpolated words the unused timing words between their neighbours', () => {
    const timed: TimedWord[] = [
      { text: 'hello', start: 0, end: 0.4 }, { text: 'big', start: 1, end: 1.3 }, { text: 'bag', start: 1.4, end: 1.6 }, { text: 'world', start: 3, end: 3.4 },
    ];
    const result = [
      { start: 0, end: 0.4, speaker: 'S1', match: 'exact' as const, confidence: 1 },
      { start: 0.9, end: 1.5, speaker: 'S1', match: 'interpolated' as const, confidence: 0 },
      { start: 1.5, end: 2, speaker: 'S1', match: 'interpolated' as const, confidence: 0 },
      { start: 3, end: 3.4, speaker: 'S1', match: 'exact' as const, confidence: 1 },
    ];
    const heardBy: Array<readonly number[] | null> = [[0], null, null, [3]];
    hearGaps(timed, result, heardBy);
    expect(heardBy).toEqual([[0], [1, 2], [1, 2], [3]]);
  });
});

describe('alignWords — unknown words between two speakers (fill.ts)', () => {
  it(`"I'm sorry. Do the ad lib.": the unknown "Do" is said by the speaker of "the ad lib."`, () => {
    const t = ["I'm", 'sorry.', 'Do', 'the', 'ad', 'lib.'];
    const heard: TimedWord[] = [
      { text: "I'm", start: 407.41, end: 407.7, speaker: 'S10' }, { text: 'sorry.', start: 407.7, end: 408.26, speaker: 'S10' },
      { text: 'the', start: 410.34, end: 410.58, speaker: 'S7' }, { text: 'ad', start: 410.58, end: 410.7, speaker: 'S7' }, { text: 'lib.', start: 410.7, end: 410.94, speaker: 'S7' },
    ];
    const out = alignWords(t, heard, { language: 'en', duration: 420 });
    expect(out[2]).toMatchObject({ text: 'Do', match: 'interpolated', speaker: 'S7' });
    // without a stronger break on either side the run keeps the speaker before it
    const flat = alignWords(['yes', 'and', 'no'], [{ text: 'yes', start: 0, end: 0.3, speaker: 'A' }, { text: 'no', start: 2, end: 2.3, speaker: 'B' }], { language: 'en', duration: 5 });
    expect(flat[1]).toMatchObject({ match: 'interpolated', speaker: 'A' });
  });
});
