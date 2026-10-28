import type { LanguagePack } from './types.js';

/*
 * Template for a new language pack. Not registered: it only shows every field.
 *
 * 1. Copy this file to `<code>.ts` (the ISO 639-1 code: `sv.ts` for Swedish) and rename the constant to the code.
 * 2. Fill in what you know and delete the rest. Every field except `code` and `name` is optional: start with
 *    `detection`, then `lineCutting`, then `numbers`.
 * 3. Register the pack in `index.ts` (add it to PACKS) and, if the language is listed in `decoys.ts`, move its
 *    stopwords from there into `detection` here.
 * 4. Write caption examples in `examples/<code>.txt` and run `npm run test:lang`.
 *
 * Each field is documented in types.ts. The values below are English, to show the shape; replace them with
 * words of your language. Full walkthrough: docs/contributing/languages.md.
 */
export const xx: LanguagePack = {
  // ISO 639-1 code, lowercase (639-3 only when the language has no two-letter code).
  code: 'xx',
  // English name of the language.
  name: 'Example',
  // The language's own name for itself.
  // nativeName: 'Example',
  // Lowercase English names that users may type for --language.
  // aliases: ['example'],
  // Locale for speech services when only the bare code is known (language-REGION).
  // defaultLocale: 'xx-XX',

  // ---- Level 1: detection. 40–60 very common words, lowercase, accents kept. Prefer words that neighbor languages
  // do not share. Split words at apostrophes ("aujourd'hui" → "aujourd", "hui").
  // detection: {
  //   stopwords: ['the', 'and', 'is', 'of', 'to', 'in', 'that', 'it', 'you', 'this', /* … */],
  // },

  // ---- Level 2: line cutting. Lowercase display words, accents and apostrophes kept. These change soft costs:
  // the cutter avoids a bad break when line length and timing allow it.
  // lineCutting: {
  //   // a line never ends on these four
  //   articles: ['a', 'an', 'the'],
  //   prepositions: ['in', 'on', 'at', 'of', 'for', 'with', /* … */],
  //   possessives: ['my', 'your', 'his', 'her', 'its', 'our', 'their'],
  //   auxiliaries: ['is', 'are', 'was', 'have', 'will', 'can', /* … */],
  //   // always a subject or a relative pronoun: "a class we | affectionately call" is a bad break
  //   subjectPronouns: ['i', 'we', 'they', 'he', 'she', 'who', 'which'],
  //   // question and relative words that open a clause: "walk through what | they're doing"
  //   clauseWords: ['what', 'where', 'whether'],
  //   // question words: "How did | the project start?" may break after the auxiliary
  //   questionWords: ['how', 'what', 'when', 'where', 'why'],
  //   // can be a subject or an object: "thank you | so much" is fine
  //   ambiguousPronouns: ['you', 'that'],
  //   // demonstratives among the pronouns above: "before that | I flew" is fine
  //   demonstratives: ['that'],
  //   // pronoun + contracted verb, a weaker line end: "we're | joined"
  //   contractedPronouns: ["we're", "it's"],
  //   // these start the next line: "a test pilot, and | before that" is a bad break
  //   lineStartConjunctions: ['and', 'or', 'but', 'so'],
  //   // a break right before one of these reads well (include lineStartConjunctions)
  //   conjunctions: ['and', 'or', 'but', 'so', 'because', 'when', 'which', 'that'],
  //   // short adjectives that go with the next word: "the new | vision"
  //   adjectives: ['very', 'new', 'old', 'first', 'last', /* … */],
  //   // typical adjective endings (words of six letters or more): "an operational | pilot"
  //   adjectiveSuffixes: ['al', 'ive', 'ous'],
  //   // common words with such an ending that are not adjectives
  //   notAdjectives: ['hospital', 'archive'],
  // },

  // ---- Sentences and names. Shared: these entries apply to every language, as names and abbreviations cross languages.
  // sentences: {
  //   // a final "." that does not end a sentence, lowercase with dots
  //   abbreviations: ['dr.', 'e.g.'],
  //   // these end a sentence only when a capital follows ("… etc. Then we …")
  //   endingAbbreviations: ['etc.'],
  // },
  // names: {
  //   // lowercase particles inside names: "Maya van der Berg" stays on one line
  //   particles: ['van', 'de'],
  //   // capitalized sentence openers that are not part of a name after them: "Yesterday Maya said"
  //   sentenceOpeners: ['yesterday', 'thanks', 'hello'],
  // },

  // ---- Level 3: numbers. Better word timings for numbers ("twelve euros" = "€12") and number phrases that stay
  // on one line ("€12 a month").
  // numbers: {
  //   // number words → value; code, not data: see number-words/en.ts and number-words/nl.ts
  //   // parseWords: parseExampleWords,
  //   // '.' when the language writes 1,000.5; ',' when it writes 1.000,5
  //   decimalSeparator: '.',
  //   // ordinal digits: "1st", "2nd"
  //   ordinalSuffixes: ['st', 'nd', 'rd', 'th'],
  //   // shared: scale words after digits ("1.5 million")
  //   scaleWords: { thousand: 1e3, million: 1e6, billion: 1e9 },
  //   // shared: currency words → ISO code (the symbols €, $, £ are built in)
  //   currencyWords: { euro: 'eur', euros: 'eur', dollar: 'usd', dollars: 'usd' },
  //   // shared: words for "percent"
  //   percentWords: ['percent'],
  //   rates: {
  //     per: ['a', 'per', 'every'],             // "€12 a month"
  //     periods: ['day', 'week', 'month', 'year'], // singular; a plural "s" is accepted
  //     ratio: ['in', 'of', 'out'],              // "one in five"
  //     ratioFollowers: { out: 'of' },           // "two out of three"
  //   },
  // },

  // ---- Comparison rules (alignment). fillers: lowercase letters; contractions: lowercase with
  // straight apostrophes.
  // text: {
  //   // extra hesitation sounds (uh, uhm, ah, eh, ehm, hm, hmm, mm, mhm, uhuh always apply); never a real word
  //   fillers: ['um', 'erm'],
  //   contractions: { "can't": 'can not', "let's": 'let us' },
  //   contractionSuffixes: [["n't", ' not'], ["'re", ' are']],
  //   symbolWords: { '&': 'and', '+': 'plus' },
  //   // accented spelling that marks a number (Dutch "één" = 1, "een" = "a"); keys without accents
  //   // accentedNumbers: { een: '1' },
  //   // clock times written with a dot: "10.30 uur", "om 10.30"
  //   // dottedClockTimes: { suffixes: ['uur'], prepositions: ['om'] },
  // },
};
