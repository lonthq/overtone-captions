// Style packs: one folder per caption theme in packages/videojs/styles/<name>/ (style.css + pack.json).
// This module reads the packs, resolves their CSS variables, measures text contrast and builds them into
// dist/themes/<name>.css plus a dist/themes/packs.json manifest (the style gallery and the demo read it).
// The tests in test/style-packs.test.ts use the same helpers. Zero dependencies.
//
//   node scripts/style-packs.mjs            build the packs into dist/themes (part of `npm run build`)
//   node scripts/style-packs.mjs --watch    rebuild whenever a pack or base.css changes
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lowest contrast ratio allowed between caption text and what is directly behind it (WCAG AA). */
const MIN_CONTRAST = 4.5;
/** A line box at least this opaque counts as the text background; below it, the pack needs an outline. */
const MIN_BOX_ALPHA = 0.6;
/** Centered, opaque text-shadow layers a box-less pack needs so the text keeps an edge on bright video. */
const MIN_OUTLINE_LAYERS = 2;
/** Text variables measured against the line box (or the outline). */
const TEXT_COLOR_VARIABLES = [
  '--ot-color',
  '--ot-speaker-color',
  '--ot-emphasis-color',
  '--ot-brand-color',
  '--ot-number-color',
  '--ot-soft-color',
];

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

// ---------------------------------------------------------------------------------------------------
// Reading packs

/** Pack folder names in `stylesDir`, sorted. Folders starting with `_` (the template) are not packs. */
export function listPacks(stylesDir) {
  return readdirSync(stylesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** One pack folder: its name (the folder name), parsed pack.json (null if missing) and style.css text. */
export function readPack(dir, name) {
  const metaPath = join(dir, 'pack.json');
  const cssPath = join(dir, 'style.css');
  return {
    name,
    dir,
    meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null,
    css: existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : null,
    preview: existsSync(join(dir, 'preview.png')) ? join(dir, 'preview.png') : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// A small CSS reader: enough for flat theme stylesheets (no nesting), not a general parser.

/**
 * Rules of a stylesheet with the at-rules they sit in, plus every at-rule.
 * `rules[i].atRules` is e.g. ['@media (prefers-reduced-motion: reduce)'] for a rule inside that block.
 */
export function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const atRules = [];
  const walk = (from, context) => {
    let i = from;
    let start = from;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') {
        const prelude = src.slice(start, i).trim();
        if (prelude.startsWith('@')) {
          atRules.push({ prelude, context, statement: false });
          i = walk(i + 1, [...context, prelude]);
        } else {
          const end = src.indexOf('}', i);
          const body = src.slice(i + 1, end === -1 ? src.length : end);
          rules.push({ selector: prelude, body, declarations: parseDeclarations(body), atRules: context });
          i = end === -1 ? src.length : end + 1;
        }
        start = i;
      } else if (ch === '}') {
        return i + 1;
      } else if (ch === ';') {
        const statement = src.slice(start, i).trim();
        if (statement.startsWith('@')) atRules.push({ prelude: statement, context, statement: true });
        start = ++i;
      } else {
        i++;
      }
    }
    return i;
  };
  walk(0, []);
  return { rules, atRules };
}

/** `prop: value` pairs of a rule body, in order; `important` is true for `!important`. */
function parseDeclarations(body) {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes(':'))
    .map((part) => {
      const colon = part.indexOf(':');
      const raw = part.slice(colon + 1).trim();
      return {
        property: part.slice(0, colon).trim(),
        value: raw.replace(/\s*!important\s*$/i, ''),
        important: /!\s*important/i.test(raw),
      };
    });
}

/** Splits a selector list on its top-level commas. */
function splitSelectorList(selector) {
  return splitTopLevel(selector, ',');
}

/** Splits on `separator` outside parentheses. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** Class names of a selector made only of classes (`.ot-layer.ot-theme-x`), else null. */
function classOnlySelector(selector) {
  const trimmed = selector.trim();
  if (!/^(\.[\w-]+)+$/.test(trimmed)) return null;
  return trimmed.slice(1).split('.');
}

// ---------------------------------------------------------------------------------------------------
// Variables

