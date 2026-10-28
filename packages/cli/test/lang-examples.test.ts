import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_PROFILES, type ProfileRules, type WordRange } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { findPack } from '../src/lang/index.js';
import { breakCost, noBreakAfter, numberGroupEnds } from '../src/segment/groups.js';
import { linesCost, type SplitContext } from '../src/segment/splitter.js';
import { tokenizeDisplay } from '../src/text/normalize.js';

/*
 * Caption examples per language: packages/cli/src/lang/examples/<code>.txt (format: see the README in that folder
 * and docs/contributing/languages.md).
 *
 * What is compared, for each `good:` line and every `bad:` line after it (the same words, cut differently):
 * - by default, the break cost: the sum of the line cutter's soft cost (breakCost in src/segment/groups.ts) at
 *   every "/" in the line. Line length and balance are left out, so the example tests the language rules alone;
 * - after a `profile:` directive, the full line-layout cost the splitter minimizes for one cue (linesCost in
 *   src/segment/splitter.ts: break costs, one point per extra line, distance from evenly balanced lines, a lone
 *   word on a line), and every `good` line must fit that profile's characters per line and line count.
 * `good` must cost strictly less than `bad`. A `keep:` line passes when the cutter never breaks inside the phrase
 * in [brackets] (the whole line without brackets): numbers with their unit or rate, names and glossary terms.
 * An example whose title starts with "known issue:" documents a gap: it is expected to fail until the rules are fixed.
 */

const DIR = new URL('../src/lang/examples/', import.meta.url);

type Example =
  | { kind: 'pair'; title: string; line: number; good: string; bad: string; profile?: ProfileSpec; glossary: string[] }
  | { kind: 'keep'; title: string; line: number; text: string; glossary: string[] };

interface ProfileSpec { name: string; rules: ProfileRules }

function profileOf(value: string): ProfileSpec | undefined {
  if (value === 'none') return undefined;
  if (value === 'horizontal' || value === 'vertical') return { name: value, rules: DEFAULT_PROFILES[value].rules };
  const m = /^(\d+)x(\d+)$/.exec(value);
  if (!m) throw new Error(`profile must be horizontal, vertical, none or <chars>x<lines> (such as 32x2), got "${value}"`);
  return { name: value, rules: { maxCharsPerLine: Number(m[1]), maxLines: Number(m[2]) } };
}

/** Parse one examples file. Throws on a malformed line, with its line number. */
function parseExamples(source: string): Example[] {
  const out: Example[] = [];
  let title = '';
  let profile: ProfileSpec | undefined;
  let glossary: string[] = [];
  let good: { text: string; line: number } | undefined;
  let sawBad = false;
  const closeGood = (line: number) => {
    if (good && !sawBad) throw new Error(`line ${good.line}: "good:" needs at least one "bad:" line after it (before line ${line})`);
    good = undefined;
    sawBad = false;
  };
  source.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const text = raw.trim();
    if (text === '') return;
    if (text.startsWith('#')) {
      closeGood(line);
      title = text.replace(/^#+\s*/, '');
      return;
    }
    const m = /^([a-z]+):\s*(.*)$/.exec(text);
    if (!m) throw new Error(`line ${line}: expected "good:", "bad:", "keep:", "profile:", "glossary:" or a "#" comment, got "${text}"`);
    const [, key, value] = m;
    if (key !== 'bad') closeGood(line);
    if (key === 'profile') profile = profileOf(value);
    else if (key === 'glossary') glossary = value.split(',').map((g) => g.trim()).filter(Boolean);
    else if (key === 'good') good = { text: value, line };
    else if (key === 'bad') {
      if (!good) throw new Error(`line ${line}: "bad:" must follow a "good:" line`);
      out.push({ kind: 'pair', title: title || `line ${good.line}`, line, good: good.text, bad: value, profile, glossary });
      sawBad = true;
    } else if (key === 'keep') out.push({ kind: 'keep', title: title || `line ${line}`, line, text: value, glossary });
    else throw new Error(`line ${line}: unknown key "${key}:"`);
  });
  closeGood(Number.POSITIVE_INFINITY);
  return out;
}

/** Display words of a cue written as "line one / line two", and the inclusive word range of each line. */
function cueOf(text: string): { words: string[]; lines: WordRange[] } {
  const words: string[] = [];
  const lines: WordRange[] = [];
  for (const part of text.split(' / ')) {
    const ws = tokenizeDisplay(part);
    if (ws.length === 0) throw new Error(`empty line in "${text}"`);
    lines.push([words.length, words.length + ws.length - 1]);
    words.push(...ws);
  }
  return { words, lines };
}

function contextOf(words: string[], lang: string, glossary: string[], rules: ProfileRules): SplitContext {
  return {
    texts: words,
    starts: words.map((_, k) => k * 0.4),
    ends: words.map((_, k) => k * 0.4 + 0.35),
    keep: noBreakAfter(words, lang, glossary),
    tails: numberGroupEnds(words, lang),
    lang,
    rules,
  };
}

/** Break cost of a cue: breakCost at every line end but the last. */
function breakSum(ctx: SplitContext, lines: readonly WordRange[]): number {
  return lines.slice(0, -1).reduce((sum, [from, to]) => sum + breakCost(ctx, to, { lineStart: from }), 0);
}

