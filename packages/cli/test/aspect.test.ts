import { describe, expect, it } from 'vitest';
import { aspectId, mediaProfile, rulesFor, snapAspect } from '../src/segment/aspect.js';
import { LATEST_RULESET } from '../src/segment/rulesets/index.js';
import type { ResolvedProfile } from '../src/config.js';

const R = LATEST_RULESET;

describe('rulesFor', () => {
  it('returns the anchors at 16:9 and 9:16', () => {
    expect(rulesFor(R, '16:9')).toEqual({ maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minDuration: 1, maxDuration: 7 });
    expect(rulesFor(R, '9:16')).toEqual({ maxCharsPerLine: 22, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5 });
  });

  it('interpolates in ln(aspect) between the anchors', () => {
    expect(rulesFor(R, '1:1')).toEqual({ maxCharsPerLine: 32, maxLines: 2, maxCps: 16, minDuration: 0.9, maxDuration: 6 });
    expect(rulesFor(R, '4:3')).toEqual({ maxCharsPerLine: 37, maxLines: 2, maxCps: 16.5, minDuration: 0.95, maxDuration: 6.5 });
    expect(rulesFor(R, '4:5')).toEqual({ maxCharsPerLine: 28, maxLines: 2, maxCps: 15.61, minDuration: 0.86, maxDuration: 5.61 });
  });

  it('clamps outside the anchors', () => {
    expect(rulesFor(R, '21:9')).toEqual(rulesFor(R, '16:9'));
    expect(rulesFor(R, '1:2')).toEqual(rulesFor(R, '9:16'));
  });
});

describe('aspectId and snapAspect', () => {
  it('turns an aspect into a profile id', () => {
    expect(aspectId('1:1')).toBe('1x1');
    expect(aspectId('4:5')).toBe('4x5');
  });

  it('snaps to a common ratio within 2%, else reduces the pixel ratio', () => {
    expect(snapAspect(1080, 1080)).toBe('1:1');
    expect(snapAspect(1080, 1350)).toBe('4:5');
    expect(snapAspect(1440, 1080)).toBe('4:3');
    expect(snapAspect(1918, 1080)).toBe('16:9');
    expect(snapAspect(1000, 700)).toBe('10:7');
    expect(snapAspect(1280, 800)).toBe('8:5');
    expect(snapAspect(1281, 801)).toBe('8:5');
    expect(snapAspect(800, 1280)).toBe('5:8');
  });

  it('rounds fractional sizes first', () => {
    expect(snapAspect(1919.7, 1080.2)).toBe('16:9');
  });
});

describe('mediaProfile', () => {
  const defaults: ResolvedProfile[] = [
    { id: 'horizontal', aspect: '16:9', rules: rulesFor(R, '16:9') },
    { id: 'vertical', aspect: '9:16', rules: rulesFor(R, '9:16') },
  ];

  it('adds a profile for an in-between shape', () => {
    expect(mediaProfile(defaults, { width: 1080, height: 1080 }, R)).toEqual({ id: '1x1', description: '1:1 (the media)', aspect: '1:1', rules: rulesFor(R, '1:1') });
    expect(mediaProfile(defaults, { width: 1440, height: 1080 }, R)?.id).toBe('4x3');
  });

  it('adds nothing for an unknown shape', () => {
    expect(mediaProfile(defaults, { width: 0, height: 0 }, R)).toBeUndefined();
    expect(mediaProfile(defaults, { width: Number.NaN, height: 1080 }, R)).toBeUndefined();
    expect(mediaProfile(defaults, { width: 1080, height: 0.4 }, R)).toBeUndefined();
  });

  it('adds nothing when a profile already has the same rules', () => {
    expect(mediaProfile(defaults, { width: 1920, height: 1080 }, R)).toBeUndefined();
    expect(mediaProfile(defaults, { width: 2560, height: 1080 }, R)).toBeUndefined();
    expect(mediaProfile(defaults, { width: 1080, height: 1920 }, R)).toBeUndefined();
  });
});
