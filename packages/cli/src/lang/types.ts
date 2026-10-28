/**
 * A language pack: what the pipeline knows about one language, as data.
 *
 * Only `code` and `name` are required, so a pack can start with detection and grow. A missing field falls back to
 * the neutral behavior it describes. Coverage levels and testing: docs/contributing/languages.md.
 *
 * Word forms depend on what a list is compared with:
 * - detection lists: lowercase as written, accents kept ("très", "één");
 * - line-cutting lists: lowercase display words, accents and apostrophes kept ("m'n", "één");
 * - comparison lists (fillers): lowercase, no accents, no apostrophes ("een", "dont").
 * packages/cli/test/lang-packs.test.ts checks these forms.
 */

/** A parsed number expression; `length` is how many pieces were consumed. */
export interface ParsedNumber {
  value: number;
  ordinal: boolean;
  length: number;
  /** Integers with a leading zero ("007", "020", phone-number parts) keep their digit string as the key. */
  raw?: string;
  /**
   * The other reading of ambiguous words: "twenty-second" is the ordinal 22nd, or 20 then "second" (a 20-second
   * clip). Texts with either reading say the same number (`sameNumbers`).
   */
  alternative?: Pick<ParsedNumber, 'value' | 'ordinal' | 'length' | 'raw'>;
}

/**
 * Reads number words at `pieces[start]` and returns the number they spell, or null. `pieces` are comparison pieces:
 * lowercase, no accents, contractions expanded, hyphenated words split ("twenty-one" → "twenty", "one"). May consume
 * several pieces ("a hundred and five" → 105, length 4). Digits are handled for you.
 */
export type NumberWordParser = (pieces: readonly string[], start: number) => ParsedNumber | null;


/**
 * Comparison rules. Alignment matches the text hearing's words to the timing hearing's words by normalized keys
 * ("€12" and "twelve euros" both become "12 eur"). Better rules give more exact word times.
 */
export interface TextRules {
  /**
   * Extra hesitation sounds (lowercase, letters only). Timing engines write them and text engines drop them, so
   * alignment skips them. The neutral sounds ("uh", "uhm", "ah", "eh", "ehm", "hm", "hmm", "mm", "mhm", "uhuh")
   * always apply. Never list a real word (German "er").
   */
  fillers?: readonly string[];
  /**
   * Whole-word contractions → full form, lowercase, straight apostrophes: { "can't": "can not", "m'n": "mijn" }.
   * Applied before comparing, so "can't" matches "cannot".
   */
  contractions?: Readonly<Record<string, string>>;
  /**
   * Contracted endings, tried in order when no whole word matched: ["n't", " not"] turns "isn't" into "is not". The
   * replacement is appended to the stem, so it usually starts with a space.
   */
  contractionSuffixes?: ReadonlyArray<readonly [suffix: string, replacement: string]>;
  /** How "&" and "+" between words are said ("Q & A" → "q and a"). Missing: the symbol is ignored. */
  symbolWords?: Readonly<{ '&'?: string; '+'?: string }>;
  /**
   * Words that are a number only when accented (Dutch { een: "1" }: "één" is 1, "een" is "a"). Keys without accents.
   */
  accentedNumbers?: Readonly<Record<string, string>>;
  /**
   * Clock times with a dot (Dutch "10.30 uur", "om 10.30"). A dotted number is a time when one of `suffixes` follows
   * or one of `prepositions` precedes it (and no currency or percent sign follows). Missing: "10.30" is a decimal.
   */
  dottedClockTimes?: Readonly<{ suffixes: readonly string[]; prepositions: readonly string[] }>;
}

/** Number rules: how numbers are written and said. Used by alignment and line cutting. */
export interface NumberRules {
  /**
   * Number words → value ("twenty one" → 21, "drieëntwintig" → 23). Code, not data: see lang/number-words/ for the
   * English and Dutch parsers. Missing: only digits are numbers, so "twelve" and "12" match only fuzzily.
   */
  parseWords?: NumberWordParser;
  /**
   * Decimal separator: "." (English "1,000.5") or "," (Dutch "1.000,5"); the other is the thousands separator.
   * Missing: a separator followed by exactly three digits is a thousands separator, else a decimal point.
   */
  decimalSeparator?: '.' | ',';
  /** Suffixes that make digits ordinal: English ["st", "nd", "rd", "th"] ("1st"), Dutch ["e", "de", "ste"] ("3e"). Missing: the English ones. */
  ordinalSuffixes?: readonly string[];
  /** Scale words after digits: { million: 1e6 } reads "1.5 million" as 1500000. Shared by all languages. */
  scaleWords?: Readonly<Record<string, number>>;
  /**
   * Currency words → lowercase ISO code: { euro: "eur", euros: "eur", dollar: "usd" }. Symbols (€, $, £) and codes
   * are built in. Shared by all languages.
   */
  currencyWords?: Readonly<Record<string, string>>;
  /** Words for "percent": ["percent"]. "%" and "pct" are built in. Shared by all languages. */
  percentWords?: readonly string[];
  /**
   * Words that continue a number phrase, so the line cutter keeps it on one line and alignment compares it as one:
   * "€12 a month", "one in five", "twaalf euro per maand", "één op de vijf". Lowercase display words.
   */
  rates?: Readonly<{
    /** Words for "per" before a period: ["a", "per", "every"] ("€12 a month"). */
    per: readonly string[];
    /** Periods and units after a per word, singular: ["month", "year", "person"]. A plural "s" is accepted. */
    periods: readonly string[];
    /** Words between the two numbers of a ratio: ["in", "of", "out"] ("one in five", "two out of three"). */
    ratio: readonly string[];
    /** A word that may follow a ratio word: { out: "of" }, Dutch { op: "de" } ("één op de vijf"). */
    ratioFollowers?: Readonly<Record<string, string>>;
  }>;
}

