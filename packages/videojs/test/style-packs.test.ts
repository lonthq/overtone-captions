// Style packs (packages/videojs/styles/<name>/): metadata, the CSS contract, contrast and the build.
// The rules live in scripts/style-packs.mjs (lintStyle); this file runs one test per rule per pack, so a
// failing test names both. Guide: docs/contributing/style-packs.md.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LINT_RULES,
  buildStylePacks,
  contrastRatio,
  layerRuleShape,
  lintStyle,
  listPacks,
  packContrast,
  packProfiles,
  packVariables,
  parseColor,
  parseCss,
  readPack,
  SEMANTIC_CLASSES,
} from '../scripts/style-packs.mjs';
import { STYLE_CLASSES } from 'overtone-format';
import schema from '../styles/pack.schema.json';

const pkg = join(import.meta.dirname, '..');
const stylesDir = join(pkg, 'styles');
const baseCssPath = join(pkg, 'src/themes/base.css');
const base = readFileSync(baseCssPath, 'utf8');
const validateMeta = new Ajv2020({ allErrors: true }).compile(schema);

const packNames = listPacks(stylesDir);
// The template is checked as a pack named "my-pack", so a fresh copy of it starts out valid.
const subjects = [
  ...packNames.map((name) => ({ label: name, name, pack: readPack(join(stylesDir, name), name) })),
  { label: '_template', name: 'my-pack', pack: readPack(join(stylesDir, '_template'), 'my-pack') },
];
const ALLOWED_FILES = ['pack.json', 'style.css', 'preview.png'];

describe('style pack folders', () => {
  it('include the built-in packs (dist/themes/clean.css and social.css keep working)', () => {
    expect(packNames).toEqual(expect.arrayContaining(['clean', 'social', 'lumora', 'high-contrast', 'minimal']));
  });

  it.each(subjects.map((s) => [s.label, s.pack.dir] as const))('%s contains only pack.json, style.css and preview.png', (_, dir) => {
    for (const file of readdirSync(dir)) expect(ALLOWED_FILES, `${dir}/${file}`).toContain(file);
  });
});

describe.each(subjects)('style pack $label', ({ name, pack }) => {
  const css = pack.css ?? '';
  const problems = lintStyle(base, css, name);

  it('has pack.json and style.css', () => {
    expect(pack.meta, 'pack.json').not.toBeNull();
    expect(pack.css, 'style.css').not.toBeNull();
  });

  it('has a pack.json that matches styles/pack.schema.json', () => {
    const valid = validateMeta(pack.meta);
    expect(validateMeta.errors ?? [], JSON.stringify(validateMeta.errors)).toEqual([]);
    expect(valid).toBe(true);
  });

  it('is named after its folder', () => {
    expect(pack.meta?.name).toBe(name);
  });

  it.each(Object.entries(LINT_RULES))('style.css %s', (rule) => {
    expect(problems.filter((p) => p.rule === rule).map((p) => p.message)).toEqual([]);
  });

  it('has, if any, a small PNG preview (at most 100 KB and 1000 px wide)', () => {
    if (!pack.preview) return;
    const bytes = readFileSync(pack.preview);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(statSync(pack.preview).size).toBeLessThanOrEqual(100 * 1024);
    expect(bytes.readUInt32BE(16), 'width').toBeLessThanOrEqual(1000);
  });
});

