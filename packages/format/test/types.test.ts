import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EditReason, MatchKind } from 'overtone-format';
import {
  DEFAULT_PROFILES,
  EDIT_REASONS,
  FORMAT_NAME,
  FORMAT_VERSION,
  MATCH_KINDS,
  STYLE_CLASSES,
} from 'overtone-format';

describe('format constants', () => {
  it('names the format and version', () => {
    expect(FORMAT_NAME).toBe('overtone');
    expect(FORMAT_VERSION).toBe(1);
  });

  it('lists the fixed semantic style classes', () => {
    expect([...STYLE_CLASSES]).toEqual(['emphasis', 'key', 'brand', 'number', 'soft']);
  });

  it('lists match kinds and edit reasons', () => {
    expect([...MATCH_KINDS]).toEqual(['exact', 'fuzzy', 'split', 'merge', 'interpolated', 'edited']);
    expect([...EDIT_REASONS]).toEqual(['correction', 'brand', 'style', 'punctuation', 'split-word']);
  });

  it('derives MatchKind and EditReason from the constants', () => {
    expectTypeOf<MatchKind>().toEqualTypeOf<(typeof MATCH_KINDS)[number]>();
    expectTypeOf<EditReason>().toEqualTypeOf<(typeof EDIT_REASONS)[number]>();
    expectTypeOf<MatchKind>().toEqualTypeOf<'exact' | 'fuzzy' | 'split' | 'merge' | 'interpolated' | 'edited'>();
    expectTypeOf<EditReason>().toEqualTypeOf<'correction' | 'brand' | 'style' | 'punctuation' | 'split-word'>();
  });
});

describe('DEFAULT_PROFILES', () => {
  it('defines horizontal and vertical rules', () => {
    expect(DEFAULT_PROFILES.horizontal.rules.maxCharsPerLine).toBe(42);
    expect(DEFAULT_PROFILES.vertical.rules.maxCharsPerLine).toBe(22);
    expect(DEFAULT_PROFILES.vertical.rules.maxLines).toBe(2);
  });
});
