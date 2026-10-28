import { describe, expect, it } from 'vitest';
import { numericReadings, sameNumbers } from '../src/text/normalize.js';

describe('"twenty-second" has two readings: the ordinal 22nd and 20 seconds', () => {
  it('gives both readings, and one for unambiguous numbers', () => {
    expect(numericReadings('a twenty-second clip', 'en')).toEqual([['22th'], ['20']]);
    expect(numericReadings('the 22nd of May', 'en')).toEqual([['22th']]);
    expect(numericReadings('a 20-second clip', 'en')).toEqual([['20']]);
    expect(sameNumbers('twenty-second', '22nd', 'en')).toBe(true);
    expect(sameNumbers('twenty-second', '20-second', 'en')).toBe(true);
    expect(sameNumbers('twenty-second', '21st', 'en')).toBe(false);
    expect(sameNumbers('twenty-second', '30-second', 'en')).toBe(false);
  });

});