/** Custom properties of the base `.ot-layer` rule (the documented theme variables and their defaults). */
function baseVariables(baseCss) {
  const layer = parseCss(baseCss).rules.find((rule) => rule.selector === '.ot-layer' && rule.atRules.length === 0);
  return Object.fromEntries(
    (layer?.declarations ?? []).filter((d) => d.property.startsWith('--')).map((d) => [d.property, d.value]),
  );
}

/**
 * Whether a rule sets layer variables for `name`: `.ot-layer.ot-theme-<name>`, optionally with `.ot-tall` or one
 * `.ot-profile-<id>`. Returns '' (every shape), 'tall', `profile:<id>`, or null.
 */
export function layerRuleShape(selector, name) {
  const classes = classOnlySelector(selector);
  if (!classes || !classes.includes('ot-layer') || !classes.includes(`ot-theme-${name}`)) return null;
  const rest = classes.filter((c) => c !== 'ot-layer' && c !== `ot-theme-${name}`);
  if (rest.length === 0) return '';
  if (rest.length === 1 && rest[0] === 'ot-tall') return 'tall';
  if (rest.length === 1 && rest[0].startsWith('ot-profile-')) return `profile:${rest[0].slice('ot-profile-'.length)}`;
  return null;
}

/**
 * Every variable as the layer sees it in `shape` ('wide' or 'tall'), in cascade order: base defaults, the pack's
 * layer rule, then its .ot-tall (tall only) and .ot-profile-<id> (when given) rules in source order (equal
 * specificity, so the later rule wins), then (with `media`) the same inside that @media block.
 */
export function packVariables(baseCss, packCss, name, { shape = 'wide', media = null, profile = null } = {}) {
  const vars = { ...baseVariables(baseCss) };
  const assign = (rule) => {
    for (const d of rule.declarations) if (d.property.startsWith('--')) vars[d.property] = d.value;
  };
  const packRules = parseCss(packCss).rules;
  const applyContext = (context) => {
    const matching = packRules.filter((rule) => rule.atRules.join('|') === context);
    const targets = (wanted) => matching.filter((rule) => splitSelectorList(rule.selector).some((s) => wanted.includes(layerRuleShape(s, name))));
    for (const rule of targets([''])) assign(rule);
    const extra = [shape === 'tall' ? 'tall' : null, profile ? `profile:${profile}` : null].filter(Boolean);
    for (const rule of targets(extra)) assign(rule);
  };
  applyContext('');
  if (media) applyContext(media);
  return vars;
}

/** The profile ids (.ot-profile-<id>) that the pack's layer rules use, in any context, sorted. */
export function packProfiles(packCss, name) {
  const ids = new Set();
  for (const rule of parseCss(packCss).rules) {
    for (const selector of splitSelectorList(rule.selector)) {
      const kind = layerRuleShape(selector, name);
      if (kind?.startsWith('profile:')) ids.add(kind.slice('profile:'.length));
    }
  }
  return [...ids].sort();
}

/** The @media preludes under which `packCss` sets layer variables (each is checked as its own variant). */
function variableMediaContexts(packCss, name) {
  const contexts = new Set();
  for (const rule of parseCss(packCss).rules) {
    if (rule.atRules.length === 0) continue;
    if (!rule.declarations.some((d) => d.property.startsWith('--'))) continue;
    if (splitSelectorList(rule.selector).some((s) => layerRuleShape(s, name) !== null)) contexts.add(rule.atRules.join('|'));
  }
  return [...contexts];
}

