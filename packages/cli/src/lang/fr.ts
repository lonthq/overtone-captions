import type { LanguagePack } from './types.js';

/**
 * French: language detection and name particles; everything else uses the neutral rules.
 * Contributions welcome: see docs/contributing/languages.md.
 */
export const fr: LanguagePack = {
  code: 'fr',
  name: 'French',
  nativeName: 'Français',
  aliases: ['french'],
  defaultLocale: 'fr-FR',

  detection: {
    stopwords: [
      'le', 'la', 'les', 'et', 'est', 'un', 'une', 'des', 'du', 'de', 'je', 'tu', 'nous', 'vous', 'il', 'elle', 'ce',
      'que', 'qui', 'pas', 'ne', 'pour', 'dans', 'avec', 'sur', 'mais', 'très', 'au', 'aux', 'sont', 'avons', 'plus',
      'pense', 'c', 'suis', 'ici', 'aujourd', 'hui', 'allons', 'nouveau', 'bonne', 'cela', 'peu', 'd', 'n', 'l',
    ],
  },

  names: {
    particles: ['de', 'du', 'le', 'la'],
  },
};