function costOf(text: string, lang: string, glossary: string[], profile: ProfileSpec | undefined): { words: string[]; cost: number; lines: WordRange[] } {
  const { words, lines } = cueOf(text);
  const ctx = contextOf(words, lang, glossary, profile?.rules ?? { maxCharsPerLine: Infinity, maxLines: Infinity });
  return { words, lines, cost: profile ? linesCost(ctx, lines) : breakSum(ctx, lines) };
}

function checkPair(ex: Extract<Example, { kind: 'pair' }>, lang: string): void {
  const good = costOf(ex.good, lang, ex.glossary, ex.profile);
  const bad = costOf(ex.bad, lang, ex.glossary, ex.profile);
  expect(bad.words.join(' '), `line ${ex.line}: good and bad must have the same words`).toBe(good.words.join(' '));
  expect(ex.good, `line ${ex.line}: good and bad must be cut differently`).not.toBe(ex.bad);
  if (ex.profile) {
    const { maxCharsPerLine, maxLines } = ex.profile.rules;
    expect(good.lines.length, `"${ex.good}" has more lines than ${ex.profile.name} allows`).toBeLessThanOrEqual(maxLines);
    for (const [from, to] of good.lines) {
      const line = good.words.slice(from, to + 1).join(' ');
      expect(line.length, `"${line}" is longer than ${maxCharsPerLine} characters (${ex.profile.name})`).toBeLessThanOrEqual(maxCharsPerLine);
    }
  }
  const what = ex.profile ? `line-layout cost at ${ex.profile.name}` : 'break cost';
  expect(good.cost, `${what}: good "${ex.good}" = ${good.cost}, bad "${ex.bad}" = ${bad.cost}`).toBeLessThan(bad.cost);
}

function checkKeep(ex: Extract<Example, { kind: 'keep' }>, lang: string): void {
  const open = ex.text.indexOf('[');
  const close = ex.text.indexOf(']');
  if ((open < 0) !== (close < 0) || close < open) throw new Error(`line ${ex.line}: unbalanced [brackets]`);
  const [head, phraseText, tail] = open < 0 ? ['', ex.text, ''] : [ex.text.slice(0, open), ex.text.slice(open + 1, close), ex.text.slice(close + 1)];
  const words = tokenizeDisplay(head + phraseText + tail);
  const start = tokenizeDisplay(head).length;
  const count = tokenizeDisplay(phraseText).length;
  // the phrase's last word may carry punctuation that follows "]" ("[€12 a month].")
  const phrase = words.slice(start, start + count);
  expect(phrase.length, `line ${ex.line}: a kept phrase needs two words at least`).toBeGreaterThan(1);
  const keep = noBreakAfter(words, lang, ex.glossary);
  const splits = phrase.slice(0, -1).flatMap((w, k) => (keep[start + k] ? [] : [`${w} | ${phrase[k + 1]}`]));
  expect(splits, `line ${ex.line}: the cutter may break "${phrase.join(' ')}" at`).toEqual([]);
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort();

it('has example files', () => {
  expect(files.length).toBeGreaterThan(0);
});

for (const file of files) {
  const lang = file.replace(/\.txt$/, '');
  describe(`lang/examples/${file}`, () => {
    it('belongs to a registered language pack', () => {
      expect(findPack(lang)?.code, `no language pack "${lang}" is registered in src/lang/index.ts`).toBe(lang);
    });
    const examples = parseExamples(readFileSync(new URL(file, DIR), 'utf8'));
    for (const ex of examples) {
      const known = /^known issue:/i.test(ex.title);
      const name = `${ex.title} (line ${ex.line})`;
      const run = () => (ex.kind === 'pair' ? checkPair(ex, lang) : checkKeep(ex, lang));
      if (known) it.fails(name, run);
      else it(name, run);
    }
  });
}

describe('examples file format', () => {
  it('parses pairs, keeps and directives', () => {
    const ex = parseExamples([
      '# a title',
      'profile: vertical',
      'glossary: DriveCover, Lumora',
      'good: one two / three',
      'bad:  one / two three',
      'bad:  one two three / four',
      '# kept',
      'keep: we pay [€12 a month].',
    ].join('\n'));
    expect(ex.map((e) => e.kind)).toEqual(['pair', 'pair', 'keep']);
    expect(ex[0]).toMatchObject({ title: 'a title', good: 'one two / three', bad: 'one / two three', glossary: ['DriveCover', 'Lumora'] });
    expect(ex[0].kind === 'pair' && ex[0].profile?.rules.maxCharsPerLine).toBe(22);
  });

  it('rejects malformed files with a line number', () => {
    expect(() => parseExamples('good: a / b\n# next')).toThrow(/line 1: "good:" needs at least one "bad:"/);
    expect(() => parseExamples('bad: a / b')).toThrow(/line 1: "bad:" must follow/);
    expect(() => parseExamples('nice: a')).toThrow(/line 1: unknown key/);
    expect(() => parseExamples('just text')).toThrow(/line 1: expected/);
    expect(() => parseExamples('profile: wide')).toThrow(/profile must be/);
  });
});
