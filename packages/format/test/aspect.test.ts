import { describe, expect, it } from 'vitest';
import { closestProfile, parseAspect } from '../src/aspect';

describe('parseAspect', () => {
  it('reads "W:H" as W / H', () => {
    expect(parseAspect('16:9')).toBeCloseTo(16 / 9, 12);
    expect(parseAspect('9:16')).toBeCloseTo(9 / 16, 12);
    expect(parseAspect('1:1')).toBe(1);
  });

  it('rejects anything but two positive integers without leading zeros', () => {
    for (const bad of ['0:1', '1:0', '16/9', '1.5:1', '01:1', ' 1:1', '1:1 ', '', '-1:1']) {
      expect(() => parseAspect(bad), bad).toThrow(/W:H/);
    }
  });
});

describe('closestProfile', () => {
  const wide = { id: 'horizontal', aspect: '16:9' };
  const square = { id: '1x1', aspect: '1:1' };
  const tall = { id: 'vertical', aspect: '9:16' };
  const all = [wide, tall, square];

  it('picks the profile with the closest aspect on a log scale', () => {
    expect(closestProfile(all, 16 / 9)).toBe(wide);
    expect(closestProfile(all, 1)).toBe(square);
    expect(closestProfile(all, 4 / 5)).toBe(square);
    expect(closestProfile(all, 9 / 16)).toBe(tall);
    expect(closestProfile(all, 21 / 9)).toBe(wide);
    expect(closestProfile([wide, tall], 1)).toBe(wide); // equal distance: the wider one
  });

  it('breaks the exact 4:3 tie between 1:1 and 16:9 toward the wider profile', () => {
    expect(closestProfile(all, 4 / 3)).toBe(wide);
    expect(closestProfile([square, wide], 4 / 3)).toBe(wide);
  });

  it('keeps document order between equal aspects', () => {
    const a = { id: 'a', aspect: '1:1' };
    const b = { id: 'b', aspect: '1:1' };
    expect(closestProfile([a, b], 1)).toBe(a);
    expect(closestProfile([b, a], 1)).toBe(b);
  });

  it('treats an unknown picture shape (NaN, 0, negative, Infinity) as 16:9', () => {
    for (const bad of [NaN, 0, -1, Infinity, -Infinity]) {
      expect(closestProfile([tall, wide], bad), String(bad)).toBe(wide);
      expect(closestProfile([wide, tall], bad), String(bad)).toBe(wide);
    }
  });

  it('returns undefined without profiles', () => {
    expect(closestProfile([], 1)).toBeUndefined();
  });
});
