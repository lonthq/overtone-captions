// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Profile } from 'overtone-format';
import { applyProfileToLayer, classToken, cueIndexAt, pictureRect } from '../src/core/index';

const cue = (start: number, end: number) => ({ start, end, speaker: 'S1', lines: [{ words: [0, 0] as [number, number], text: 'a' }] });
const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [cue(1, 2), cue(2.05, 3), cue(4, 5)], ...extra,
});

describe('cueIndexAt', () => {
  it('shows the active cue and holds it over a gap below 0.1 s', () => {
    const p = profile();
    expect(cueIndexAt(p, 0.5)).toBe(-1);
    expect(cueIndexAt(p, 1)).toBe(0);
    expect(cueIndexAt(p, 2.02)).toBe(0);
    expect(cueIndexAt(p, 3.5)).toBe(-1);
  });

  it('shows nothing outside the window', () => {
    const p = profile({ window: { start: 1.5, end: 4.5 } });
    expect(cueIndexAt(p, 1.2)).toBe(-1);
    expect(cueIndexAt(p, 1.6)).toBe(0);
    expect(cueIndexAt(p, 4.6)).toBe(-1);
  });
});

describe('pictureRect', () => {
  const box = { width: 640, height: 360 };

  it('pillarboxes a square video in a wide player (contain)', () => {
    expect(pictureRect(box, { width: 1080, height: 1080 }, 'contain')).toEqual({ left: 140, top: 0, width: 360, height: 360 });
    expect(pictureRect(box, { width: 1080, height: 1080 }, '')).toEqual({ left: 140, top: 0, width: 360, height: 360 });
  });

  it('letterboxes a wide video in a tall player (contain)', () => {
    expect(pictureRect({ width: 360, height: 640 }, { width: 1920, height: 1080 }, 'contain')).toEqual({ left: 0, top: 218.75, width: 360, height: 202.5 });
  });

  it('fills the box when shapes match', () => {
    expect(pictureRect(box, { width: 1920, height: 1080 }, 'contain')).toEqual({ left: 0, top: 0, width: 640, height: 360 });
  });

  it('uses the whole box for cover and fill, and while the video size is unknown', () => {
    const whole = { left: 0, top: 0, width: 640, height: 360 };
    expect(pictureRect(box, { width: 1080, height: 1920 }, 'cover')).toEqual(whole);
    expect(pictureRect(box, { width: 1080, height: 1920 }, 'fill')).toEqual(whole);
    expect(pictureRect(box, { width: 0, height: 0 }, 'contain')).toEqual(whole);
    expect(pictureRect(box, undefined, 'contain')).toEqual(whole);
  });
});

describe('applyProfileToLayer', () => {
  it('sets the profile class, --ot-chars and ot-tall, replacing an earlier profile', () => {
    const layer = document.createElement('div');
    layer.className = 'ot-layer ot-theme-clean';
    applyProfileToLayer(layer, profile({ id: 'vertical', aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2 } }));
    expect([...layer.classList]).toEqual(['ot-layer', 'ot-theme-clean', 'ot-profile-vertical', 'ot-tall']);
    expect(layer.style.getPropertyValue('--ot-chars')).toBe('22');
    applyProfileToLayer(layer, profile());
    expect([...layer.classList]).toEqual(['ot-layer', 'ot-theme-clean', 'ot-profile-horizontal']);
    expect(layer.style.getPropertyValue('--ot-chars')).toBe('42');
    applyProfileToLayer(layer, undefined);
    expect([...layer.classList]).toEqual(['ot-layer', 'ot-theme-clean']);
    expect(layer.style.getPropertyValue('--ot-chars')).toBe('');
  });

  it('makes ids safe as class tokens', () => {
    expect(classToken('a b/c')).toBe('a-b-c');
  });
});