/**
 * Line-cutting rules: where a line or cue may end. Soft costs (line length and timing still win), except where a
 * field says it is a hard rule for LLM-proposed cuts. Entries are lowercase display words, accents and apostrophes
 * kept ("m'n", "'t"). Missing: the cutter uses only punctuation, sentence ends, names and numbers.
 */
export interface LineCuttingRules {
  /** Articles ("a", "the"; "de", "het"). A line never ends on one: "the | crew" is costly. */
  articles?: readonly string[];
  /** Prepositions ("in", "with"; "op", "met"). A line never ends on one; a pronoun before one is an object ("thank you | for"). */
  prepositions?: readonly string[];
  /** Possessive determiners ("my", "their"; "mijn", "hun"). A line never ends on one: "our | arrival" is costly. */
  possessives?: readonly string[];
  /** Auxiliary and modal verbs ("is", "have", "will"; "heeft", "zal"). A line never ends on one. */
  auxiliaries?: readonly string[];
  /**
   * Pronouns that are always a subject or open a relative clause ("we", "who"; "ik", "wie"). Ending a line on one
   * cuts it from its verb ("a class we | affectionately call"): a high cost, and a hard rule for LLM cuts.
   */
  subjectPronouns?: readonly string[];
  /**
   * Question and relative words that open a clause ("what", "where"; "wat", "waar"). Treated like subject pronouns,
   * at a lower cost right after a verb ("did what | was right").
   */
  clauseWords?: readonly string[];
  /**
   * Question words that open a direct question ("how", "where"; "hoe", "waar"). With the auxiliary before the
   * subject, a line may end on the auxiliary right after the question word ("How did | the project start?"), when
   * the question word opens the sentence or clause and a pronoun, article, possessive or capitalized word follows.
   * Leave out words that often open a relative clause after a comma (English "who", "which").
   */
  questionWords?: readonly string[];
  /**
   * Pronouns that can be subject or object ("you", "that"; "ze", "dat"): "thank you | so much" is fine, "that
   * you | know" is not. A medium cost, none before a preposition or punctuation.
   */
  ambiguousPronouns?: readonly string[];
  /**
   * Demonstratives among the pronouns ("that"; "dat", "die"). After a preposition, followed by a new phrase, they
   * close the phrase: "and before that | I flew" is a fine break.
   */
  demonstratives?: readonly string[];
  /** A pronoun with a contracted verb ("we're", "it'll"; "'k"): half the line-end cost of a bare pronoun. */
  contractedPronouns?: readonly string[];
  /** Coordinating conjunctions ("and", "but"; "en", "maar"). They start the next line; ending a line on one is costly. */
  lineStartConjunctions?: readonly string[];
  /** Conjunctions and clause openers ("because", "which"; "omdat", "die"). A break right before one is good. */
  conjunctions?: readonly string[];
  /** Short adjectives and intensifiers that belong with the next word ("very", "new"; "heel", "nieuwe"): "the new | vision" costs a little. */
  adjectives?: readonly string[];
  /** Typical adjective endings ("ive", "ous"; "ische", "lijke"): "an operational | pilot" costs a little. Words of 6+ letters only. */
  adjectiveSuffixes?: readonly string[];
  /** Words with an adjective ending that are not adjectives ("hospital", "archive"; "finale"). */
  notAdjectives?: readonly string[];
}

/** Sentence rules: where sentences end. They set speaker-turn boundaries, line breaks and editor windows. */
export interface SentenceRules {
  /** Abbreviations whose final "." never ends a sentence, lowercase with dots: ["dr.", "e.g."; "bijv."]. Shared. */
  abbreviations?: readonly string[];
  /**
   * Abbreviations that end a sentence only before a capitalized word ("… cats, etc. Then we …"): ["etc.", "u.s."].
   * Not also in `abbreviations`. Shared by all languages.
   */
  endingAbbreviations?: readonly string[];
}

/** Name rules: runs of capitalized words are names, and the line cutter never splits one ("Jan de Vries"). */
export interface NameRules {
  /** Lowercase particles inside names ("van", "de", "von", "di"): "Maya van der Berg" stays on one line. Shared. */
  particles?: readonly string[];
  /**
   * Capitalized sentence openers that are not part of the name after them ("Yesterday", "Thanks"; "Gisteren",
   * "De"): "Yesterday Maya said" may break after "Yesterday". Lowercase. Shared.
   */
  sentenceOpeners?: readonly string[];
}

/** Language detection: a stopword guess for when nobody named the spoken language. */
export interface DetectionRules {
  /**
   * 40–60 very common words, lowercase as written (accents kept; split at apostrophes, so French "aujourd'hui" is
   * "aujourd" + "hui"). Prefer words related languages do not share. When two languages score close, none is
   * returned.
   */
  stopwords: readonly string[];
}

export interface LanguagePack {
  /** ISO 639-1 code (639-3 when there is no two-letter code), lowercase: "en", "nl", "fy". */
  code: string;
  /** English name: "Dutch". */
  name: string;
  /** The language's own name: "Nederlands". */
  nativeName?: string;
  /** Lowercase English names accepted by --language: ["dutch", "flemish"]. */
  aliases?: readonly string[];
  /**
   * Locale sent to speech services when only the bare code is known: "nl-NL". Azure AI Speech needs a full locale,
   * and its automatic language ID does not cover every language.
   */
  defaultLocale?: string;
  detection?: DetectionRules;
  text?: TextRules;
  numbers?: NumberRules;
  lineCutting?: LineCuttingRules;
  sentences?: SentenceRules;
  names?: NameRules;
}