describe('built-in pack details', () => {
  const social = readPack(join(stylesDir, 'social'), 'social').css!;
  const rules = parseCss(social).rules;

  it('social outlines its box-less text with at least four stacked shadows', () => {
    const shadow = /--ot-shadow:\s*([^;]+);/.exec(social)![1];
    const layers = shadow.split(/,(?![^()]*\))/).map((part) => part.trim());
    expect(layers.length).toBeGreaterThanOrEqual(4);
  });

  it('social keeps the space inside a joined key word and removes the gap between joined boxes', () => {
    // An inline-block drops a trailing space unless white-space keeps it.
    expect(rules.find((r) => r.selector === '.ot-theme-social .ot-word[data-joined]')?.body).toMatch(/white-space:\s*pre/);
    const gap = rules.find((r) => r.selector === '.ot-theme-social.ot-mode-styled .ot-word[data-joined] + .ot-word');
    expect(gap?.body).toMatch(/margin-left:\s*0/);
    expect(gap?.body).toMatch(/padding-left:\s*0/);
  });

  it('social keeps a joined key-word strip continuous: square inner corners, a still marker, and only the spoken text pops', () => {
    const body = (selector: string) => rules.find((r) => r.selector === selector && r.atRules.length === 0)?.body ?? '';
    expect(body('.ot-theme-social.ot-mode-styled .ot-key[data-joined]')).toMatch(/border-top-right-radius:\s*0/);
    expect(body('.ot-theme-social.ot-mode-styled .ot-word[data-joined] + .ot-key')).toMatch(/border-top-left-radius:\s*0/);
    // the marker box holds the trailing space and stays put: growing, it would cover the next word
    const box = rules.find((r) => /\.ot-key\.ot-active\[data-joined\]\s*,/.test(r.selector) && r.atRules.length === 0);
    expect(box?.selector).toContain('.ot-word[data-joined] + .ot-key.ot-active');
    expect(box?.body).toMatch(/transform:\s*none/);
    // only the text grows, and less than a lone key word, so it cannot close the space ("aclockwork.")
    const text = rules.find((r) => r.selector.includes('.ot-key.ot-active[data-joined] > .ot-text') && r.atRules.length === 0);
    expect(text?.selector).toContain('.ot-word[data-joined] + .ot-key.ot-active > .ot-text');
    expect(text?.body).toMatch(/transform:\s*translateY\(var\(--ot-pack-lift\)\) scale\(var\(--ot-pack-strip-grow\)\)/);
    expect(body('.ot-theme-social .ot-text')).toMatch(/display:\s*inline-block/);
  });

  it('social grows every spoken word (only that word, also inside a joined strip), styled words more, and tilts emphasis', () => {
    const vars = packVariables(base, social, 'social', { shape: 'wide' });
    const grow = Number(vars['--ot-pack-grow']);
    const pop = Number(vars['--ot-pop-scale']);
    const strip = Number(vars['--ot-pack-strip-grow']);
    expect(grow).toBeGreaterThan(1);
    expect(pop).toBeGreaterThan(grow);
    expect(strip).toBeGreaterThan(1);
    expect(strip).toBeLessThan(pop);
    const body = (selector: string) => rules.find((r) => r.selector === selector && r.atRules.length === 0)?.body ?? '';
    expect(body('.ot-theme-social .ot-word')).toMatch(/transform-origin:\s*50% 100%/);
    expect(body('.ot-theme-social.ot-mode-styled .ot-word.ot-active')).toMatch(/scale\(var\(--ot-pack-grow\)\)/);
    expect(body('.ot-theme-social.ot-mode-styled .ot-active:is(.ot-emphasis, .ot-key, .ot-brand, .ot-number)')).toMatch(/scale\(var\(--ot-pop-scale\)\)/);
    // the tilt follows --ot-turn, random per word
    expect(body('.ot-theme-social.ot-mode-styled .ot-emphasis.ot-active')).toMatch(/rotate\(calc\(var\(--ot-pack-tilt\) \* var\(--ot-turn\)\)\)/);
    // no rule moves a word that is not spoken
    const growsOthers = rules.filter((r) => /:has\(|\.ot-active \+ |\.ot-active\s*\+/.test(r.selector) && !/transform:\s*none/.test(r.body));
    expect(growsOthers.map((r) => r.selector)).toEqual([]);
    expect(lintStyle(base, social, 'social')).toEqual([]);
  });

  it('the player guide lists social\'s motion variables but not their values, so tuning them needs no doc change', () => {
    const guide = readFileSync(join(pkg, '../../docs/player.md'), 'utf8');
    const spoken = guide.slice(guide.indexOf('- **Spoken word**'), guide.indexOf('- **Taller control bars**'));
    const vars = packVariables(base, social, 'social', { shape: 'wide' });
    const motion = ['--ot-pop-scale', ...Object.keys(vars).filter((name) => name.startsWith('--ot-pack-'))];
    expect(motion.length).toBeGreaterThan(1);
    for (const name of motion) {
      expect(spoken, name).toContain(`\`${name}\``);
      expect(spoken, `${name}: ${vars[name]}`).not.toContain(vars[name]);
    }
  });

  it('high-contrast keeps a solid box and every text color at 7:1 or more (WCAG AAA)', () => {
    const css = readPack(join(stylesDir, 'high-contrast'), 'high-contrast').css!;
    const { variants, lowest } = packContrast(base, css, 'high-contrast');
    expect(variants.every((variant) => variant.mode === 'box')).toBe(true);
    expect(lowest).toBeGreaterThanOrEqual(7);
    expect(lintStyle(base, css, 'high-contrast')).toEqual([]);
    expect(css).not.toMatch(/transform|animation/);
  });
});

