import type { LanguagePack } from './types.js';

/**
 * Portuguese: language detection and name particles; everything else uses the neutral rules.
 * Contributions welcome: see docs/contributing/languages.md.
 */
export const pt: LanguagePack = {
  code: 'pt',
  name: 'Portuguese',
  nativeName: 'Português',
  aliases: ['portuguese'],
  defaultLocale: 'pt-BR',

  detection: {
    stopwords: [
      'se', 'seu', 'sua', 'antes', 'quer', 'deve', 'temos', 'ela', 'ao', 'o', 'a', 'os', 'as', 'e', 'é', 'um', 'uma',
      'de', 'que', 'não', 'em', 'por', 'para', 'com', 'mas', 'muito', 'eu', 'você', 'nós', 'do', 'da', 'dos', 'das',
      'no', 'na', 'isso', 'este', 'esta', 'também', 'são', 'está', 'acho', 'tudo', 'vimos', 'estou', 'estar', 'aqui',
      'hoje', 'vamos', 'falar', 'sobre', 'novo', 'boa', 'pouco',
    ],
  },

  names: {
    particles: ['da', 'de'],
  },
};
