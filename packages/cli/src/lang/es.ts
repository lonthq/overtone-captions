import type { LanguagePack } from './types.js';

/**
 * Spanish: language detection; everything else uses the neutral rules.
 * Contributions welcome: see docs/contributing/languages.md.
 */
export const es: LanguagePack = {
  code: 'es',
  name: 'Spanish',
  nativeName: 'Español',
  aliases: ['spanish'],
  defaultLocale: 'es-ES',

  detection: {
    stopwords: [
      'si', 'tu', 'antes', 'nada', 'quieres', 'debes', 'nos', 'su', 'tenemos', 'el', 'la', 'los', 'las', 'y', 'es',
      'un', 'una', 'de', 'que', 'no', 'en', 'por', 'para', 'con', 'pero', 'muy', 'yo', 'tú', 'está', 'son', 'del',
      'al', 'lo', 'como', 'más', 'también', 'hay', 'esto', 'eso', 'creo', 'hemos', 'todo', 'estoy', 'estar', 'aquí',
      'hoy', 'vamos', 'nuevo', 'buena', 'poco', 'hablar',
    ],
  },
};