describe('layerRuleShape', () => {
  it.each([
    ['.ot-layer.ot-theme-x', ''],
    ['.ot-layer.ot-theme-x.ot-tall', 'tall'],
    ['.ot-tall.ot-layer.ot-theme-x', 'tall'],
    ['.ot-layer.ot-theme-x.ot-profile-square', 'profile:square'],
    ['.ot-layer.ot-theme-x.ot-wide', null],
    ['.ot-layer.ot-theme-x.ot-tall.ot-profile-v', null],
    ['.ot-layer.ot-theme-y', null],
    ['.ot-layer.ot-theme-x .ot-word', null],
  ])('reads %s as %j', (selector, expected) => {
    expect(layerRuleShape(selector, 'x')).toBe(expected);
  });
});

describe('packVariables', () => {
  const scale = (css: string, options: Parameters<typeof packVariables>[3] = {}) =>
    packVariables(base, css, 'x', options)['--ot-scale'];

  it('starts from the base defaults', () => {
    expect(scale('', { shape: 'tall' })).toBe(packVariables(base, '', 'x')['--ot-scale']);
  });

  it('applies a tall-only rule to the tall shape only', () => {
    const css = '.ot-layer.ot-theme-x { --ot-scale: 1.1; } .ot-layer.ot-theme-x.ot-tall { --ot-scale: 0.9; }';
    expect(scale(css, { shape: 'wide' })).toBe('1.1');
    expect(scale(css, { shape: 'tall' })).toBe('0.9');
  });

  it('lets a tall rule win over a later plain rule, as its higher specificity does in CSS', () => {
    const css = '.ot-layer.ot-theme-x.ot-tall { --ot-scale: 0.9; } .ot-layer.ot-theme-x { --ot-scale: 1.1; }';
    expect(scale(css, { shape: 'tall' })).toBe('0.9');
    expect(scale(css, { shape: 'wide' })).toBe('1.1');
  });

  it('applies a selector list by its matching part: the later mixed rule wins in wide and in tall', () => {
    const css =
      '.ot-layer.ot-theme-x { --ot-scale: 1.1; } .ot-layer.ot-theme-x, .ot-layer.ot-theme-x.ot-tall { --ot-scale: 1.3; }';
    expect(scale(css, { shape: 'wide' })).toBe('1.3');
    expect(scale(css, { shape: 'tall' })).toBe('1.3');
  });

  it('applies tall and profile rules in source order, and profile rules only when a profile is given', () => {
    const profileFirst =
      '.ot-layer.ot-theme-x.ot-profile-square { --ot-scale: 1.5; } .ot-layer.ot-theme-x.ot-tall { --ot-scale: 0.9; }';
    const profileLast =
      '.ot-layer.ot-theme-x.ot-tall { --ot-scale: 0.9; } .ot-layer.ot-theme-x.ot-profile-square { --ot-scale: 1.5; }';
    expect(packProfiles(profileFirst, 'x')).toEqual(['square']);
    expect(scale(profileFirst, { shape: 'tall' })).toBe('0.9');
    expect(scale(profileFirst, { shape: 'tall', profile: 'square' })).toBe('0.9');
    expect(scale(profileLast, { shape: 'tall', profile: 'square' })).toBe('1.5');
    expect(scale(profileLast, { shape: 'tall' })).toBe('0.9');
    expect(scale(profileLast, { shape: 'wide', profile: 'square' })).toBe('1.5');
    expect(scale(profileFirst, { shape: 'wide', profile: 'other' })).toBe(packVariables(base, '', 'x')['--ot-scale']);
  });

  it('applies the same rules inside a media block on top of the plain ones', () => {
    const css = '.ot-layer.ot-theme-x { --ot-scale: 1.1; } @media (min-width: 600px) { .ot-layer.ot-theme-x.ot-tall { --ot-scale: 1.2; } }';
    expect(scale(css, { shape: 'tall' })).toBe('1.1');
    expect(scale(css, { shape: 'tall', media: '@media (min-width: 600px)' })).toBe('1.2');
    expect(scale(css, { shape: 'wide', media: '@media (min-width: 600px)' })).toBe('1.1');
  });
});

