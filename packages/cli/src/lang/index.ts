import { DECOYS } from './decoys.js';
import { de } from './de.js';
import { dict } from './dict.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { it } from './it.js';
import { neutral } from './neutral.js';
import { nl } from './nl.js';
import { pt } from './pt.js';
import type { LanguagePack, NumberWordParser } from './types.js';

export type * from './types.js';
export { DECOYS, dict, neutral };

/**
 * Registered language packs. To add a language, create `<code>.ts` next to this file and add it here. The order
 * is the order in which detection scores languages; it only matters for exact ties.
 */
export const PACKS: readonly LanguagePack[] = [en, nl, de, fr, es, it, pt];

/** The code of the neutral pack, used for any language without a pack. */
export const NEUTRAL = neutral.code;

/**
 * A language as the pipeline sees it: the code of a registered pack ('en', 'nl', 'de', …) or 'other' (the
 * neutral pack). Any other string behaves like 'other'.
 */
export type Lang = string;

const BY_CODE = new Map(PACKS.map((p) => [p.code, p]));

/** Primary subtag of a language tag: 'nl-BE' → 'nl', 'pt_BR' → 'pt'. */
const primary = (code: string | undefined): string => (code ?? '').toLowerCase().split(/[-_]/)[0];

/** The registered pack for a language tag ('nl', 'nl-BE'), or undefined when the language has none. */
export function findPack(code: string | undefined): LanguagePack | undefined {
  return BY_CODE.get(primary(code));
}

/** The pack for a language tag; the neutral pack for a language without one. */
export function getPack(code: string | undefined): LanguagePack {
  return findPack(code) ?? neutral;
}

/** 'en-US' → 'en', 'nl-NL' → 'nl', a language without a pack (or no language) → 'other'. */
export function langOf(code: string | undefined): Lang {
  return findPack(code)?.code ?? NEUTRAL;
}

// ---- shared lists: the entries of every pack apply to every text (names, numbers and abbreviations cross languages)

const ALL: readonly LanguagePack[] = [neutral, ...PACKS];
const union = (lists: ReadonlyArray<readonly string[] | undefined>): ReadonlySet<string> => new Set(lists.flatMap((l) => l ?? []));
const merged = <T>(tables: ReadonlyArray<Readonly<Record<string, T>> | undefined>): Readonly<Record<string, T>> =>
  dict(Object.assign({}, ...tables.filter((t) => t !== undefined)) as Record<string, T>);

/** Lists that apply to every language, merged from all packs. */
export const SHARED = {
  /** Abbreviations whose "." does not end a sentence (sentences.abbreviations). */
  abbreviations: union(ALL.map((p) => p.sentences?.abbreviations)),
  /** Abbreviations that end a sentence before a capital (sentences.endingAbbreviations). */
  endingAbbreviations: union(ALL.map((p) => p.sentences?.endingAbbreviations)),
  /** Lowercase particles inside names (names.particles). */
  nameParticles: union(ALL.map((p) => p.names?.particles)),
  /** Sentence openers that are not part of a name (names.sentenceOpeners). */
  sentenceOpeners: union(ALL.map((p) => p.names?.sentenceOpeners)),
  /** Currency words, codes and symbols → ISO code (numbers.currencyWords). */
  currency: merged(ALL.map((p) => p.numbers?.currencyWords)),
  /** Words for "percent" (numbers.percentWords). */
  percentWords: union(ALL.map((p) => p.numbers?.percentWords)),
  /**
   * The unit pieces the comparison keys put after a number: every currency code of `currency` ("eur", "usd", …,
   * as normalize.ts writes them) and "percent".
   */
  numberUnits: new Set([...Object.values(merged(ALL.map((p) => p.numbers?.currencyWords))).map((code) => code.toLowerCase()), 'percent']) as ReadonlySet<string>,
  /** Scale words after digits (numbers.scaleWords). */
  scaleWords: merged(ALL.map((p) => p.numbers?.scaleWords)),
} as const;

// ---- resolved rules: a pack's lists as lookup sets, with the fallbacks applied

/** Line-cutting lists as sets (see LineCuttingRules). */
export interface LineRules {
  /** Articles, prepositions, possessives and auxiliaries: a line never ends on one. */
  noLineEnd: ReadonlySet<string>;
  articles: ReadonlySet<string>;
  prepositions: ReadonlySet<string>;
  possessives: ReadonlySet<string>;
  auxiliaries: ReadonlySet<string>;
  /** Subject pronouns, clause words and ambiguous pronouns together. */
  pronouns: ReadonlySet<string>;
  subjectPronouns: ReadonlySet<string>;
  clauseWords: ReadonlySet<string>;
  questionWords: ReadonlySet<string>;
  demonstratives: ReadonlySet<string>;
  contractedPronouns: ReadonlySet<string>;
  lineStartConjunctions: ReadonlySet<string>;
  conjunctions: ReadonlySet<string>;
  adjectives: ReadonlySet<string>;
  adjectiveSuffixes: readonly string[];
  notAdjectives: ReadonlySet<string>;
}

