import { describe, expect, it } from 'vitest';
import { isFiller } from '../src/lang/index.js';
import { normalizeWords, numericKeys, tokenizeDisplay } from '../src/text/normalize.js';
import { parseDigits, parseNumberAt } from '../src/text/numbers.js';

type L = 'en' | 'nl' | 'other';
const keys = (text: string, lang: L = 'en') => normalizeWords(tokenizeDisplay(text), lang).map((w) => (w.cont ? '<cont>' : w.key));

describe('clause boundaries stop number phrases', () => {
  it.each([
    ['We had thirty, one of them broke.', 'en', ['we', 'had', '30', '1', 'of', 'them', 'broke']],
    ['There were twenty. One of them left.', 'en', ['there', 'were', '20', '1', 'of', 'them', 'left']],
    ['a hundred, five more', 'en', ['100', '<cont>', '5', 'more']],
    ['page 12, million thanks', 'en', ['page', '12', 'million', 'thanks']],
    ['I paid 12. Euros are weird.', 'en', ['i', 'paid', '12', 'euros', 'are', 'weird']],
    ['Twee. Miljoen mensen', 'nl', ['2', 'miljoen', 'mensen']],
    ['"thirty," one', 'en', ['30', '1']],
  ] as const)('%j (%s)', (text, lang, expected) => {
    expect(keys(text, lang)).toEqual(expected);
  });

  it('does not treat punctuation inside a token as a boundary', () => {
    expect(keys('1,000,000 users')).toEqual(['1000000', 'users']);
    expect(keys('€12,50 a month', 'nl')).toEqual(['12.5 eur', 'a', 'month']);
  });
});

describe('standalone symbols keep the caption text intact', () => {
  it.each([
    ['Johnson & Johnson', ['Johnson &', 'Johnson']],
    ['5 + 5', ['5 +', '5']],
    ['yes / no', ['yes /', 'no']],
    ['great 🎉 news', ['great 🎉', 'news']],
    ['A → B', ['A →', 'B']],
    ['& more', ['& more']],
    ['wow !', ['wow!']],
    ['( aside ) ok', ['(aside)', 'ok']],
  ])('%j', (input, expected) => {
    expect(tokenizeDisplay(input)).toEqual(expected);
  });

  it('never produces tokens without letters or digits', () => {
    for (const t of ['• item', 'a — b', '— — x', 'x ✓ ✓', '& &']) {
      for (const tok of tokenizeDisplay(t)) expect(tok).toMatch(/[\p{L}\p{N}]/u);
    }
  });

  it('gives & and + a spoken key without changing the display', () => {
    expect(keys('Johnson & Johnson')).toEqual(['johnson and', 'johnson']);
    expect(keys('Q & A', 'nl')).toEqual(['q en', 'a']);
    expect(keys('5 + 5')).toEqual(['5 plus', '5']);
    expect(keys('5+5')).toEqual(['5 plus 5']);
    expect(keys('+31 6 12', 'nl')).toEqual(['31', '6', '12']);
    expect(keys('yes / no')).toEqual(['yes', 'no']);
  });
});

describe('Dutch numbers', () => {
  it.each([
    ['een miljoen euro', ['1000000 eur', '<cont>', '<cont>']],
    ['een miljard', ['1000000000', '<cont>']],
    ['een half miljoen', ['500000', '<cont>', '<cont>']],
    ['Eén miljoen', ['1000000', '<cont>']],
    ['Eén van hen', ['1', 'van', 'hen']],
    ['éen', ['1']],
    ['een auto', ['een', 'auto']],
    ['twee duizend euro', ['2000 eur', '<cont>', '<cont>']],
    ['vijf honderd', ['500', '<cont>']],
    ['negentienhonderd', ['1900']],
    ['negentienhonderdnegentig', ['1990']],
    ['honderd duizend', ['100000', '<cont>']],
  ])('%j', (text, expected) => {
    expect(keys(text, 'nl')).toEqual(expected);
  });

  it('keeps the existing split-number rules', () => {
    expect(parseNumberAt(['tweeduizend', 'miljoen'], 0, 'nl')).toEqual({ value: 2000, ordinal: false, length: 1 });
    expect(parseNumberAt(['twee', 'miljoen'], 0, 'nl')).toEqual({ value: 2_000_000, ordinal: false, length: 2 });
  });
});

describe('decimals in the other language style', () => {
  it.each([
    ['€12.50', 'nl', ['12.5 eur']],
    ['€12,50', 'en', ['12.5 eur']],
    ['12,50 euros', 'en', ['12.5 eur', '<cont>']],
    ['1.500', 'nl', ['1500']],
    ['1,000', 'en', ['1000']],
  ] as const)('%j (%s)', (text, lang, expected) => {
    expect(keys(text, lang)).toEqual(expected);
  });
  it('rejects ambiguous groupings', () => {
    expect(parseDigits('1,5,5', 'en')).toBeNull();
    expect(parseDigits('12,5000', 'en')).toBeNull();
  });
});

