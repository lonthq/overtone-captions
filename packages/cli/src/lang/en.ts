import { parseEnglishWords } from './number-words/en.js';
import type { LanguagePack } from './types.js';

/** English: full coverage. */
export const en: LanguagePack = {
  code: 'en',
  name: 'English',
  nativeName: 'English',
  aliases: ['english'],
  defaultLocale: 'en-US',

  detection: {
    stopwords: [
      'the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'that', 'it', 'you', 'this', 'with', 'for', 'not', 'have',
      'has', 'be', 'what', 'we', 'they', 'but', 'on', 'my', 'your', 'there', 'just', 'do', 'can', 'will', 'why', 'about',
      'should', 'does', 'where', 'am', 'going', 'think', 'takes', 'little', 'happy', 'today', 'a', 'an', 'so', 'i',
    ],
  },

  text: {
    fillers: ['um', 'er', 'erm', 'euh'],
    contractions: {
      "can't": 'can not', cannot: 'can not', "won't": 'will not', "shan't": 'shall not', "ain't": 'is not',
      "let's": 'let us', "i'm": 'i am', gonna: 'going to', wanna: 'want to', gotta: 'got to',
      "it's": 'it is', "that's": 'that is', "what's": 'what is', "there's": 'there is', "here's": 'here is',
      "he's": 'he is', "she's": 'she is', "who's": 'who is', "where's": 'where is', "how's": 'how is',
    },
    contractionSuffixes: [["n't", ' not'], ["'re", ' are'], ["'ve", ' have'], ["'ll", ' will'], ["'d", ' would'], ["'m", ' am']],
    symbolWords: { '&': 'and', '+': 'plus' },
  },

  numbers: {
    parseWords: parseEnglishWords,
    decimalSeparator: '.',
    ordinalSuffixes: ['st', 'nd', 'rd', 'th'],
    scaleWords: { thousand: 1e3, million: 1e6, billion: 1e9 },
    currencyWords: { euro: 'eur', euros: 'eur', dollar: 'usd', dollars: 'usd', pound: 'gbp', pounds: 'gbp' },
    percentWords: ['percent'],
    rates: {
      per: ['a', 'an', 'per', 'each', 'every'],
      periods: ['second', 'minute', 'hour', 'day', 'week', 'month', 'year', 'night', 'person'],
      ratio: ['in', 'of', 'out'],
      ratioFollowers: { out: 'of' },
    },
  },

  lineCutting: {
    articles: ['a', 'an', 'the'],
    prepositions: [
      'in', 'on', 'at', 'of', 'for', 'to', 'from', 'with', 'by', 'about', 'into', 'onto', 'over', 'under', 'after',
      'before', 'between', 'through', 'during', 'without', 'within', 'via', 'per', 'than', 'as', 'like',
      'until', 'since', 'across', 'around', 'among', 'toward', 'towards',
    ],
    possessives: ['my', 'your', 'his', 'her', 'its', 'our', 'their'],
    auxiliaries: [
      'is', 'are', 'was', 'were', 'be', 'been', 'am', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
      'might', 'must', 'do', 'does', 'did', 'has', 'have', 'had',
    ],
    subjectPronouns: ['i', 'we', 'they', 'he', 'she', 'who', 'which'],
    clauseWords: ['what', 'whom', 'whose', 'where', 'whether'],
    // not "who" and "which": after a comma they start a relative clause ("Jim, who is | a pilot")
    questionWords: ['how', 'what', 'when', 'where', 'why'],
    ambiguousPronouns: ['you', 'that'],
    demonstratives: ['that'],
    contractedPronouns: [
      "i'm", "i've", "i'll", "i'd", "we're", "we've", "we'll", "we'd", "you're", "you've", "you'll", "you'd",
      "they're", "they've", "they'll", "they'd", "he's", "he'll", "she's", "she'll", "it's", "it'll", "that's", "there's",
    ],
    lineStartConjunctions: ['and', 'or', 'but', 'so', 'yet', 'nor'],
    conjunctions: ['and', 'but', 'or', 'so', 'because', 'while', 'although', 'yet', 'nor', 'if', 'when', 'which', 'that'],
    adjectives: [
      'very', 'really', 'new', 'old', 'first', 'last', 'next', 'other', 'different', 'good', 'great', 'big', 'small',
      'little', 'long', 'short', 'high', 'low', 'young', 'same', 'whole', 'real', 'true', 'entire', 'main',
    ],
    adjectiveSuffixes: ['al', 'ive', 'ous', 'ful', 'able', 'ible', 'less', 'ical'],
    notAdjectives: [
      'arrive', 'receive', 'believe', 'achieve', 'survive', 'reveal', 'derive', 'deprive', 'thrive', 'strive', 'perceive',
      'conceive', 'deceive', 'relieve', 'retrieve', 'conceal', 'appeal', 'festival', 'hospital', 'arrival', 'capital',
      'survival', 'removal', 'renewal', 'approval', 'proposal', 'disposal', 'refusal', 'rental', 'dismissal', 'denial',
      'trial', 'rival', 'signal', 'animal', 'journal', 'material', 'terminal', 'criminal', 'interval', 'manual',
      'ritual', 'scandal', 'portal', 'canal', 'mineral', 'funeral', 'cathedral', 'principal', 'detective', 'objective',
      'initiative', 'executive', 'alternative', 'relative', 'motive', 'archive', 'perspective', 'representative',
      'collective', 'handful', 'mouthful', 'unless', 'nevertheless', 'vegetable', 'timetable', 'variable', 'constable',
    ],
  },

  sentences: {
    abbreviations: ['dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'st.', 'vs.', 'e.g.', 'i.e.'],
    endingAbbreviations: ['etc.', 'u.s.', 'u.k.'],
  },

  names: {
    sentenceOpeners: ['yesterday', 'today', 'tomorrow', 'thanks', 'thank', 'hello', 'hi', 'so', 'then', 'now', 'well', 'also', 'and', 'but'],
  },
};
