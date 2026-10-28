import type { LanguagePack } from './types.js';

/**
 * Italian: language detection and name particles; everything else uses the neutral rules.
 * Contributions welcome: see docs/contributing/languages.md.
 */
export const it: LanguagePack = {
  code: 'it',
  name: 'Italian',
  nativeName: 'Italiano',
  aliases: ['italian'],
  defaultLocale: 'it-IT',

  detection: {
    stopwords: [
      'se', 'tua', 'sua', 'prima', 'vuoi', 'devi', 'abbiamo', 'ha', 'dal', 'alla', 'il', 'lo', 'la', 'gli', 'le', 'e',
      'è', 'un', 'una', 'di', 'che', 'non', 'per', 'con', 'ma', 'sono', 'io', 'tu', 'noi', 'del', 'della', 'questo',
      'questa', 'anche', 'molto', 'come', 'più', 'ci', 'ho', 'hai', 'penso', 'tutto', 'essere', 'qui', 'oggi',
      'nuovo', 'sia', 'buona', 'po', 'vuole',
    ],
  },

  names: {
    particles: ['di', 'da'],
  },
};
