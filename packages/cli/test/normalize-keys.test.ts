import { describe, expect, it } from 'vitest';
import { normalizeText, numericKeys } from '../src/text/normalize.js';

// The comparison keys alignment and the text vote compare (text/normalize.ts): numbers keep their sign, digits of every
// script and superscripts are read as numbers, and only Latin, Greek and Cyrillic accents are folded.

describe('numbers in the comparison keys', () => {
  it('numericKeys keeps a written sign', () => {
    expect(numericKeys('it is -5 degrees', 'en')).toEqual(['-5']);
    expect(numericKeys('it is −5 degrees', 'en')).toEqual(['-5']);
    expect(numericKeys('+5 points', 'en')).toEqual(['+5']);
    expect(numericKeys('down -3%', 'en')).toEqual(['-3', 'percent']);
    expect(numericKeys('-€12 refund', 'en')).toEqual(['-12', 'eur']);
    expect(numericKeys('(-5)', 'en')).toEqual(['-5']);
    // a dash between numbers or words is no sign
    expect(numericKeys('5-3 win', 'en')).toEqual(['5', '3']);
    expect(numericKeys('COVID-19 cases', 'en')).toEqual(['19']);
    expect(numericKeys('- 5 items', 'en')).toEqual(['5']);
  });

  it('reads digits of every script and superscripts as numbers', () => {
    expect(numericKeys('about ३० people', 'hi')).toEqual(['30']);
    expect(numericKeys('a fee of EUR -12', 'en')).toEqual(['-12', 'eur']);
    expect(numericKeys('a 10⁶ factor', 'en')).toEqual(['10', '6']);
    expect(normalizeText('km² and m²', 'en')).toBe(normalizeText('km2 and m2', 'en'));
  });

  it('keeps the sign before digits of other scripts', () => {
    expect(numericKeys('-٣٠', 'ar')).toEqual(['-30']);
    expect(numericKeys('-٣٠', 'ar')).not.toEqual(numericKeys('٣٠', 'ar'));
    expect(numericKeys('−३०', 'hi')).toEqual(['-30']);
    expect(numericKeys('-€٣٠', 'ar')).toEqual(['-30', 'eur']);
    expect(numericKeys('+३०', 'hi')).toEqual(['+30']);
  });

  it('keeps the sign of superscript exponents', () => {
    expect(numericKeys('10⁻⁶', 'en')).toEqual(['10', '-6']);
    expect(numericKeys('10⁺⁶', 'en')).toEqual(['10', '+6']);
    expect(numericKeys('10₋₂', 'en')).toEqual(['10', '-2']);
    expect(numericKeys('10⁻⁶.', 'en')).toEqual(['10', '-6']);
    expect(numericKeys('10⁻⁶', 'en')).not.toEqual(numericKeys('106', 'en'));
    expect(numericKeys('10⁻⁶', 'en')).not.toEqual(numericKeys('10⁶', 'en'));
    expect(numericKeys('10⁶', 'en')).toEqual(['10', '6']);
    expect(normalizeText('10⁶ m²', 'en')).toBe('10 6 m2');
  });
});

describe('comparison keys keep the marks of scripts without accent folding', () => {
  it('keeps Devanagari vowel signs and Japanese voicing marks', () => {
    expect(normalizeText('में', 'hi')).not.toBe(normalizeText('मैं', 'hi'));
    // keys are NFKD: the marks stay, and Korean is compared by its jamo
    expect(normalizeText('में', 'hi')).toBe('में'.normalize('NFKD'));
    expect(normalizeText('かき', 'ja')).not.toBe(normalizeText('がき', 'ja'));
    expect(normalizeText('がき', 'ja')).toBe('がき'.normalize('NFKD'));
    expect(normalizeText('한국', 'ko')).toBe('한국'.normalize('NFKD'));
  });

  it('still folds Latin, Greek and Cyrillic accents', () => {
    expect(normalizeText('Café crème', 'fr')).toBe('cafe creme');
    expect(normalizeText('Één keer', 'nl')).toBe('1 keer');
    expect(normalizeText('een keer', 'nl')).toBe('een keer');
    expect(normalizeText('tôi múa', 'vi')).toBe('toi mua');
    expect(normalizeText('Αθήνα', 'el')).toBe('αθηνα');
    expect(normalizeText('йод', 'ru')).toBe('иод');
  });
});
