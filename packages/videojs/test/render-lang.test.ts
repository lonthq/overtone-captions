// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getProfile } from 'overtone-format';
import { renderCue } from '../src/core/render';
import { loadFixture } from './helpers';

const doc = loadFixture();
const horizontal = getProfile(doc, 'horizontal')!;

describe('renderCue: language and direction', () => {
  it("sets the document's language as lang on the cue", () => {
    expect(renderCue({ ...doc, language: 'ar' }, horizontal, 1).getAttribute('lang')).toBe('ar');
    expect(renderCue({ ...doc, language: 'zh-Hant' }, horizontal, 1).getAttribute('lang')).toBe('zh-Hant');
  });

  it('sets no lang when the language is unknown ("und" or empty)', () => {
    expect(renderCue({ ...doc, language: 'und' }, horizontal, 1).hasAttribute('lang')).toBe(false);
    expect(renderCue({ ...doc, language: '' }, horizontal, 1).hasAttribute('lang')).toBe(false);
  });

  it('gives every line dir="auto", so a right-to-left line runs right to left', () => {
    const lines = [...renderCue(doc, horizontal, 1).querySelectorAll<HTMLElement>('.ot-line')];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.getAttribute('dir') === 'auto')).toBe(true);
  });
});
