import type { LanguagePack } from './types.js';

/**
 * The neutral pack: the baseline for every language, and all a language without a pack gets. Its fillers, currency
 * symbols and percent signs apply everywhere; its ordinal suffixes apply when a pack has none. `other` is not a
 * language code: it names this pack in the pipeline.
 */
export const neutral: LanguagePack = {
  code: 'other',
  name: 'Other languages',

  text: {
    // "ahm" is German "ähm" without its accent
    fillers: ['uh', 'uhm', 'ah', 'ahm', 'eh', 'ehm', 'hm', 'hmm', 'mm', 'mhm', 'uhuh'],
  },

  numbers: {
    ordinalSuffixes: ['st', 'nd', 'rd', 'th'],
    currencyWords: { '€': 'eur', eur: 'eur', $: 'usd', usd: 'usd', '£': 'gbp', gbp: 'gbp' },
    percentWords: ['%', 'pct'],
  },
};
