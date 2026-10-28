import { describe, expect, it } from 'vitest';
import { parseEnglishWords } from '../src/lang/number-words/en.js';
import { normalizeText } from '../src/text/normalize.js';

describe('English compound ordinals with "second"', () => {
  it('reads "second" as ordinal 2 right after a tens word', () => {
    expect(parseEnglishWords(['twenty', 'second'], 0)).toEqual({
      value: 22, ordinal: true, length: 2, alternative: { value: 20, ordinal: false, length: 1 },
    });
    expect(parseEnglishWords(['one', 'hundred', 'thirty', 'second'], 0)).toEqual({
      value: 132, ordinal: true, length: 4, alternative: { value: 130, ordinal: false, length: 3 },
    });
    expect(parseEnglishWords(['twenty', 'first'], 0)).toEqual({ value: 21, ordinal: true, length: 2 });
  });

  it('normalizes twenty-second, "twenty second" and 22nd the same', () => {
    const key = normalizeText('the 22nd of May', 'en');
    expect(normalizeText('the twenty-second of May', 'en')).toBe(key);
    expect(normalizeText('the twenty second of May', 'en')).toBe(key);
    expect(normalizeText('thirty-second', 'en')).toBe(normalizeText('32nd', 'en'));
  });

  it('keeps "second" a word on its own and after other number words', () => {
    expect(parseEnglishWords(['second'], 0)).toBeNull();
    expect(normalizeText('wait a second', 'en')).toBe('wait a second');
    // standalone "second" stays the word even before a date, since it is usually the time unit
    expect(normalizeText('the second of May', 'en')).toBe('the second of may');
    expect(normalizeText('ten seconds', 'en')).toBe('10 seconds');
    expect(normalizeText('twenty seconds', 'en')).toBe('20 seconds');
    expect(normalizeText('five second delay', 'en')).toBe('5 second delay');
  });
});
