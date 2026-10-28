// Language code maps for providers. Overtone uses ISO 639-1 ("nl") or a locale ("nl-BE"); services want a locale
// ("nl-NL") or ISO 639-3 ("nld"), or answer with an English name ("dutch"). Use these instead of writing your own.
import { findPack } from '../lang/index.js';

/** Lower-case primary code: "nl-BE" → "nl", "pt_BR" → "pt". */
export const primaryCode = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0]!;

/** Default locales for languages without a pack (a pack sets `defaultLocale`). */
const LOCALES: Record<string, string> = {
  sv: 'sv-SE', da: 'da-DK', nb: 'nb-NO', no: 'nb-NO', fi: 'fi-FI', pl: 'pl-PL', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR',
  uk: 'uk-UA', cs: 'cs-CZ', el: 'el-GR', he: 'he-IL', hi: 'hi-IN', vi: 'vi-VN', ar: 'ar-SA', ca: 'ca-ES', tr: 'tr-TR',
  id: 'id-ID', ms: 'ms-MY', th: 'th-TH', ro: 'ro-RO', hu: 'hu-HU', sk: 'sk-SK', bg: 'bg-BG', hr: 'hr-HR',
  et: 'et-EE', sl: 'sl-SI', fa: 'fa-IR', sr: 'sr-RS', af: 'af-ZA', ga: 'ga-IE', gu: 'gu-IN', ur: 'ur-PK',
  lt: 'lt-LT', lv: 'lv-LV', mt: 'mt-MT', is: 'is-IS', sw: 'sw-KE', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN',
  bn: 'bn-IN', kn: 'kn-IN', ml: 'ml-IN', ne: 'ne-NP', ka: 'ka-GE', hy: 'hy-AM', az: 'az-AZ', kk: 'kk-KZ',
  uz: 'uz-UZ', mk: 'mk-MK', sq: 'sq-AL', bs: 'bs-BA', cy: 'cy-GB', eu: 'eu-ES', gl: 'gl-ES', km: 'km-KH',
  lo: 'lo-LA', my: 'my-MM', mn: 'mn-MN', ps: 'ps-AF', si: 'si-LK', so: 'so-SO', zu: 'zu-ZA', am: 'am-ET', jv: 'jv-ID',
};

/**
 * 'en' → 'en-US' (the pack's `defaultLocale`, else LOCALES); codes with a region pass through. Undefined when no
 * region is known: guessing `<xx>-<XX>` yields invalid locales such as et-ET, which Azure rejects.
 */
export function toLocale(language: string): string | undefined {
  if (language.includes('-')) return language;
  const code = language.toLowerCase();
  const pack = findPack(code);
  return (pack?.code === code ? pack.defaultLocale : undefined) ?? LOCALES[code];
}

/**
 * ISO 639-1 → 639-3 for the two-letter languages ElevenLabs Scribe accepts (from the list its API returns for an
 * invalid `language_code`, as of 2026-10-17).
 */
export const ISO639_1_TO_3: Readonly<Record<string, string>> = {
  af: 'afr', am: 'amh', ar: 'ara', as: 'asm', az: 'aze', ba: 'bak', be: 'bel', bg: 'bul', bn: 'ben', bo: 'bod',
  br: 'bre', bs: 'bos', ca: 'cat', cr: 'cre', cs: 'ces', cv: 'chv', cy: 'cym', da: 'dan', de: 'deu', dv: 'div',
  el: 'ell', en: 'eng', eo: 'epo', es: 'spa', et: 'est', eu: 'eus', fa: 'fas', ff: 'ful', fi: 'fin', fo: 'fao',
  fr: 'fra', fy: 'fry', ga: 'gle', gd: 'gla', gl: 'glg', gu: 'guj', ha: 'hau', he: 'heb', hi: 'hin', hr: 'hrv',
  ht: 'hat', hu: 'hun', hy: 'hye', ia: 'ina', id: 'ind', ig: 'ibo', is: 'isl', it: 'ita', ja: 'jpn', jv: 'jav',
  ka: 'kat', kk: 'kaz', km: 'khm', kn: 'kan', ko: 'kor', ks: 'kas', ku: 'kur', ky: 'kir', la: 'lat', lb: 'ltz',
  lg: 'lug', ln: 'lin', lo: 'lao', lt: 'lit', lv: 'lav', mg: 'mlg', mi: 'mri', mk: 'mkd', ml: 'mal', mn: 'mon',
  mr: 'mar', ms: 'msa', mt: 'mlt', my: 'mya', nb: 'nob', ne: 'nep', nl: 'nld', nn: 'nno', no: 'nor', ny: 'nya',
  oc: 'oci', om: 'orm', or: 'ori', os: 'oss', pa: 'pan', pl: 'pol', ps: 'pus', pt: 'por', rm: 'roh', ro: 'ron',
  ru: 'rus', rw: 'kin', sa: 'san', sc: 'srd', sd: 'snd', si: 'sin', sk: 'slk', sl: 'slv', sm: 'smo', sn: 'sna',
  so: 'som', sq: 'sqi', sr: 'srp', st: 'sot', su: 'sun', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', tg: 'tgk',
  th: 'tha', ti: 'tir', tk: 'tuk', tl: 'tgl', tn: 'tsn', to: 'ton', tr: 'tur', tt: 'tat', tw: 'twi', ug: 'uig',
  uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie', wo: 'wol', xh: 'xho', yi: 'yid', yo: 'yor', zh: 'zho', zu: 'zul',
};

