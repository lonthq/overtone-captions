import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runLanguages } from '../src/commands/languages.js';
import { LEVELS, coverageOf, fieldsOf } from '../src/lang/coverage.js';
import { DECOYS, PACKS, findPack, getPack, langOf, neutral, type LanguagePack } from '../src/lang/index.js';
import { memoryLogger } from '../src/log.js';
import { plain } from '../src/segment/groups.js';
import { detectLanguage } from '../src/text/detect.js';

// Checks every registered language pack: codes, registration, how list entries are written, duplicates and
// collisions with other packs. A contributor's checklist in test form; see docs/contributing/languages.md.

const LANG_DIR = new URL('../src/lang/', import.meta.url);
const EXAMPLES_DIR = new URL('../src/lang/examples/', import.meta.url);
const englishNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** Lowercase letters only, accents allowed: how detection stopwords are written. */
const isStopword = (w: string) => /^\p{Ll}+$/u.test(w);
/** A display word as the line cutter compares it: lowercase, punctuation removed except apostrophes (see plain). */
const isDisplayWord = (w: string) => w.length > 0 && plain(w) === w && w === w.toLowerCase();
/** A comparison key: lowercase letters and digits, no accents, no apostrophes. */
const isKey = (w: string) => /^[\p{Ll}\p{N}]+$/u.test(w) && w.normalize('NFKD') === w;

const duplicates = (xs: readonly string[]): string[] => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
const bad = (xs: readonly string[] | undefined, ok: (w: string) => boolean): string[] => (xs ?? []).filter((w) => !ok(w));

/** A list of a pack, with how its entries must be written; `values`: entries may repeat (the values of a table). */
interface PackList { field: string; words: readonly string[]; ok: (w: string) => boolean; values?: boolean }