describe('the lint catches mistakes', () => {
  const lint = (body: string, extra = '') => lintStyle(base, `.ot-layer.ot-theme-x { ${body} }\n${extra}`, 'x');
  const rulesOf = (problems: Array<{ rule: string }>) => [...new Set(problems.map((p) => p.rule))];
  const ok = '--ot-emphasis-color: #ffe9a8; --ot-brand-color: #9fd4ff; --ot-number-color: #a6f0c6; --ot-soft-color: #ccc;';

  it('accepts a small valid pack', () => {
    expect(lint(ok)).toEqual([]);
  });

  it.each([
    ['unscoped selectors', '', '.ot-word { color: var(--ot-color); }', 'scope'],
    ['a sibling of the layer', '', '.ot-theme-x ~ .vjs-control-bar { margin: 0; }', 'scope'],
    ['a similar but different scope', '', '.ot-theme-xy .ot-word { margin: 0; }', 'scope'],
    ['class styling in plain mode', '', '.ot-theme-x .ot-key { font-weight: 900; }', 'plain-mode'],
    ['active-word styling in plain mode', '', '.ot-theme-x .ot-active { text-decoration: underline; }', 'plain-mode'],
    ['unknown variables', '--ot-glow: 1;', '', 'variables'],
    ['custom properties without the pack prefix', '--brand: red;', '', 'variables'],
    ['variables set outside the layer', '', '.ot-theme-x .ot-word { --ot-color: #fff; }', 'variables'],
    ['undefined pack variables', '', '.ot-theme-x.ot-mode-styled .ot-key { text-decoration-color: var(--ot-pack-nope); }', 'variables'],
    ['literal colors in rules', '', '.ot-theme-x.ot-mode-styled .ot-key { color: #f00; }', 'colors'],
    ['!important', '--ot-color: #fff !important;', '', 'important'],
    ['@import', '', "@import 'other.css';", 'external'],
    ['url()', '', '.ot-theme-x .ot-line { background-image: url(x.png); }', 'external'],
    ['@font-face', '', "@font-face { font-family: X; src: local(X); }", 'at-rules'],
    ['position: fixed', '', '.ot-theme-x .ot-cue { position: fixed; }', 'layout'],
    ['z-index', '', '.ot-theme-x .ot-cue { z-index: 5; }', 'layout'],
    ['display: none', '', '.ot-theme-x .ot-speaker { display: none; }', 'hiding'],
    ['opacity', '', '.ot-theme-x .ot-line { opacity: 0.5; }', 'hiding'],
    ['injected text', '', ".ot-theme-x .ot-line::before { content: 'NEW'; }", 'hiding'],
    ['a font stack without a generic family', "--ot-font: 'Brand Sans';", '', 'fonts'],
    ['text in px', '--ot-font-size: 18px;', '', 'size'],
    ['text smaller than the default', '--ot-font-size: 3cqw;', '', 'size'],
    ['a tall scale below the default', '', '.ot-layer.ot-theme-x.ot-tall { --ot-scale: 0.9; }', 'size'],
    ['a profile scale below the default', '', '.ot-layer.ot-theme-x.ot-profile-square { --ot-scale: 0.5; }', 'size'],
    ['a translucent box in one profile', '', '.ot-layer.ot-theme-x.ot-profile-square { --ot-bg: rgb(0 0 0 / 0.4); }', 'contrast'],
    ['motion without a reduced-motion override', '', '.ot-theme-x .ot-word { transition: transform 0.2s; }', 'motion'],
    ['an active-word transform without an override', '', '.ot-theme-x.ot-mode-styled .ot-active.ot-key { transform: scale(1.1); }', 'motion'],
    ['unscoped keyframe names', '', '@keyframes pop { from { opacity: 1; } }', 'at-rules'],
    ['low-contrast soft text', '--ot-soft-color: rgb(255 255 255 / 0.4);', '', 'contrast'],
    ['a translucent box', '--ot-bg: rgb(0 0 0 / 0.4);', '', 'contrast'],
    ['no box and no outline', '--ot-bg: transparent;', '', 'contrast'],
    ['a dark key color on a transparent highlight', '--ot-key-color: #222;', '', 'contrast'],
    ['an unreadable color', '--ot-color: color-mix(in srgb, white, black);', '', 'contrast'],
    ['nested rules', '', '.ot-theme-x .ot-line { & .ot-word { margin: 0; } }', 'syntax'],
  ])('flags %s', (_, body, extra, rule) => {
    expect(rulesOf(lint(`${ok} ${body}`, extra))).toContain(rule);
  });

  it('flags semantic classes that look like plain text (base.css alone styles only key and soft)', () => {
    const problems = lint('').filter((p) => p.rule === 'classes');
    expect(problems.map((p) => p.message.split(' ')[0]).sort()).toEqual(['brand', 'emphasis', 'number']);
    const soft = lint(`${ok} --ot-soft-color: var(--ot-color);`).filter((p) => p.rule === 'classes');
    expect(soft.map((p) => p.message.split(' ')[0])).toEqual(['soft']);
  });

  it('accepts a box-less pack with an outline, and motion with a reduced-motion override', () => {
    const extra = `
      .ot-theme-x .ot-word { display: inline-block; transition: transform 0.1s; }
      .ot-theme-x.ot-mode-styled .ot-active.ot-key { transform: scale(1.05); }
      @media (prefers-reduced-motion: reduce) {
        .ot-theme-x .ot-word { transition: none; }
        .ot-theme-x.ot-mode-styled .ot-active.ot-key { transform: none; }
      }`;
    expect(lint(`${ok} --ot-bg: transparent; --ot-shadow: 0 0 0.05em #000, 0 0 0.05em #000;`, extra)).toEqual([]);
  });
});

