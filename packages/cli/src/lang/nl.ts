import { parseDutchWords } from './number-words/nl.js';
import type { LanguagePack } from './types.js';

/** Dutch (Netherlands and Flanders): full coverage. */
export const nl: LanguagePack = {
  code: 'nl',
  name: 'Dutch',
  nativeName: 'Nederlands',
  aliases: ['dutch', 'flemish'],
  defaultLocale: 'nl-NL',

  detection: {
    stopwords: [
      'de', 'het', 'een', 'en', 'is', 'van', 'dat', 'niet', 'ik', 'je', 'we', 'zijn', 'met', 'voor', 'op', 'maar', 'ook',
      'er', 'dit', 'wat', 'hebben', 'heb', 'naar', 'nog', 'wel', 'als', 'kan', 'gaan', 'zo', 'hij', 'ze', 'jullie', 'mijn',
      'geen', 'bij', 'uit', 'deze', 'wordt', 'worden', 'echt', 'gewoon', 'heel', 'alles', 'ben', 'denk', 'vandaag', 'over',
      'nieuwe', 'goed', 'moeilijk', 'om', 'te', 'blij', 'kost',
    ],
  },

  text: {
    fillers: ['um', 'euh', 'euhm'],
    contractions: {
      "'t": 'het', "'n": 'een', "m'n": 'mijn', "z'n": 'zijn', "d'r": 'haar', "zo'n": 'zo een',
      "da's": 'dat is', "'k": 'ik', "'s": 'des',
    },
    symbolWords: { '&': 'en', '+': 'plus' },
    accentedNumbers: { een: '1' },
    dottedClockTimes: { suffixes: ['uur'], prepositions: ['om'] },
  },

  numbers: {
    parseWords: parseDutchWords,
    decimalSeparator: ',',
    ordinalSuffixes: ['e', 'de', 'ste'],
    scaleWords: { duizend: 1e3, miljoen: 1e6, miljard: 1e9 },
    currencyWords: { euro: 'eur', euros: 'eur', dollar: 'usd', dollars: 'usd', pond: 'gbp' },
    percentWords: ['procent'],
    rates: {
      per: ['per', 'elke', 'iedere'],
      periods: ['seconde', 'minuut', 'uur', 'dag', 'week', 'maand', 'jaar', 'nacht', 'persoon'],
      ratio: ['op', 'van', 'uit'],
      ratioFollowers: { op: 'de', van: 'de', uit: 'de' },
    },
  },

  lineCutting: {
    articles: ['de', 'het', 'een', "'t", "'n"],
    prepositions: [
      'in', 'op', 'aan', 'van', 'voor', 'met', 'naar', 'bij', 'uit', 'door', 'over', 'onder', 'om', 'tot', 'tegen',
      'tussen', 'zonder', 'na', 'sinds', 'per', 'dan', 'als',
      'vanaf', 'tijdens', 'binnen', 'zoals', 'naast', 'rond', 'langs', 'via', 'volgens',
    ],
    possessives: ['mijn', 'jouw', 'je', 'zijn', 'haar', 'ons', 'onze', 'hun', 'uw', "m'n", "z'n"],
    // "zijn" is listed once, under possessives; it is also the verb "to be"
    auxiliaries: [
      'is', 'ben', 'bent', 'was', 'waren', 'heeft', 'hebben', 'had', 'hadden', 'wordt', 'worden', 'werd', 'werden',
      'zal', 'zullen', 'kan', 'kunnen', 'moet', 'moeten', 'mag', 'mogen', 'wil', 'willen',
    ],
    subjectPronouns: ['ik', 'wij', 'we', 'jij', 'hij', 'zij', 'wie', 'welke'],
    clauseWords: ['wat', 'waar', 'waarin', 'waarop'],
    questionWords: ['hoe', 'wat', 'waar', 'wanneer', 'waarom', 'wie'],
    ambiguousPronouns: ['jullie', 'ze', 'die', 'dat'],
    demonstratives: ['dat', 'die'],
    contractedPronouns: ["'k", "da's"],
    lineStartConjunctions: ['en', 'of', 'maar', 'dus'],
    conjunctions: ['en', 'maar', 'of', 'dus', 'want', 'omdat', 'terwijl', 'hoewel', 'als', 'wanneer', 'die', 'dat'],
    adjectives: [
      'heel', 'erg', 'zeer', 'echt', 'nieuwe', 'oude', 'eerste', 'laatste', 'volgende', 'andere', 'goede', 'grote',
      'kleine', 'lange', 'korte', 'hoge', 'lage', 'jonge', 'zelfde', 'hele', 'echte',
    ],
    adjectiveSuffixes: ['ische', 'ige', 'lijke', 'ele', 'bare', 'ieve', 'ale', 'ste'],
    notAdjectives: ['finale', 'centrale', 'kathedrale', 'generale', 'lokale', 'periodieke'],
  },

  sentences: {
    abbreviations: ['bijv.', 'o.a.', 'd.w.z.', 'm.b.t.', 'dhr.', 'mevr.', 'ca.'],
  },

  names: {
    particles: ['van', 'de', 'der', 'den', 'ten', 'ter', "'t", "'s"],
    sentenceOpeners: [
      'met', 'de', 'het', 'een', 'dit', 'dat', 'deze', 'die', 'gisteren', 'vandaag', 'morgen', 'bedankt', 'dank', 'hallo',
      'dus', 'nu', 'ook', 'en', 'maar',
    ],
  },
};