/** Every list of a pack. */
function lists(p: LanguagePack): PackList[] {
  const t = p.text ?? {};
  const n = p.numbers ?? {};
  const c = p.lineCutting ?? {};
  const out: Array<Omit<PackList, 'words'> & { words: readonly string[] | undefined }> = [
    { field: 'aliases', words: p.aliases, ok: (w: string) => /^[a-z]+$/.test(w) },
    { field: 'detection.stopwords', words: p.detection?.stopwords, ok: isStopword },
    { field: 'text.fillers', words: t.fillers, ok: (w: string) => /^[a-z]+$/.test(w) },
    { field: 'text.contractions (keys)', words: Object.keys(t.contractions ?? {}), ok: (w: string) => /^[\p{Ll}']+$/u.test(w) },
    { field: 'text.contractions (values)', words: Object.values(t.contractions ?? {}), ok: (w: string) => /^[\p{Ll}]+( [\p{Ll}]+)*$/u.test(w), values: true },
    { field: 'text.accentedNumbers (keys)', words: Object.keys(t.accentedNumbers ?? {}), ok: isKey },
    { field: 'text.dottedClockTimes', words: [...(t.dottedClockTimes?.suffixes ?? []), ...(t.dottedClockTimes?.prepositions ?? [])], ok: isKey },
    { field: 'numbers.ordinalSuffixes', words: n.ordinalSuffixes, ok: (w: string) => /^\p{Ll}+$/u.test(w) },
    { field: 'numbers.currencyWords (values)', words: Object.values(n.currencyWords ?? {}), ok: (w: string) => /^[a-z]{3}$/.test(w), values: true },
    { field: 'numbers.scaleWords', words: Object.keys(n.scaleWords ?? {}), ok: isKey },
    ...(['per', 'periods', 'ratio'] as const).map((f) => ({ field: `numbers.rates.${f}`, words: n.rates?.[f], ok: (w: string) => isKey(w) && isDisplayWord(w) })),
    { field: 'numbers.rates.ratioFollowers', words: Object.entries(n.rates?.ratioFollowers ?? {}).flat(), ok: (w: string) => isKey(w) && isDisplayWord(w), values: true },
    ...(['abbreviations', 'endingAbbreviations'] as const).map((f) => ({ field: `sentences.${f}`, words: p.sentences?.[f], ok: (w: string) => /^[\p{Ll}.]+\.$/u.test(w) })),
    { field: 'names.particles', words: p.names?.particles, ok: isDisplayWord },
    { field: 'names.sentenceOpeners', words: p.names?.sentenceOpeners, ok: isDisplayWord },
  ];
  // the currency and percent words of the neutral pack are symbols and codes ("€", "%")
  if (p !== neutral) {
    out.push({ field: 'numbers.currencyWords (keys)', words: Object.keys(n.currencyWords ?? {}), ok: isKey });
    out.push({ field: 'numbers.percentWords', words: n.percentWords ?? [], ok: isKey });
  }
  for (const [field, words] of Object.entries(c)) out.push({ field: `lineCutting.${field}`, words: words as readonly string[], ok: isDisplayWord });
  return out.filter((l): l is PackList => l.words !== undefined);
}

describe('registry', () => {
  it('registers every pack file in src/lang under its own code', async () => {
    const files = readdirSync(LANG_DIR).filter((f) => /^[a-z]{2,3}\.ts$/.test(f));
    for (const file of files) {
      const mod = (await import(new URL(file, LANG_DIR).href)) as Record<string, LanguagePack>;
      const packs = Object.values(mod).filter((v) => typeof v === 'object' && v !== null && 'code' in v);
      expect(packs, `${file} should export exactly one language pack`).toHaveLength(1);
      expect(packs[0].code, `${file} should hold the pack "${file.slice(0, -3)}"`).toBe(file.slice(0, -3));
      expect(PACKS, `${file} is not added to PACKS in src/lang/index.ts`).toContain(packs[0]);
    }
    expect(files).toHaveLength(PACKS.length);
  });

  it('has unique codes, names and aliases', () => {
    expect(duplicates(PACKS.map((p) => p.code))).toEqual([]);
    expect(duplicates(PACKS.map((p) => p.name))).toEqual([]);
    expect(duplicates(PACKS.flatMap((p) => p.aliases ?? []))).toEqual([]);
  });

  it('finds packs by language tag and falls back to the neutral pack', () => {
    expect(getPack('nl-BE').code).toBe('nl');
    expect(getPack('pt_BR').code).toBe('pt');
    expect(getPack('sv')).toBe(neutral);
    expect(getPack(undefined)).toBe(neutral);
    expect(findPack('constructor')).toBeUndefined();
    expect(langOf('xx')).toBe('other');
  });

  it('keeps the neutral pack language-neutral', () => {
    expect(neutral.code).toBe('other');
    expect(neutral.detection ?? neutral.lineCutting ?? neutral.sentences ?? neutral.names).toBeUndefined();
  });

  it('never lists a language both as a detected pack and as a decoy', () => {
    const detected = PACKS.filter((p) => p.detection).map((p) => p.code);
    expect(Object.keys(DECOYS).filter((c) => detected.includes(c))).toEqual([]);
  });
});

describe.each(PACKS.map((p) => [p.code, p] as const))('pack %s', (code, pack) => {
  it('has a valid BCP-47 primary language subtag', () => {
    expect(code, 'a lowercase two-letter (or three-letter) code').toMatch(/^[a-z]{2,3}$/);
    expect(Intl.getCanonicalLocales(code)).toEqual([code]);
    expect(englishNames.of(code), `"${code}" is not a known language`).not.toBe(code);
  });

  it('has a name, and a default locale for the same language', () => {
    expect(pack.name.length).toBeGreaterThan(0);
    if (englishNames.of(code) !== pack.name) console.warn(`[${code}] name "${pack.name}" differs from the standard English name "${englishNames.of(code)}"`);
    if (pack.defaultLocale !== undefined) {
      expect(pack.defaultLocale).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
      expect(pack.defaultLocale.split('-')[0]).toBe(code);
    }
  });

  it('writes every list entry in the form its field requires', () => {
    for (const { field, words, ok } of lists(pack)) expect(bad(words, ok), `${code}: ${field} (see the field's doc comment in src/lang/types.ts)`).toEqual([]);
    for (const [word, value] of Object.entries(pack.numbers?.scaleWords ?? {})) expect(value, `${code}: numbers.scaleWords.${word}`).toBeGreaterThan(1);
  });

  it('has no duplicates within a list or a word class', () => {
    for (const { field, words, values } of lists(pack)) if (!values) expect(duplicates(words), `${code}: ${field}`).toEqual([]);
    const c = pack.lineCutting ?? {};
    const pronouns = [...(c.subjectPronouns ?? []), ...(c.clauseWords ?? []), ...(c.ambiguousPronouns ?? [])];
    expect(duplicates(pronouns), `${code}: a word is in two of subjectPronouns, clauseWords, ambiguousPronouns`).toEqual([]);
    const noLineEnd = [...(c.articles ?? []), ...(c.prepositions ?? []), ...(c.possessives ?? []), ...(c.auxiliaries ?? [])];
    expect(duplicates(noLineEnd), `${code}: a word is in two of articles, prepositions, possessives, auxiliaries`).toEqual([]);
    const abbreviations = [...(pack.sentences?.abbreviations ?? []), ...(pack.sentences?.endingAbbreviations ?? [])];
    expect(duplicates(abbreviations), `${code}: a word is in both abbreviations and endingAbbreviations`).toEqual([]);
  });

  it('keeps related line-cutting lists consistent', () => {
    const c = pack.lineCutting ?? {};
    const pronouns = new Set([...(c.subjectPronouns ?? []), ...(c.clauseWords ?? []), ...(c.ambiguousPronouns ?? [])]);
    expect((c.demonstratives ?? []).filter((w) => !pronouns.has(w)), `${code}: demonstratives must also be pronouns`).toEqual([]);
    const conjunctions = new Set(c.conjunctions ?? []);
    expect((c.lineStartConjunctions ?? []).filter((w) => !conjunctions.has(w)), `${code}: lineStartConjunctions must also be conjunctions`).toEqual([]);
    const adjectives = new Set(c.adjectives ?? []);
    expect((c.notAdjectives ?? []).filter((w) => adjectives.has(w)), `${code}: a word is both an adjective and not an adjective`).toEqual([]);
  });

  it('never lists a real word of the language as a filler', () => {
    const words = new Set(pack.detection?.stopwords ?? []);
    expect([...(neutral.text?.fillers ?? []), ...(pack.text?.fillers ?? [])].filter((f) => words.has(f))).toEqual([]);
  });

  it('has a number-word parser that returns sane results', () => {
    const parse = pack.numbers?.parseWords;
    if (!parse) return;
    for (const w of pack.detection?.stopwords ?? []) {
      const r = parse([w, 'x'], 0);
      if (r) {
        expect(r.length, `${code}: parseWords("${w}")`).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(r.value)).toBe(true);
      }
    }
    expect(parse(['zzz'], 0)).toBeNull();
  });

  it('has caption examples when it has line-cutting rules', () => {
    if (!pack.lineCutting) return;
    const file = new URL(`${code}.txt`, EXAMPLES_DIR);
    expect(existsSync(file), `add src/lang/examples/${code}.txt`).toBe(true);
    const count = readFileSync(file, 'utf8').split('\n').filter((l) => /^(bad|keep):/.test(l.trim())).length;
    expect(count, `${code}: write at least 5 examples`).toBeGreaterThanOrEqual(5);
  });

  it('has enough detection stopwords to be detected reliably', () => {
    if (!pack.detection) return;
    expect(pack.detection.stopwords.length, `${code}: list 40–60 stopwords`).toBeGreaterThanOrEqual(30);
  });
});

describe('collisions between packs', () => {
  it('detects every language from its own stopwords (no pack takes over another)', () => {
    for (const p of PACKS.filter((x) => x.detection)) expect(detectLanguage(p.detection!.stopwords.join(' ')), p.code).toBe(p.code);
  });

  // warnings only: related languages share words
  const lists: Array<[string, readonly string[]]> = [
    ...PACKS.filter((p) => p.detection).map((p) => [p.code, p.detection!.stopwords] as [string, readonly string[]]),
    ...Object.entries(DECOYS),
  ];

  it('warns when two languages share most of their detection stopwords', () => {
    for (let i = 0; i < lists.length; i++) {
      for (let j = i + 1; j < lists.length; j++) {
        const [a, wa] = lists[i];
        const [b, wb] = lists[j];
        const shared = wa.filter((w) => new Set(wb).has(w));
        const share = shared.length / Math.min(wa.length, wb.length);
        // the decoys are close to each other on purpose (Danish and Norwegian)
        if (share > 0.4 && (findPack(a) || findPack(b))) console.warn(`detection: ${a} and ${b} share ${Math.round(share * 100)}% of their stopwords (${shared.join(', ')})`);
      }
    }
  });
});

describe('overtone languages', () => {
  it('lists every pack with its coverage', () => {
    const log = memoryLogger();
    expect(runLanguages(undefined, log)).toBe(0);
    for (const p of PACKS) expect(log.lines.some((l) => l.startsWith(`out: ${p.code} `) && l.endsWith(coverageOf(p)))).toBe(true);
    expect(coverageOf(getPack('en'))).toBe('full');
    expect(coverageOf(getPack('de'))).toBe('detection only');
    expect(coverageOf(getPack('fr'))).toBe('detection only');
    expect(coverageOf(neutral)).toBe('none');
  });

  it('shows every field of one pack, filled or not', () => {
    const log = memoryLogger();
    expect(runLanguages('nl-BE', log)).toBe(0);
    expect(log.lines[0]).toBe('out: nl  Dutch (Nederlands): full');
    expect(log.lines.filter((l) => /^out: {3}[+-] /.test(l))).toHaveLength(fieldsOf(getPack('nl')).length);
    expect(fieldsOf(getPack('de')).filter((f) => f.size > 0).map((f) => `${f.section}.${f.field}`)).toEqual(['detection.stopwords', 'names.particles']);
    expect(() => runLanguages('sv', memoryLogger())).toThrow(/No language pack for "sv"/);
  });
});

describe('docs/contributing/languages.md', () => {
  const doc = readFileSync(new URL('../../../docs/contributing/languages.md', import.meta.url), 'utf8');
  const rows = doc.split('\n').filter((l) => /^\| [^|]+ \| `[a-z]{2,3}` \|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const status = { full: '✅ Full', 'detection only': '🟡 Detection only', partial: '🟡 Partial', none: '⬜ Neutral rules' } as const;

  it('lists every pack in the support table, with its current coverage', () => {
    expect(rows.map((r) => r[1])).toEqual(PACKS.map((p) => `\`${p.code}\``));
    for (const p of PACKS) {
      const row = rows.find((r) => r[1] === `\`${p.code}\``)!;
      const expected = [p.name, `\`${p.code}\``, ...LEVELS.map((l) => (l.has(p) ? '✅' : '⬜')), status[coverageOf(p)]];
      expect(row, `update the row of ${p.name} in docs/contributing/languages.md`).toEqual(expected);
    }
  });
});
