import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPhonetics, phrase, soundSimilarity, spellingSimilarity } from '../src/reconcile/phonetics.js';
import { findRegions, wordSimilarity, type TextWord } from '../src/reconcile/regions.js';
import { assessVote, soundsLike } from '../src/reconcile/vote.js';

// Scripts without letter-to-sound rules (Japanese, Chinese, Cyrillic, Greek) get no phonemes, so sound comparisons
// fall back to the spelling instead of counting every pair as the same.

describe('sound comparisons in scripts without letter-to-sound rules', () => {
  it('does not count different words as sounding the same', () => {
    expect(wordSimilarity('猫', '犬', 'ja')).toBe(0);
    expect(wordSimilarity('кот', 'пёс', 'ru')).toBeLessThan(0.5);
    expect(wordSimilarity('γάτα', 'σκύλος', 'el')).toBeLessThan(0.5);
    expect(soundsLike('犬が好きです', ['猫が嫌いです'], 'ja')).toBeLessThan(0.6);
  });

  it('still matches identical words and scores a one-letter difference in a long word in between', () => {
    expect(wordSimilarity('猫', '猫', 'ja')).toBe(1);
    expect(soundSimilarity('Москва', 'москва', 'ru').similarity).toBe(1);
    expect(soundsLike('犬が好きです', ['犬が好きです'], 'ja')).toBe(1);
    const near = wordSimilarity('достопримечательность', 'достопримечательнасть', 'ru');
    expect(near).toBeGreaterThan(0.9);
    expect(near).toBeLessThan(1);
  });

  it('treats two empty texts as the same, and compares grapheme by grapheme', () => {
    expect(spellingSimilarity('', '')).toBe(1);
    expect(spellingSimilarity('...', '!')).toBe(1);
    expect(spellingSimilarity('が', 'か')).toBe(0); // the voicing mark is part of the grapheme
  });

  it('lists a Japanese reading no engine heard for review', () => {
    const region = { id: 0, cls: 'c' as const, sub: 'insert-one-engine', first: 0, last: -1, start: 0, end: 1, text: '', heard: [], around: {} };
    const answer = { id: 0, decision: 'change' as const, basis: '', text: '今日は雨が降っています' };
    expect(assessVote(region, answer, { language: 'ja', engineText: ['猫が好きです'], relisten: '', showRelisten: true }).review).toMatch(/no engine heard it/);
    expect(assessVote(region, { ...answer, text: '猫が好きです' }, { language: 'ja', engineText: ['猫が好きです'], relisten: '', showRelisten: true })).toEqual({ why: null });
  });

  it('compares Cyrillic readings with what was heard', () => {
    const region = { id: 0, cls: 'c' as const, sub: '', first: 0, last: 1, start: 0, end: 1, text: 'Привет, Иван.', heard: [], around: {} };
    const answer = { id: 0, decision: 'change' as const, basis: '', text: 'Привет, Мария.' };
    expect(assessVote(region, answer, { language: 'ru', engineText: ['привет, мария'], relisten: '', showRelisten: true })).toEqual({ why: null });
    expect(assessVote(region, { ...answer, text: 'Спасибо большое.' }, { language: 'ru', engineText: ['привет, мария'], relisten: '', showRelisten: true }).review).toMatch(/no engine heard it/);
  });

  it('finds a replace region where the caption differs from two engines that agree', () => {
    const words = (texts: string[]) => texts.map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4, speaker: 'S1' }));
    const caption: TextWord[] = words(['Я', 'люблю', 'собак']).map(({ text, start, end }) => ({ text, start, end }));
    const engines = [
      { id: 'a', label: 'A', words: words(['Я', 'люблю', 'кошек']) },
      { id: 'b', label: 'B', words: words(['Я', 'люблю', 'кошек']) },
    ];
    const regions = findRegions(caption, engines, { language: 'ru' });
    expect(regions.map((r) => [r.text, r.sub])).toEqual([['собак', 'replace']]);
  });

  it('keeps Latin-script comparisons phonetic', () => {
    expect(soundSimilarity('Thom', 'Tom', 'en').phonetic).toBe(true);
    expect(soundSimilarity('猫', 'cat', 'en').phonetic).toBe(false);
  });
});

describe('a local CMU dictionary with phonemes outside the inventory', () => {
  it('skips those entries when loading, so the distance never sees an unknown phoneme', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overtone-cmudict-'));
    const file = join(dir, 'cmudict.dict');
    writeFileSync(file, 'cat K AE1 T\nspn SPN\nhmm HH M SIL\n');
    await loadPhonetics({ env: { OVERTONE_CMUDICT: file } });
    expect(phrase('cat', 'en').phones).toEqual(['K', 'AE', 'T']);
    expect(phrase('spn', 'en').phones).not.toContain('SPN'); // letter-to-sound rules instead
    expect(phrase('hmm', 'en').phones).not.toContain('SIL');
    expect(() => soundSimilarity('spn hmm', 'skin', 'en')).not.toThrow();
  });
});

describe('vowel signs in Indic scripts', () => {
  it('keeps "में" (in) and "मैं" (I) apart: their vowel signs are combining marks', () => {
    expect(wordSimilarity('में', 'मैं', 'hi')).toBeLessThan(1);
    expect(wordSimilarity('मैं', 'मैं', 'hi')).toBe(1);
    // Latin accents still count as letters after NFC, decomposed or not
    expect(wordSimilarity('cafe\u0301', 'café', 'fr')).toBe(1);
  });
});