/** ISO 639-3 → 639-1: the reverse map, plus macrolanguage members a service may report (cmn → zh). */
export const ISO639_3_TO_1: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(ISO639_1_TO_3).map(([one, three]) => [three, one])),
  cmn: 'zh', nob: 'nb', nno: 'nn', tgl: 'tl', fil: 'tl',
};

/** "nl-BE" → "nld"; undefined when unmapped. */
export function toIso639_3(language: string | undefined): string | undefined {
  if (!language?.trim()) return undefined;
  const primary = primaryCode(language);
  return Object.hasOwn(ISO639_1_TO_3, primary) ? ISO639_1_TO_3[primary] : undefined;
}

/** "eng" → "en"; undefined when unmapped. */
export function fromIso639_3(code: string | undefined): string | undefined {
  const c = code?.trim().toLowerCase();
  return c && Object.hasOwn(ISO639_3_TO_1, c) ? ISO639_3_TO_1[c] : undefined;
}

/** Whisper's English language names → ISO 639-1, for its 99 languages (Cantonese: yue). */
export const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  english: 'en', chinese: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr', japanese: 'ja',
  portuguese: 'pt', turkish: 'tr', polish: 'pl', catalan: 'ca', dutch: 'nl', arabic: 'ar', swedish: 'sv', italian: 'it',
  indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi', hebrew: 'he', ukrainian: 'uk', greek: 'el', malay: 'ms',
  czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu', tamil: 'ta', norwegian: 'no', thai: 'th', urdu: 'ur',
  croatian: 'hr', bulgarian: 'bg', lithuanian: 'lt', latin: 'la', maori: 'mi', malayalam: 'ml', welsh: 'cy', slovak: 'sk',
  telugu: 'te', persian: 'fa', latvian: 'lv', bengali: 'bn', serbian: 'sr', azerbaijani: 'az', slovenian: 'sl', kannada: 'kn',
  estonian: 'et', macedonian: 'mk', breton: 'br', basque: 'eu', icelandic: 'is', armenian: 'hy', nepali: 'ne', mongolian: 'mn',
  bosnian: 'bs', kazakh: 'kk', albanian: 'sq', swahili: 'sw', galician: 'gl', marathi: 'mr', punjabi: 'pa', sinhala: 'si',
  khmer: 'km', shona: 'sn', yoruba: 'yo', somali: 'so', afrikaans: 'af', occitan: 'oc', georgian: 'ka', belarusian: 'be',
  tajik: 'tg', sindhi: 'sd', gujarati: 'gu', amharic: 'am', yiddish: 'yi', lao: 'lo', uzbek: 'uz', faroese: 'fo',
  'haitian creole': 'ht', pashto: 'ps', turkmen: 'tk', nynorsk: 'nn', maltese: 'mt', sanskrit: 'sa', luxembourgish: 'lb',
  myanmar: 'my', tibetan: 'bo', tagalog: 'tl', malagasy: 'mg', assamese: 'as', tatar: 'tt', hawaiian: 'haw', lingala: 'ln',
  hausa: 'ha', bashkir: 'ba', javanese: 'jv', sundanese: 'su', cantonese: 'yue',
};

/** "English" → "en" (any case); undefined for unknown names. */
export function fromWhisperName(name: string | undefined): string | undefined {
  const l = name?.trim().toLowerCase();
  return l && Object.hasOwn(WHISPER_LANGUAGES, l) ? WHISPER_LANGUAGES[l] : undefined;
}
