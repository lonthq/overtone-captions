import { describe, expect, it } from 'vitest';
import { lineLength } from '../src/segment/splitter.js';
import { displayLength } from '../src/text/length.js';

describe('displayLength', () => {
  it('counts the characters a reader sees, not UTF-16 code units', () => {
    expect(displayLength('Every year, one in five')).toBe(23);
    expect(displayLength('café')).toBe(4);
    expect(displayLength('café')).toBe(4); // e + combining accent
    expect(displayLength('👍🏽')).toBe(1); // emoji with a skin tone: 4 code units
    expect(displayLength('🇳🇱')).toBe(1);
    expect(displayLength('これはガラスです')).toBe(8);
    expect(displayLength('')).toBe(0);
  });

  it('is what the line cutter measures', () => {
    expect(lineLength(['👍🏽', 'café'], 0, 1)).toBe(6);
  });
});