/** Number-phrase continuations (see NumberRules.rates) as sets. */
export interface RateRules {
  per: ReadonlySet<string>;
  periods: ReadonlySet<string>;
  ratio: ReadonlySet<string>;
  ratioFollowers: Readonly<Record<string, string>>;
}

/** Everything the pipeline reads from a language pack, resolved for lookups. */
export interface Rules {
  fillers: ReadonlySet<string>;
  /** Fillers with repeated letters collapsed ("hmm" → "hm"), to match drawn-out forms. */
  collapsedFillers: ReadonlySet<string>;
  contractions: Readonly<Record<string, string>>;
  contractionSuffixes: ReadonlyArray<readonly [string, string]>;
  symbolWords: Readonly<Record<string, string>>;
  accentedNumbers: Readonly<Record<string, string>>;
  dottedClockTimes?: { suffixes: ReadonlySet<string>; prepositions: ReadonlySet<string> };
  parseWords?: NumberWordParser;
  decimalSeparator?: '.' | ',';
  /** Matches digits with an ordinal suffix ("1st", "3e"); group 1 holds the digits. */
  ordinalDigits: RegExp;
  rates?: RateRules;
  /** Undefined when the pack has no line-cutting rules: only punctuation, names and numbers guide the cutter. */
  lineCutting?: LineRules;
}

/** Collapse repeated letters: "uhhh" → "uh". */
export const collapseRepeats = (s: string): string => s.replace(/(.)\1+/g, '$1');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function resolve(pack: LanguagePack): Rules {
  const t = pack.text ?? {};
  const n = pack.numbers ?? {};
  const c = pack.lineCutting;
  const fillers = new Set([...(neutral.text?.fillers ?? []), ...(t.fillers ?? [])]);
  const set = (l: readonly string[] | undefined) => new Set(l ?? []);
  const ordinals = n.ordinalSuffixes ?? neutral.numbers?.ordinalSuffixes ?? [];
  return {
    fillers,
    collapsedFillers: new Set([...fillers].map(collapseRepeats)),
    contractions: dict(t.contractions ?? {}),
    contractionSuffixes: t.contractionSuffixes ?? [],
    symbolWords: dict(t.symbolWords ?? {}),
    accentedNumbers: dict(t.accentedNumbers ?? {}),
    dottedClockTimes: t.dottedClockTimes && { suffixes: set(t.dottedClockTimes.suffixes), prepositions: set(t.dottedClockTimes.prepositions) },
    parseWords: n.parseWords,
    decimalSeparator: n.decimalSeparator,
    ordinalDigits: ordinalPattern(ordinals),
    rates: n.rates && { per: set(n.rates.per), periods: set(n.rates.periods), ratio: set(n.rates.ratio), ratioFollowers: dict(n.rates.ratioFollowers ?? {}) },
    lineCutting: c && {
      noLineEnd: new Set([...(c.articles ?? []), ...(c.prepositions ?? []), ...(c.possessives ?? []), ...(c.auxiliaries ?? [])]),
      articles: set(c.articles),
      prepositions: set(c.prepositions),
      possessives: set(c.possessives),
      auxiliaries: set(c.auxiliaries),
      pronouns: new Set([...(c.subjectPronouns ?? []), ...(c.clauseWords ?? []), ...(c.ambiguousPronouns ?? [])]),
      subjectPronouns: set(c.subjectPronouns),
      clauseWords: set(c.clauseWords),
      questionWords: set(c.questionWords),
      demonstratives: set(c.demonstratives),
      contractedPronouns: set(c.contractedPronouns),
      lineStartConjunctions: set(c.lineStartConjunctions),
      conjunctions: set(c.conjunctions),
      adjectives: set(c.adjectives),
      adjectiveSuffixes: c.adjectiveSuffixes ?? [],
      notAdjectives: set(c.notAdjectives),
    },
  };
}

/**
 * Digits with one of `suffixes` ("1st", "3e"); group 1 holds the digits. No suffixes (a language that writes "3."):
 * nothing is an ordinal. An empty alternation would match "" and make every number one.
 */
export function ordinalPattern(suffixes: readonly string[]): RegExp {
  return suffixes.length > 0 ? new RegExp(`^(\\d+)(${suffixes.map(escape).join('|')})$`) : /(?!)/;
}

const RESOLVED = new Map<string, Rules>();

/** The resolved rules for a language ('en', 'nl-BE', 'other', …); the neutral rules for a language without a pack. */
export function rulesOf(lang: Lang | undefined): Rules {
  const pack = getPack(lang);
  let r = RESOLVED.get(pack.code);
  if (!r) {
    r = resolve(pack);
    RESOLVED.set(pack.code, r);
  }
  return r;
}

/** Is this comparison key a hesitation sound? Drawn-out forms ("uhhh", "ummm", "hmmm", "mmm") match by pattern. */
export function isFiller(key: string, lang: Lang): boolean {
  if (key === '') return false;
  const r = rulesOf(lang);
  // drawn-out forms need two letters at least, so a lone "m" (metre, initial) is not a filler
  return r.fillers.has(key) || (key.length >= 2 && /^[a-z]+$/.test(key) && r.collapsedFillers.has(collapseRepeats(key)));
}
