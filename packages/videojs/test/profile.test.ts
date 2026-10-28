import { describe, expect, it } from 'vitest';
import { chooseProfile } from '../src/core/profile';
import { isInWindow } from '../src/core/window';
import { loadFixture } from './helpers';

describe('chooseProfile', () => {
  it('picks the profile closest to the picture shape in auto mode', () => {
    const doc = loadFixture();
    expect(chooseProfile(doc, 'auto', { width: 640, height: 360 })?.id).toBe('horizontal');
    expect(chooseProfile(doc, 'auto', { width: 360, height: 640 })?.id).toBe('vertical');
    expect(chooseProfile(doc, 'auto', { width: 500, height: 500 })?.id).toBe('horizontal');
  });

  it('treats an unknown size as wide', () => {
    expect(chooseProfile(loadFixture(), 'auto', { width: 0, height: 0 })?.id).toBe('horizontal');
  });

  it('returns a named profile regardless of shape', () => {
    expect(chooseProfile(loadFixture(), 'horizontal', { width: 360, height: 640 })?.id).toBe('horizontal');
  });

  it('selects by shape when the named profile is missing', () => {
    const doc = loadFixture();
    expect(chooseProfile(doc, 'square', { width: 360, height: 640 })?.id).toBe('vertical');
  });

  it('returns undefined for a document without profiles', () => {
    const doc = loadFixture();
    doc.profiles = [];
    expect(chooseProfile(doc, 'auto', { width: 640, height: 360 })).toBeUndefined();
  });
});

describe('isInWindow', () => {
  const rules = { maxCharsPerLine: 42, maxLines: 2 };
  const profile = { id: 'p', aspect: '16:9', rules, cues: [], window: { start: 2, end: 10 } };

  it('is always true without a window', () => {
    expect(isInWindow({ id: 'p', aspect: '16:9', rules, cues: [] }, 0)).toBe(true);
    expect(isInWindow({ id: 'p', aspect: '16:9', rules, cues: [] }, 1e6)).toBe(true);
  });

  it('includes the start and excludes the end', () => {
    expect(isInWindow(profile, 1.999)).toBe(false);
    expect(isInWindow(profile, 2)).toBe(true);
    expect(isInWindow(profile, 9.999)).toBe(true);
    expect(isInWindow(profile, 10)).toBe(false);
  });
});