describe('contrast helpers', () => {
  it('reads hex, rgb() and hsl() colors', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.5, 2);
    expect(parseColor('rgb(10 20 30 / 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgba(10, 20, 30, 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('hsl(0 100% 50%)')).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseColor('papayawhip')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio(parseColor('#fff')!, parseColor('#000')!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#767676')!, parseColor('#fff')!)).toBeCloseTo(4.54, 2);
  });
});

describe('build', () => {
  const out = mkdtempSync(join(tmpdir(), 'overtone-packs-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('copies base.css and every pack to dist/themes/<name>.css unchanged and writes packs.json', () => {
    const manifest = buildStylePacks({ stylesDir, baseCssPath, outDir: out });
    expect(readFileSync(join(out, 'base.css'), 'utf8')).toBe(base);
    for (const name of packNames) {
      expect(readFileSync(join(out, `${name}.css`), 'utf8')).toBe(readFileSync(join(stylesDir, name, 'style.css'), 'utf8'));
    }
    expect(readdirSync(out).sort()).toEqual(['base.css', 'packs.json', ...packNames.map((n) => `${n}.css`)].sort());
    const written = JSON.parse(readFileSync(join(out, 'packs.json'), 'utf8'));
    expect(written).toEqual(manifest);
    expect(written.packs.map((p: { name: string }) => p.name)).toEqual(packNames);
    const clean = written.packs.find((p: { name: string }) => p.name === 'clean');
    expect(clean).toMatchObject({ title: 'Clean', css: 'clean.css', source: 'packages/videojs/styles/clean/' });
    expect(clean.lowestContrast).toBeGreaterThanOrEqual(4.5);
    expect(clean).not.toHaveProperty('$schema');
  });

  it('refuses a pack whose pack.json name does not match its folder', () => {
    const styles = mkdtempSync(join(tmpdir(), 'overtone-styles-'));
    try {
      mkdirSync(join(styles, 'wrong'));
      writeFileSync(join(styles, 'wrong', 'style.css'), '.ot-layer.ot-theme-wrong {}');
      writeFileSync(join(styles, 'wrong', 'pack.json'), JSON.stringify({ name: 'right' }));
      expect(() => buildStylePacks({ stylesDir: styles, baseCssPath, outDir: join(out, 'refused') })).toThrow(/name/);
    } finally {
      rmSync(styles, { recursive: true, force: true });
    }
  });
});

describe('the lint\'s class list', () => {
  it('is the format\'s semantic classes, so a new class is linted too', () => {
    expect(SEMANTIC_CLASSES).toEqual([...STYLE_CLASSES]);
  });
});
