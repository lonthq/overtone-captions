import type { LanguagePack } from './types.js';

/**
 * German: language detection and name particles; everything else uses the neutral rules.
 * Contributions welcome: see docs/contributing/languages.md.
 */
export const de: LanguagePack = {
  code: 'de',
  name: 'German',
  nativeName: 'Deutsch',
  aliases: ['german'],
  defaultLocale: 'de-DE',

  detection: {
    stopwords: [
      'wenn', 'deiner', 'bevor', 'etwas', 'willst', 'solltest', 'uns', 'ihre', 'hat', 'wir', 'der', 'die', 'das',
      'und', 'ist', 'nicht', 'ich', 'du', 'sie', 'ein', 'eine', 'mit', 'für', 'auf', 'aber', 'auch', 'es', 'zu',
      'den', 'dem', 'von', 'haben', 'sind', 'was', 'wie', 'noch', 'schon', 'mein', 'kein', 'nur', 'werden', 'wird',
      'dass', 'glaube', 'alles', 'bin', 'heute', 'hier', 'sein', 'über', 'neue', 'gute', 'schwer', 'bisschen', 'froh',
      'so',
    ],
  },

  names: {
    particles: ['von'],
  },
};