describe('fillers per language', () => {
  it.each([
    ['uhhh', 'en', true], ['Ummm', 'en', true], ['hmmm', 'en', true], ['mmm', 'en', true], ['er', 'en', true],
    ['Ehhh', 'nl', true], ['Euhm', 'nl', true], ['um', 'nl', true],
    ['er', 'nl', false], ['er is', 'nl', false],
    ['um', 'other', false], ['er', 'other', false], ['uh', 'other', true],
  ] as const)('%j (%s)', (text, lang, expected) => {
    const [first] = normalizeWords(tokenizeDisplay(text), lang);
    expect(first.filler).toBe(expected);
  });
  it('does not flag real words', () => {
    for (const w of ['her', 'hum', 'mum', 'ah-ha', 'error']) expect(isFiller(w, 'en')).toBe(false);
  });
});

describe('leading zeros stay digit strings', () => {
  it.each([
    ['06-12345678', 'nl', ['06 12345678']],
    ['020', 'nl', ['020']],
    ['007', 'en', ['007']],
    ['12', 'en', ['12']],
    ['0.5', 'en', ['0.5']],
  ] as const)('%j (%s)', (text, lang, expected) => {
    expect(keys(text, lang)).toEqual(expected);
  });
});

describe('vulgar fractions', () => {
  it.each([['1½', ['1.5']], ['½', ['0.5']], ['¾ more', ['0.75', 'more']]])('%j', (text, expected) => {
    expect(keys(text)).toEqual(expected);
  });
  it('works in Dutch with a scale word', () => {
    expect(keys('1½ miljoen', 'nl')).toEqual(['1500000', '<cont>']);
  });
});

describe('clock times', () => {
  it.each([
    ['10:30', 'en', ['10:30']],
    ['10:30', 'nl', ['10:30']],
    ['9:05', 'en', ['9:05']],
    ['10.30 uur', 'nl', ['10:30', 'uur']],
    ['om 10.30', 'nl', ['om', '10:30']],
    ['12.50 euro', 'nl', ['12.5 eur', '<cont>']],
  ] as const)('%j (%s)', (text, lang, expected) => {
    expect(keys(text, lang)).toEqual(expected);
  });
  it('counts times as numeric content', () => {
    expect(numericKeys('at 10:30', 'en')).toEqual(['10:30']);
  });
});

describe('Object.prototype names are ordinary words', () => {
  it('does not treat them as numbers, currencies or contractions', () => {
    expect(keys('constructor toString valueOf')).toEqual(['constructor', 'tostring', 'valueof']);
    expect(keys('constructor', 'nl')).toEqual(['constructor']);
  });
});

describe('Dutch remainders after a scale word', () => {
  it.each([
    ['drie miljoen tweehonderdduizend', ['3200000', '<cont>', '<cont>']],
    ['twee miljoen vijfhonderdduizend euro', ['2500000 eur', '<cont>', '<cont>', '<cont>']],
    ['twee miljard driehonderd miljoen', ['2300000000', '<cont>', '<cont>', '<cont>']],
    ['twee duizend vierentwintig', ['2024', '<cont>', '<cont>']],
    ['tweeduizend vierentwintig', ['2024', '<cont>']],
    ['honderd twintig', ['120', '<cont>']],
    ['twee duizend vijf honderd', ['2500', '<cont>', '<cont>', '<cont>']],
    ['een honderd', ['100', '<cont>']],
    ['tweeduizend miljoen', ['2000', 'miljoen']],
    ['twee miljoen', ['2000000', '<cont>']],
  ] as const)('%j', (text, expected) => {
    expect(keys(text, 'nl')).toEqual(expected);
  });
  it('keeps English scale phrases', () => {
    expect(keys('two million five hundred thousand')).toEqual(['2500000', '<cont>', '<cont>', '<cont>', '<cont>']);
  });
});

describe('filler pattern edge cases', () => {
  it('requires two letters for the drawn-out pattern', () => {
    for (const w of ['m', 'M.', 'h']) expect(normalizeWords(tokenizeDisplay(w), 'en')[0].filler).toBe(false);
    expect(keys('100 m')).toEqual(['100', 'm']);
    for (const w of ['mm', 'mmm', 'hmmm']) expect(normalizeWords([w], 'en')[0].filler).toBe(true);
  });
});

describe('fraction decimals are not clock times', () => {
  it('2¼ uur is 2.25, 2.25 uur is a time', () => {
    expect(keys('2¼ uur', 'nl')).toEqual(['2.25', 'uur']);
    expect(keys('2.25 uur', 'nl')).toEqual(['2:25', 'uur']);
  });
});
