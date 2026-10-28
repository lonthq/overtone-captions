import { describe, expect, it } from 'vitest';
import { langOf } from '../src/lang/index.js';
import { parseDutchWord } from '../src/lang/number-words/nl.js';
import { normalizeText, normalizeWords, numericKeys, tokenizeDisplay } from '../src/text/normalize.js';
import { parseDigits, parseNumberAt } from '../src/text/numbers.js';
import { similarity } from '../src/text/similarity.js';

describe('tokenizeDisplay', () => {
  it.each([
    ['Hello, everyone.', ['Hello,', 'everyone.']],
    ['so — and then', ['so —', 'and', 'then']],
    ['He said “ hello ” today', ['He', 'said', '“hello”', 'today']],
    ['  spaced   out  ', ['spaced', 'out']],
    ['', []],
    ['… well', ['…well']],
    ['kost € 12 per maand', ['kost', '€12', 'per', 'maand']],
    ['12 € per maand', ['12€', 'per', 'maand']],
    ['12 % more', ['12%', 'more']],
  ])('%j', (input, expected) => {
    expect(tokenizeDisplay(input)).toEqual(expected);
  });
});

describe('langOf', () => {
  it('maps locales to language packs', () => {
    expect(langOf('en-US')).toBe('en');
    expect(langOf('nl')).toBe('nl');
    // German has a (detection-only) pack: its other rules are the neutral ones, exactly as 'other'
    expect(langOf('de-DE')).toBe('de');
    expect(langOf('sv-SE')).toBe('other');
    expect(langOf(undefined)).toBe('other');
  });
});

describe('numbers', () => {
  it.each([
    [['twenty', 'one'], 'en', 21, false, 2],
    [['a', 'hundred', 'and', 'five'], 'en', 105, false, 4],
    [['two', 'million'], 'en', 2_000_000, false, 2],
    [['nineteen', 'hundred'], 'en', 1900, false, 2],
    [['twenty', 'first'], 'en', 21, true, 2],
    [['one', 'two'], 'en', 1, false, 1],
    [['1.5', 'million'], 'en', 1_500_000, false, 2],
    [['twee', 'miljoen'], 'nl', 2_000_000, false, 2],
    [['drieentwintig'], 'nl', 23, false, 1],
    [['tweehonderdvijftig'], 'nl', 250, false, 1],
    [['tweeduizend', 'miljoen'], 'nl', 2000, false, 1],
  ] as const)('%j (%s) → %d', (pieces, lang, value, ordinal, length) => {
    expect(parseNumberAt(pieces, 0, lang)).toEqual({ value, ordinal, length });
  });

  it('rejects non-numbers', () => {
    expect(parseNumberAt(['a', 'month'], 0, 'en')).toBeNull();
    expect(parseNumberAt(['hello'], 0, 'en')).toBeNull();
    expect(parseNumberAt(['twelve'], 0, 'other')).toBeNull();
    expect(parseDutchWord('een')).toBeNull();
  });

  it.each([
    ['eerste', 1], ['derde', 3], ['vierde', 4], ['achtste', 8], ['twintigste', 20], ['honderdste', 100],
  ])('Dutch ordinal %s', (word, value) => {
    expect(parseDutchWord(word)).toEqual({ value, ordinal: true });
  });

  it.each([
    ['1,000,000', 'en', 1_000_000], ['1.5', 'en', 1.5], ['1.500', 'nl', 1500], ['12,50', 'nl', 12.5], ['1,000', 'other', 1000],
  ] as const)('digits %s (%s)', (piece, lang, value) => {
    expect(parseDigits(piece, lang)).toEqual({ value, ordinal: false });
  });
});

const keys = (text: string, lang: 'en' | 'nl' | 'other' = 'en') => normalizeWords(tokenizeDisplay(text), lang).map((w) => (w.cont ? '<cont>' : w.key));

describe('normalizeWords', () => {
  it.each([
    ['Hello, Everyone!', 'en', ['hello', 'everyone']],
    ['“Quoted” ‘words’', 'en', ['quoted', 'words']],
    ['café crème', 'en', ['cafe', 'creme']],
    ['worry-free', 'en', ['worry free']],
    ['don’t worry', 'en', ['do not', 'worry']],
    ["I'm sure you're right, it's fine", 'en', ['i am', 'sure', 'you are', 'right', 'it is', 'fine']],
    ["can't won't", 'en', ['can not', 'will not']],
    ["Maya's car", 'en', ['mayas', 'car']],
    ['one in five', 'en', ['1', 'in', '5']],
    ['for just €12 a month', 'en', ['for', 'just', '12 eur', 'a', 'month']],
    ['twelve euros', 'en', ['12 eur', '<cont>']],
    ['12 euros', 'en', ['12 eur', '<cont>']],
    ['EUR 12', 'en', ['12 eur', '<cont>']],
    ['$5 and £3', 'en', ['5 usd', 'and', '3 gbp']],
    ['20% or twenty per cent', 'en', ['20 percent', 'or', '20 percent', '<cont>', '<cont>']],
    ['the 1st and the first', 'en', ['the', '1th', 'and', 'the', '1th']],
    ['1,000,000 users', 'en', ['1000000', 'users']],
    ['one million users', 'en', ['1000000', '<cont>', 'users']],
    ["'t is m'n auto", 'nl', ['het', 'is', 'mijn', 'auto']],
    ["auto's", 'nl', ['autos']],
    ['twaalf euro per maand', 'nl', ['12 eur', '<cont>', 'per', 'maand']],
    ['kost € 12,50', 'nl', ['kost', '12.5 eur']],
    ['één op de vijf', 'nl', ['1', 'op', 'de', '5']],
    ['een auto', 'nl', ['een', 'auto']],
    ['eenentwintig procent', 'nl', ['21 percent', '<cont>']],
    ['de 3e keer, de derde keer', 'nl', ['de', '3th', 'keer', 'de', '3th', 'keer']],
    ['zwölf 12', 'other', ['zwolf', '12']],
  ] as const)('%j (%s)', (text, lang, expected) => {
    expect(keys(text, lang)).toEqual(expected);
  });

  it('marks fillers', () => {
    expect(normalizeWords(['so', 'uh,', 'Ehm', 'we'], 'en').map((w) => w.filler)).toEqual([false, true, true, false]);
  });
});

describe('normalizeText / numericKeys / similarity', () => {
  it('normalizes whole texts', () => {
    expect(normalizeText('With CarCover, you’re insured for €12 a month.', 'en')).toBe('with carcover you are insured for 12 eur a month');
  });
  it('extracts numeric content with units', () => {
    expect(numericKeys('twelve euros a month', 'en')).toEqual(['12', 'eur']);
    expect(numericKeys('€12 a month', 'en')).toEqual(['12', 'eur']);
    expect(numericKeys('one in five', 'en')).toEqual(['1', '5']);
    expect(numericKeys('no numbers here', 'en')).toEqual([]);
  });
  it('compares keys ignoring spaces', () => {
    expect(similarity('car cover', 'carcover')).toBe(1);
    expect(similarity('lumora', 'lamora')).toBeCloseTo(5 / 6);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });
});
