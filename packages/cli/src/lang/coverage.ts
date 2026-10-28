import type { LanguagePack } from './types.js';

/** The sections of a pack that hold rules (everything except the identity fields). */
type Section = 'detection' | 'lineCutting' | 'numbers' | 'text' | 'sentences' | 'names';

/** Every field of every section, with what it gives. Typed so a field added to types.ts must be listed here. */
export const FIELDS: { readonly [S in Section]: { readonly [F in keyof Required<NonNullable<LanguagePack[S]>>]: string } } = {
  detection: { stopwords: 'guess the language when none is given' },
  lineCutting: {
    articles: 'no line ends on an article',
    prepositions: 'no line ends on a preposition',
    possessives: 'no line ends on a possessive',
    auxiliaries: 'no line ends on an auxiliary verb',
    subjectPronouns: 'subject pronouns stay with their verb',
    clauseWords: 'question and relative words stay with their clause',
    questionWords: '"How did | the project start?" is a fine break',
    ambiguousPronouns: 'pronouns that may be objects cost less',
    demonstratives: '"before that | I flew" is a fine break',
    contractedPronouns: '"we\'re | joined" costs a little',
    lineStartConjunctions: 'and/or/but start the next line',
    conjunctions: 'breaks before conjunctions read well',
    adjectives: 'short adjectives stay with their noun',
    adjectiveSuffixes: 'adjectives by ending stay with their noun',
    notAdjectives: 'exceptions to the adjective endings',
  },
  numbers: {
    parseWords: 'number words match digits ("twelve" = "12")',
    decimalSeparator: '"1.000,5" vs "1,000.5"',
    ordinalSuffixes: 'ordinal digits ("1st", "3e")',
    scaleWords: 'scale words after digits ("1.5 million")',
    currencyWords: 'currency words ("euros")',
    percentWords: 'words for "percent"',
    rates: 'number phrases stay on one line ("€12 a month")',
  },
  text: {
    fillers: 'hesitation sounds are skipped in alignment',
    contractions: 'contractions match full forms',
    contractionSuffixes: 'contracted endings match full forms',
    symbolWords: '"&" and "+" match their words',
    accentedNumbers: 'accented number words ("één")',
    dottedClockTimes: 'clock times with a dot ("10.30 uur")',
  },
  sentences: {
    abbreviations: 'abbreviations do not end sentences',
    endingAbbreviations: 'abbreviations that may end sentences',
  },
  names: {
    particles: 'name particles keep names together',
    sentenceOpeners: 'sentence openers are not taken for names',
  },

};

/** The coverage levels, in the order a pack usually grows. */
export const LEVELS = [
  { id: 'detection', label: 'detection', has: (p: LanguagePack) => (p.detection?.stopwords.length ?? 0) > 0 },
  { id: 'lineCutting', label: 'line cutting', has: (p: LanguagePack) => p.lineCutting !== undefined },
  { id: 'numbers', label: 'numbers', has: (p: LanguagePack) => p.numbers?.parseWords !== undefined },
] as const;

export type Coverage = 'full' | 'partial' | 'detection only' | 'none';

/** How much of the pipeline a pack covers: every level ("full"), detection alone, some levels, or none. */
export function coverageOf(pack: LanguagePack): Coverage {
  const has = LEVELS.map((l) => l.has(pack));
  if (has.every(Boolean)) return 'full';
  if (!has.some(Boolean)) return 'none';
  return has[0] && !has.slice(1).some(Boolean) ? 'detection only' : 'partial';
}

/** One filled or empty field of a pack: its size (entries; 1 for a value or a function) and what it gives. */
export interface FieldCoverage { section: Section; field: string; size: number; gives: string }

/** Entries in a field: list length, table size (object of lists: total length), 1 for a value or function. */
function sizeOf(v: unknown): number {
  if (v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v !== 'object' || v === null) return 1;
  const values = Object.values(v);
  return values.every(Array.isArray) ? values.reduce((n: number, l: unknown[]) => n + l.length, 0) : values.length;
}

/** Every field of a pack with its size: 0 = not filled. */
export function fieldsOf(pack: LanguagePack): FieldCoverage[] {
  return (Object.keys(FIELDS) as Section[]).flatMap((section) => {
    const values = (pack[section] ?? {}) as Record<string, unknown>;
    return Object.entries(FIELDS[section]).map(([field, gives]) => {
      const v = values[field];
      return { section, field, size: sizeOf(v), gives };
    });
  });
}
