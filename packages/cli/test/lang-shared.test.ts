import { describe, expect, it } from 'vitest';
import { ordinalPattern, SHARED } from '../src/lang/index.js';
import { numericKeys } from '../src/text/normalize.js';

describe('number units and ordinals from the packs', () => {
  it('treats every currency code of the packs as a number unit, so no list is kept by hand', () => {
    for (const code of Object.values(SHARED.currency)) expect(SHARED.numberUnits.has(code)).toBe(true);
    expect(SHARED.numberUnits.has('percent')).toBe(true);
    expect(numericKeys('it costs 12 euros, or 5 percent', 'en')).toEqual(['12', 'eur', '5', 'percent']);
  });

  it('makes no number an ordinal for a language without ordinal suffixes', () => {
    expect(ordinalPattern([]).test('12')).toBe(false);
    expect(ordinalPattern(['st', 'nd', 'rd', 'th']).exec('21st')?.[1]).toBe('21');
    expect(ordinalPattern(['st']).test('12')).toBe(false);
  });
});