/** Replaces every var(--x[, fallback]) in `value` with its resolved value from `vars`. */
function resolveValue(value, vars, depth = 0) {
  if (value === undefined || depth > 20) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let depthParen = 1;
    let j = at + 4;
    while (j < value.length && depthParen > 0) {
      if (value[j] === '(') depthParen++;
      else if (value[j] === ')') depthParen--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const varName = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    const replacement = vars[varName] ?? fallback ?? '';
    out += resolveValue(replacement, vars, depth + 1);
    i = j;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------------------------------
// Colors and contrast

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function channel(token) {
  return token.endsWith('%') ? (parseFloat(token) / 100) * 255 : parseFloat(token);
}

function alpha(token) {
  if (token === undefined) return 1;
  return token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * A CSS color as { r, g, b (0-255), a (0-1) }, or null when it is not one this reader understands.
 * Understood: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and hsl()/hsla() (comma or space syntax),
 * `transparent`, `black` and `white`.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (value === 'black') return { ...BLACK };
  if (value === 'white') return { ...WHITE };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const n = (k) => parseInt(digits.slice(k, k + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(value);
  if (!fn) return null;
  const tokens = fn[2].replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter((t) => t && t !== '/');
  if (tokens.length < 3 || tokens.length > 4) return null;
  if (tokens.some((t) => !/^-?[\d.]+(%|deg)?$/.test(t))) return null;
  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = tokens.slice(0, 3).map(channel);
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha(tokens[3]), 0, 1) };
  }
  const h = parseFloat(tokens[0]);
  const s = clamp(parseFloat(tokens[1]) / 100, 0, 1);
  const l = clamp(parseFloat(tokens[2]) / 100, 0, 1);
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
  return { r, g, b, a: clamp(alpha(tokens[3]), 0, 1) };
}

/** `top` painted over an opaque `bottom`. */
function blend(top, bottom) {
  const mix = (k) => top[k] * top.a + bottom[k] * (1 - top.a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
}

/** WCAG 2 relative luminance of an opaque color. */
function luminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two opaque colors (1-21). */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Layers of a text-shadow value as { x, y, blur (strings), color (parsed or null), raw }. */
function parseShadow(value) {
  if (!value || value.trim() === 'none') return [];
  return splitTopLevel(value, ',').map((raw) => {
    const colorMatch = /(#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|\btransparent\b|\bblack\b|\bwhite\b)/.exec(raw);
    const lengths = raw.replace(colorMatch?.[0] ?? '', ' ').trim().split(/\s+/).filter(Boolean);
    return { raw, x: lengths[0], y: lengths[1], blur: lengths[2] ?? '0', color: colorMatch ? parseColor(colorMatch[0]) : null };
  });
}

const isZero = (length) => length !== undefined && parseFloat(length) === 0;

/** Shadow layers that work as an outline: no offset and an (almost) opaque color. */
function outlineLayers(shadowValue) {
  return parseShadow(shadowValue).filter((layer) => isZero(layer.x) && isZero(layer.y) && layer.color && layer.color.a >= 0.9);
}

/**
 * Contrast of every caption text color against what is directly behind it, for one set of resolved variables.
 * - mode 'box': the line box (--ot-bg) is at least MIN_BOX_ALPHA opaque. Measured over both a white and a
 *   black video frame (worst case kept), because a translucent box lets the video through.
 * - mode 'outline': no (or a thin) box; the text needs an outline (--ot-shadow) and is measured against it.
 * Key words are measured against their highlight when --ot-key-highlight is not transparent.
 * Returns { mode, checks: [{ label, variable, fg, bg, ratio }], problems: [string] }.
 */
function contrastReport(vars) {
  const problems = [];
  const checks = [];
  const color = (variable) => {
    const resolved = resolveValue(vars[variable], vars);
    const parsed = parseColor(resolved);
    if (!parsed) problems.push(`${variable}: "${resolved}" is not a color the contrast check can read (use hex, rgb() or hsl())`);
    return parsed;
  };
  const bg = color('--ot-bg');
  if (!bg) return { mode: 'unknown', checks, problems };
  const shadow = resolveValue(vars['--ot-shadow'], vars);
  const outlines = outlineLayers(shadow);
  const mode = bg.a >= MIN_BOX_ALPHA ? 'box' : 'outline';
  if (mode === 'outline' && outlines.length < MIN_OUTLINE_LAYERS) {
    problems.push(
      `--ot-bg is only ${Math.round(bg.a * 100)}% opaque, so the text needs an outline: give --ot-shadow at least ` +
        `${MIN_OUTLINE_LAYERS} centered opaque layers (e.g. "0 0 0.06em #000, 0 0 0.06em #000"), or make the box at least ${MIN_BOX_ALPHA * 100}% opaque`,
    );
    return { mode, checks, problems };
  }
  // Each pair: `under` is what a translucent text color mixes with, `against` what the text must stand out
  // from. In a box both are the box (over a white or a black video frame). Without a box the glyphs sit on
  // the video and must stand out from their outline.
  const videos = [WHITE, BLACK];
  const pairs =
    mode === 'box'
      ? videos.map((video) => blend(bg, video)).map((surface) => ({ under: surface, against: surface }))
      : videos.flatMap((video) =>
          outlines.map((layer) => ({ under: blend(bg, video), against: blend(layer.color, video) })),
        );
  const measure = (label, variable, fg, candidates) => {
    let worst = null;
    for (const { under, against } of candidates) {
      const text = blend(fg, under);
      const ratio = contrastRatio(text, against);
      if (!worst || ratio < worst.ratio) worst = { label, variable, fg: toHex(text), bg: toHex(against), ratio };
    }
    checks.push(worst);
  };
  for (const variable of TEXT_COLOR_VARIABLES) {
    const fg = color(variable);
    if (fg) measure(variable === '--ot-color' ? 'text' : variable.slice(5, -6), variable, fg, pairs);
  }
  // Key words sit on their highlight when it is not transparent.
  const keyColor = color('--ot-key-color');
  const highlight = color('--ot-key-highlight');
  if (keyColor && highlight) {
    const keyPairs =
      highlight.a === 0
        ? pairs
        : videos
            .map((video) => blend(highlight, blend(bg, video)))
            .map((surface) => ({ under: surface, against: surface }));
    measure('key', '--ot-key-color', keyColor, keyPairs);
  }
  return { mode, checks, problems };
}

const SHAPES = ['wide', 'tall'];

/** Where a variant applies, for messages: "wide layout", "tall layout of profile square", plus " in <media>". */
function describeVariant({ shape, profile, media }) {
  return `${shape} layout${profile ? ` of profile ${profile}` : ''}${media ? ` in ${media}` : ''}`;
}

/**
 * contrastReport() for every variant a pack defines: each shape, with no profile and with each profile id its rules
 * use, plus each @media block that sets variables.
 */
export function packContrast(baseCss, packCss, name, shapes = SHAPES) {
  const variants = [];
  for (const shape of shapes) {
    for (const profile of [undefined, ...packProfiles(packCss, name)]) {
      for (const media of [null, ...variableMediaContexts(packCss, name)]) {
        const report = contrastReport(packVariables(baseCss, packCss, name, { shape, media, profile }));
        variants.push({ shape, profile, media, ...report });
      }
    }
  }
  const ratios = variants.flatMap((variant) => variant.checks.map((check) => check.ratio));
  return { variants, lowest: ratios.length ? Math.min(...ratios) : null };
}

// ---------------------------------------------------------------------------------------------------
// Lint: the rules every pack's style.css follows (docs/contributing/style-packs.md explains why).

/** Rule ids and what each one guarantees; test/style-packs.test.ts runs one test per rule per pack. */
export const LINT_RULES = {
  syntax: 'is flat CSS with balanced braces (no nesting)',
  'at-rules': 'uses only @media, @supports, @container and its own @keyframes',
  important: 'does not use !important',
  external: 'loads nothing external (no @import, url() or web fonts)',
  scope: 'scopes every selector to its .ot-theme-<name> layer',
  'plain-mode': 'styles semantic classes and the spoken word only under .ot-mode-styled',
  variables: 'sets base variables or its own --ot-pack-* values, on the layer only',
  colors: 'takes text and background colors from the base variables',
  layout: 'leaves positioning and stacking to base.css (no position: fixed, no z-index)',
  hiding: 'never hides, fades or replaces caption text',
  fonts: 'names system or locally installed fonts and ends with a generic family',
  size: 'keeps text in cqw and at least as large as the default in wide and tall layouts',
  motion: 'turns its motion off under prefers-reduced-motion: reduce',
  contrast: `keeps every text color at ${MIN_CONTRAST}:1 or more against its box or outline`,
  classes: 'makes every semantic class look different from plain text in styled mode',
};

export const SEMANTIC_CLASSES = ['emphasis', 'key', 'brand', 'number', 'soft'];
const GENERIC_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
];
const COLOR_PROPERTIES = ['color', 'background', 'background-color', 'background-image', '-webkit-text-fill-color'];
const MOTION_PROPERTIES = ['transition', 'transition-property', 'transition-duration', 'animation', 'animation-name'];

const fontWeight = (value) => (value === 'bold' ? 700 : value === 'normal' ? 400 : Number(value));
const sameColor = (a, b) =>
  !!a && !!b && ['r', 'g', 'b'].every((k) => Math.round(a[k]) === Math.round(b[k])) && Math.abs(a.a - b.a) < 0.01;
const normalizeSelector = (selector) => selector.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim();

/** What every lint rule reads: the pack's CSS (also without comments), its parsed rules, base.css's variables, its scope. */
function lintContext(baseCss, css, name) {
  const { rules, atRules } = parseCss(css);
  const inKeyframes = (rule) => rule.atRules.some((at) => /^@(-webkit-)?keyframes\b/i.test(at));
  return {
    baseCss, css, name, rules, atRules,
    src: css.replace(/\/\*[\s\S]*?\*\//g, ''),
    baseVars: baseVariables(baseCss),
    scope: `.ot-theme-${name}`,
    scopeRe: new RegExp(`\\.ot-theme-${name.replace(/[-]/g, '\\-')}(?![\\w-])`),
    // rules inside @keyframes style no element
    styleRules: rules.filter((rule) => !inKeyframes(rule)),
  };
}

/** The braces balance and no rule nests another. */
function lintSyntax(pack, report) {
  const { src, rules } = pack;
  if ((src.match(/\{/g) ?? []).length !== (src.match(/\}/g) ?? []).length) report('syntax', 'unbalanced { and }');
  for (const rule of rules) if (rule.body.includes('{')) report('syntax', `"${rule.selector}": nested rules are not supported`);
}

/** Only @media, @supports, @container and @keyframes ot-<pack>-…. */
function lintAtRules(pack, report) {
  const { name, atRules } = pack;
  for (const at of atRules) {
    const kind = /^@([\w-]+)/.exec(at.prelude)?.[1]?.toLowerCase();
    if (kind === 'keyframes') {
      const keyframesName = at.prelude.slice('@keyframes'.length).trim();
      if (!keyframesName.startsWith(`ot-${name}-`)) {
        report('at-rules', `@keyframes ${keyframesName}: name it ot-${name}-<something> (keyframe names are global)`);
      }
    } else if (!['media', 'supports', 'container'].includes(kind ?? '')) {
      report('at-rules', `${at.prelude.split(/\s/)[0]} is not allowed in a style pack`);
    }
  }
}

/** No !important. */
function lintImportant(pack, report) {
  const { rules } = pack;
  for (const rule of rules) {
    for (const d of rule.declarations) if (d.important) report('important', `"${rule.selector}" ${d.property}: remove !important`);
  }
}

/** Nothing is loaded: no @import, url(), image-set() or @font-face. */
function lintExternal(pack, report) {
  const { src } = pack;
  for (const [pattern, what] of [[/@import\b/i, '@import'], [/\burl\(/i, 'url()'], [/image-set\(/i, 'image-set()'], [/@font-face\b/i, '@font-face']]) {
    if (pattern.test(src)) report('external', `${what}: a pack loads nothing; name fonts in --ot-font and let the page load them`);
  }
}

/** Every selector is inside the pack's theme class and styles no sibling of the layer. */
function lintScope(pack, report) {
  const { scope, scopeRe, styleRules } = pack;
  for (const rule of styleRules) {
    for (const selector of splitSelectorList(rule.selector)) {
      const at = selector.search(scopeRe);
      if (at === -1) {
        report('scope', `"${selector}" is not scoped to ${scope}`);
        continue;
      }
      const after = selector.slice(at + scope.length);
      const combinator = /^[^\s>+~]*\s*([>+~])?/.exec(after)?.[1];
      if (combinator === '+' || combinator === '~') report('scope', `"${selector}" styles a sibling of the caption layer`);
    }
  }
}

/** Classes and the spoken word are styled only in styled mode. */
function lintPlainMode(pack, report) {
  const { styleRules } = pack;
  const classOrActive = new RegExp(`\\.ot-(${[...SEMANTIC_CLASSES, 'active'].join('|')})(?![\\w-])`);
  for (const rule of styleRules) {
    for (const selector of splitSelectorList(rule.selector)) {
      const withoutNot = selector.replace(/:not\([^)]*\)/g, '');
      if (classOrActive.test(withoutNot) && !/\.ot-mode-styled(?![\w-])/.test(withoutNot)) {
        report('plain-mode', `"${selector}" styles a class or the spoken word outside .ot-mode-styled (plain mode must stay plain)`);
      }
    }
  }
}

/** Variables are set on the layer, and are base.css's or the pack's own --ot-pack-*. */
function lintVariables(pack, report) {
  const { name, src, rules, baseVars, scope } = pack;
  const packVars = new Set();
  for (const rule of rules) {
    const custom = rule.declarations.filter((d) => d.property.startsWith('--'));
    if (custom.length === 0) continue;
    const onLayer = splitSelectorList(rule.selector).every((s) => layerRuleShape(s, name) !== null);
    if (!onLayer) {
      report('variables', `"${rule.selector}": set variables on .ot-layer${scope} (optionally with .ot-tall or .ot-profile-<id>)`);
    }
    for (const d of custom) {
      if (d.property.startsWith('--ot-pack-')) packVars.add(d.property);
      else if (!d.property.startsWith('--ot-')) report('variables', `${d.property}: name a value of your own --ot-pack-*`);
      else if (!(d.property in baseVars)) {
        report('variables', `${d.property} is not a base.css variable (for a value of your own, use --ot-pack-*)`);
      }
    }
  }
  for (const [, used] of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!(used in baseVars) && !packVars.has(used)) report('variables', `var(${used}) is not defined by base.css or this pack`);
  }
}

/** Colors come from base variables, so the contrast check sees them. */
function lintColors(pack, report) {
  const { styleRules } = pack;
  for (const rule of styleRules) {
    for (const d of rule.declarations) {
      if (!COLOR_PROPERTIES.includes(d.property.toLowerCase())) continue;
      const rest = d.value
        .replace(/var\(\s*(--ot-[\w-]+)\s*\)/g, (match, variable) => (variable.startsWith('--ot-pack-') ? match : ''))
        .replace(/\b(none|transparent|inherit|initial|unset|revert|currentcolor)\b/gi, '')
        .trim();
      if (rest) report('colors', `"${rule.selector}" ${d.property}: ${d.value}: use a base variable (e.g. var(--ot-key-highlight)) so the contrast check covers it`);
    }
  }
}

/** No position: fixed, no z-index. */
function lintLayout(pack, report) {
  const { styleRules } = pack;
  for (const rule of styleRules) {
    for (const d of rule.declarations) {
      if (d.property === 'position' && /\bfixed\b/.test(d.value)) report('layout', `"${rule.selector}": position: fixed escapes the player`);
      if (d.property === 'z-index') report('layout', `"${rule.selector}": z-index would paint captions over video.js menus`);
    }
  }
}

/** Nothing hides the captions or adds text. */
function lintHiding(pack, report) {
  const { styleRules } = pack;
  for (const rule of styleRules) {
    for (const d of rule.declarations) {
      const value = d.value.trim().toLowerCase();
      if (d.property === 'display' && value === 'none') report('hiding', `"${rule.selector}": display: none hides captions`);
      if (d.property === 'visibility' && value !== 'visible') report('hiding', `"${rule.selector}": visibility: ${value} hides captions`);
      if (d.property === 'opacity') report('hiding', `"${rule.selector}": opacity: put transparency in a color variable, where the contrast check sees it`);
      if (d.property === 'font-size' && parseFloat(value) === 0) report('hiding', `"${rule.selector}": font-size: 0 hides captions`);
      if (d.property === 'content' && !['""', "''", 'none', 'normal'].includes(value)) {
        report('hiding', `"${rule.selector}": content: ${d.value} adds text the captions do not contain`);
      }
    }
  }
}

/** Text size in cqw, not below the default, and a font list ending in a generic family (per shape and profile). */
function lintSizeAndFonts(pack, report) {
  const { baseCss, css, name } = pack;
  const fontVariants = new Set();
  const sizeVariants = SHAPES.flatMap((shape) => [undefined, ...packProfiles(css, name)].map((profile) => ({ shape, profile })));
  for (const { shape, profile } of sizeVariants) {
    const vars = packVariables(baseCss, css, name, { shape, profile });
    const defaults = packVariables(baseCss, '', name, { shape });
    fontVariants.add(resolveValue(vars['--ot-font'], vars));
    const size = resolveValue(vars['--ot-font-size'], vars);
    const scale = Number(resolveValue(vars['--ot-scale'], vars));
    const effective = (v) => parseFloat(resolveValue(v['--ot-font-size'], v)) * Number(resolveValue(v['--ot-scale'], v));
    if (!/^[\d.]+cqw$/.test(size)) report('size', `--ot-font-size: ${size}: use cqw (it scales with the picture)`);
    else if (!Number.isFinite(scale)) report('size', `--ot-scale must be a number`);
    else if (effective(vars) < effective(defaults) - 1e-6) {
      report('size', `text is ${effective(vars).toFixed(2)}cqw per 42-character line in the ${describeVariant({ shape, profile })}, smaller than the default ${effective(defaults).toFixed(2)}cqw`);
    }
  }
  for (const font of fontVariants) {
    const families = splitTopLevel(font ?? '', ',').map((f) => f.replace(/['"]/g, '').trim().toLowerCase());
    if (!GENERIC_FAMILIES.includes(families.at(-1) ?? '')) {
      report('fonts', `--ot-font: ${font}: end the list with a generic family such as sans-serif`);
    }
  }
}

/** Every text color keeps MIN_CONTRAST against its box or outline (per shape, profile and media query). */
function lintContrast(pack, report) {
  const { baseCss, css, name } = pack;
  const contrast = packContrast(baseCss, css, name);
  for (const variant of contrast.variants) {
    const where = describeVariant(variant);
    for (const message of variant.problems) report('contrast', `${message} (${where})`);
    for (const check of variant.checks) {
      if (check.ratio < MIN_CONTRAST) {
        report('contrast', `${check.label} (${check.variable}) ${check.fg} on ${check.bg} is ${check.ratio.toFixed(2)}:1 in the ${where}; needs ${MIN_CONTRAST}:1`);
      }
    }
  }
}

/** Every animation or transition is turned off under prefers-reduced-motion: reduce. */
function lintMotion(pack, report) {
  const { styleRules } = pack;
  const reducedMotion = (rule) => rule.atRules.some((at) => /prefers-reduced-motion\s*:\s*reduce/.test(at));
  const overrides = styleRules.filter(reducedMotion);
  for (const rule of styleRules.filter((r) => !reducedMotion(r))) {
    for (const d of rule.declarations) {
      const moves =
        (MOTION_PROPERTIES.includes(d.property) && !/^(none|0s?)$/i.test(d.value.trim())) ||
        (d.property === 'transform' && /\.ot-active\b/.test(rule.selector) && d.value.trim() !== 'none');
      if (!moves) continue;
      const property = d.property.split('-')[0];
      const covered = overrides.some(
        (o) =>
          normalizeSelector(o.selector) === normalizeSelector(rule.selector) &&
          o.declarations.some((od) => od.property.split('-')[0] === property && /^(none|0s?)$/i.test(od.value.trim())),
      );
      if (!covered) {
        report('motion', `"${rule.selector}" ${d.property}: add the same selector with ${property}: none inside @media (prefers-reduced-motion: reduce)`);
      }
    }
  }
}

/** Every semantic class looks different from plain text in styled mode. */
function lintClasses(pack, report) {
  const { baseCss, css, name, styleRules } = pack;
  const vars = packVariables(baseCss, css, name, { shape: 'wide' });
  const value = (variable) => resolveValue(vars[variable], vars);
  const colorOf = (variable) => parseColor(value(variable));
  const text = colorOf('--ot-color');
  const weight = fontWeight(value('--ot-font-weight'));
  const hasClassRule = (cls) =>
    styleRules.some(
      (rule) =>
        rule.declarations.some((d) => !d.property.startsWith('--')) &&
        splitSelectorList(rule.selector).some((s) => new RegExp(`\\.ot-${cls}(?![\\w-])`).test(s) && s.includes('.ot-mode-styled')),
    );
  const visible = {
    emphasis: () => !sameColor(colorOf('--ot-emphasis-color'), text) || value('--ot-emphasis-style') !== 'normal',
    key: () =>
      fontWeight(value('--ot-key-weight')) !== weight ||
      (colorOf('--ot-key-highlight')?.a ?? 0) > 0 ||
      !sameColor(colorOf('--ot-key-color'), text),
    brand: () => !sameColor(colorOf('--ot-brand-color'), text) || fontWeight(value('--ot-brand-weight')) !== weight,
    // Tabular figures alone are invisible, so numbers need their own color.
    number: () => !sameColor(colorOf('--ot-number-color'), text),
    soft: () => !sameColor(colorOf('--ot-soft-color'), text),
  };
  for (const cls of SEMANTIC_CLASSES) {
    if (!visible[cls]() && !hasClassRule(cls)) report('classes', `${cls} words look like plain text: give --ot-${cls}-* a different value or add a styled rule`);
  }
}

/** The lint rules, in the order their problems are reported (LINT_RULES names them). */
const LINTERS = [
  lintSyntax,
  lintAtRules,
  lintImportant,
  lintExternal,
  lintScope,
  lintPlainMode,
  lintVariables,
  lintColors,
  lintLayout,
  lintHiding,
  lintSizeAndFonts,
  lintContrast,
  lintMotion,
  lintClasses,
];

/**
 * Checks a pack's style.css. `name` is the pack name (the scope is .ot-theme-<name>).
 * Returns problems as [{ rule, message }]; `rule` is a key of LINT_RULES. An empty list means the pack passes.
 */
export function lintStyle(baseCss, css, name) {
  const problems = [];
  const report = (rule, message) => problems.push({ rule, message });
  const pack = lintContext(baseCss, css, name);
  for (const lint of LINTERS) lint(pack, report);
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Build

/** Names that would overwrite other files in dist/themes. */
const RESERVED_NAMES = ['base', 'packs'];

/**
 * Copies base.css and every pack's style.css to `outDir` (dist/themes/<name>.css, the paths users import)
 * and writes `outDir`/packs.json, the manifest the gallery and the demo read. Returns the manifest.
 */
export function buildStylePacks({ stylesDir, baseCssPath, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const baseCss = readFileSync(baseCssPath, 'utf8');
  copyFileSync(baseCssPath, join(outDir, 'base.css'));
  const packs = [];
  for (const folder of listPacks(stylesDir)) {
    const pack = readPack(join(stylesDir, folder), folder);
    if (!pack.meta || pack.css === null) throw new Error(`style pack "${folder}" needs both pack.json and style.css`);
    if (RESERVED_NAMES.includes(folder)) throw new Error(`style pack name "${folder}" is reserved`);
    if (pack.meta.name !== folder) throw new Error(`style pack "${folder}": pack.json name is "${pack.meta.name}"`);
    copyFileSync(join(pack.dir, 'style.css'), join(outDir, `${folder}.css`));
    const { $schema, ...meta } = pack.meta;
    const contrast = packContrast(baseCss, pack.css, folder);
    packs.push({
      ...meta,
      css: `${folder}.css`,
      source: `packages/videojs/styles/${folder}/`,
      lowestContrast: contrast.lowest === null ? null : Math.floor(contrast.lowest * 10) / 10,
    });
  }
  const manifest = { packs };
  writeFileSync(join(outDir, 'packs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ---------------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = fileURLToPath(new URL('..', import.meta.url));
  const options = {
    stylesDir: join(pkg, 'styles'),
    baseCssPath: join(pkg, 'src/themes/base.css'),
    outDir: join(pkg, 'dist/themes'),
  };
  const build = () => {
    try {
      const { packs } = buildStylePacks(options);
      console.log(`style packs: ${packs.map((pack) => pack.name).join(', ')} → dist/themes`);
      // Early feedback while designing; `npm run test:styles` is the full check.
      const baseCss = readFileSync(options.baseCssPath, 'utf8');
      for (const { name } of packs) {
        const css = readFileSync(join(options.stylesDir, name, 'style.css'), 'utf8');
        for (const problem of lintStyle(baseCss, css, name)) console.warn(`  ${name}: [${problem.rule}] ${problem.message}`);
      }
    } catch (error) {
      console.error(`style packs: ${error.message}`);
      if (!process.argv.includes('--watch')) process.exitCode = 1;
    }
  };
  build();
  if (process.argv.includes('--watch')) {
    let timer;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(build, 100);
    };
    watch(options.stylesDir, { recursive: true }, rebuild);
    watch(options.baseCssPath, rebuild);
    console.log('watching packages/videojs/styles for changes (Ctrl+C to stop)');
  }
}
