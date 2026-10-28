import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** Innermost CSS rules as { selector, body }; comments removed, @media preludes skipped. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

const declared = (css: string) => new Set([...css.matchAll(/(--ot-[\w-]+)\s*:/g)].map((m) => m[1]));
const used = (css: string) => new Set([...css.matchAll(/var\((--ot-[\w-]+)/g)].map((m) => m[1]));

// base.css: layout and the variable defaults every style pack builds on. The packs themselves
// (packages/videojs/styles/<name>/) are checked in style-packs.test.ts.
const base = read('packages/videojs/src/themes/base.css');
const baseLayerRule = rules(base).find((rule) => rule.selector === '.ot-layer')!;
const baseDefaults = declared(baseLayerRule.body);

describe('base.css', () => {
  it('declares the documented theme variables on .ot-layer', () => {
    for (const name of [
      '--ot-font', '--ot-font-size', '--ot-color', '--ot-bg', '--ot-brand-color', '--ot-key-weight',
      '--ot-key-highlight', '--ot-emphasis-style', '--ot-soft-color', '--ot-pop-scale',
    ]) {
      expect(baseDefaults, name).toContain(name);
    }
  });

  it('only uses variables that have a default', () => {
    for (const name of used(base)) expect(baseDefaults, name).toContain(name);
  });

  it('makes the visible picture a size container and sizes text in container units', () => {
    expect(rules(base).find((rule) => rule.selector === '.ot-picture')!.body).toContain('container-type: inline-size');
    expect(rules(base).find((rule) => rule.selector === '.ot-host')?.body ?? '').not.toContain('container-type');
    expect(baseLayerRule.body).toMatch(/--ot-font-size:\s*[\d.]+cqw/);
  });
});

describe('base.css layering and layout', () => {
  it('gives the layer no z-index, so video.js menus and dialogs paint above it', () => {
    expect(baseLayerRule.body).not.toMatch(/z-index/);
  });

  it('lifts above the control bar only when the player has one', () => {
    const lifts = rules(base).filter((rule) => rule.body.includes('var(--ot-controls-offset)'));
    expect(lifts.length).toBeGreaterThan(0);
    for (const rule of lifts) {
      expect(rule.selector, rule.selector).toContain(':not(.vjs-controls-disabled)');
      expect(rule.selector, rule.selector).toContain(':not(.vjs-using-native-controls)');
    }
  });

  it('keeps lines within the layer', () => {
    const line = rules(base).find((rule) => rule.selector === '.ot-line')!;
    expect(line.body).toContain('max-width: 100%');
    expect(line.body).toContain('width: fit-content');
    expect(line.body).not.toContain('max-content');
  });

  it('keeps only 2% side padding on the layer so valid lines do not wrap', () => {
    expect(baseLayerRule.body).toMatch(/padding:\s*0 2%;/);
  });

  it('disables the bottom transition under prefers-reduced-motion', () => {
    const reduced = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.ot-layer\s*\{[^}]*transition:\s*none/);
  });
});

describe('sizing by line length', () => {
  it('derives the font size from --ot-chars, so a full line spans the same share of the width in every profile', () => {
    const layer = rules(base).find((rule) => rule.selector === '.ot-layer')!;
    expect(layer.body).toContain('--ot-chars: 42');
    expect(layer.body).toContain('font-size: calc(var(--ot-font-size) * 42 / var(--ot-chars) * var(--ot-scale))');
    expect(rules(base).some((rule) => rule.selector.includes('ot-profile-vertical'))).toBe(false);
  });
});

describe('plain mode', () => {
  it('has no class styling outside .ot-mode-styled', () => {
    const classSelector = /\.ot-(emphasis|key|brand|number|soft)\b/;
    for (const rule of rules(base).filter((r) => classSelector.test(r.selector))) {
      expect(rule.selector, rule.selector).toContain('.ot-mode-styled');
    }
  });
});
