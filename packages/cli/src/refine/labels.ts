import { langOf, type Lang } from '../lang/index.js';
import { normalizeText, tokenizeDisplay } from '../text/normalize.js';
import { piecesOf, SPACELESS, squash, type Piece } from './pieces.js';

/** Longest speaker label and role the LLM may set, in characters; a longer one is dropped, not cut. */
export const MAX_LABEL_CHARS = 48;
export const MAX_ROLE_CHARS = 40;

/**
 * Titles a label may carry that the transcript need not have ("Dr. Smith" for "Doctor Smith"): English ones for every
 * language, plus the language's own. Lowercase, before normalization.
 */
const HONORIFICS: Readonly<Record<string, readonly string[]>> = {
  en: ['dr', 'doctor', 'mr', 'mister', 'mrs', 'ms', 'miss', 'prof', 'professor'],
  nl: ['dhr', 'meneer', 'mevr', 'mevrouw', 'mw', 'juffrouw', 'dokter'],
  de: ['herr', 'frau', 'doktor'],
  fr: ['m', 'mme', 'mlle', 'monsieur', 'madame', 'mademoiselle', 'docteur', 'professeur'],
  es: ['sr', 'sra', 'srta', 'señor', 'señora', 'señorita', 'doctora', 'profesor', 'profesora'],
  it: ['sig', 'sigra', 'signor', 'signore', 'signora', 'signorina', 'dott', 'dottore', 'dottoressa', 'professore', 'professoressa'],
  pt: ['sr', 'sra', 'senhor', 'senhora', 'doutor', 'doutora', 'professora'],
};

/**
 * Words a role may use without the transcript having them, in any case ("Host", "Gast"): a role of these and
 * lowercase words names no one. Lowercase, before normalization.
 */
const ROLE_WORDS: readonly string[] = [
  // en
  'host', 'co', 'cohost', 'guest', 'interviewer', 'interviewee', 'moderator', 'presenter', 'narrator', 'speaker',
  'caller', 'reporter', 'anchor', 'panelist', 'audience', 'member', 'voice', 'announcer', 'commentator', 'expert',
  'chair', 'chairperson', 'student', 'teacher', 'customer', 'agent', 'participant',
  // nl
  'gast', 'presentator', 'presentatrice', 'spreker', 'verteller', 'vertelster', 'beller', 'publiek', 'deelnemer',
  // de
  'gastgeber', 'gastgeberin', 'moderatorin', 'interviewerin', 'sprecher', 'sprecherin', 'erzähler', 'erzählerin',
  'reporterin', 'publikum', 'experte', 'expertin', 'anrufer', 'anruferin', 'teilnehmer', 'teilnehmerin',
  // fr
  'hôte', 'animateur', 'animatrice', 'invité', 'invitée', 'présentateur', 'présentatrice', 'intervieweur',
  'narrateur', 'narratrice', 'public',
  // es, pt, it
  'anfitrión', 'anfitriona', 'invitado', 'invitada', 'presentador', 'presentadora', 'entrevistador', 'entrevistadora',
  'narrador', 'narradora', 'apresentador', 'apresentadora', 'convidado', 'convidada', 'anfitrião', 'ospite',
  'conduttore', 'conduttrice', 'presentatore', 'intervistatore', 'narratore', 'moderatore',
];

/** The comparison pieces of a word list, per language (cached). */
const wordSets = new Map<string, Set<string>>();
function wordSet(name: string, words: readonly string[], lang: Lang): Set<string> {
  const key = `${name}:${lang}`;
  let set = wordSets.get(key);
  if (!set) {
    set = new Set(words.flatMap((w) => normalizeText(w, lang).split(' ')).filter((k) => k !== ''));
    wordSets.set(key, set);
  }
  return set;
}

const honorificsOf = (language: string, lang: Lang): Set<string> => {
  const code = language.toLowerCase().split(/[-_]/)[0];
  return wordSet(`titles-${code}`, [...HONORIFICS.en, ...(code !== 'en' ? HONORIFICS[code] ?? [] : [])], lang);
};

/** "Maya's," → "Maya" (also with ’). A word without a possessive comes back unchanged. */
const withoutPossessive = (token: string): string => token.replace(/[^\p{L}\p{M}\p{N}]+$/u, '').replace(/['’]s$/iu, '');

/**
 * What vouches for a speaker label or role. `pieces`: comparison pieces of the transcript, the user's context and the
 * glossary (each word also without a possessive; each glossary term also squashed, "Drive Cover" → "drivecover").
 * `joined`: the same texts without spaces, for names in spaceless scripts. Never pass an inferred context or terms:
 * one LLM call does not vouch for another.
 */
export interface LabelVouchers { pieces: ReadonlySet<string>; joined: string }

export function labelVouchers(texts: ReadonlyArray<string | undefined>, glossary: readonly string[], language: string): LabelVouchers {
  const lang = langOf(language);
  const pieces = new Set<string>();
  const add = (text: string) => { for (const k of normalizeText(text, lang).split(' ')) if (k) pieces.add(k); };
  const all = [...texts, ...glossary].filter((t): t is string => !!t);
  for (const text of all) {
    add(text);
    for (const token of tokenizeDisplay(text)) {
      const bare = withoutPossessive(token);
      if (bare !== token.replace(/[^\p{L}\p{M}\p{N}]+$/u, '')) add(bare);
    }
  }
  for (const term of glossary) pieces.add(normalizeText(term, lang).replace(/ /g, ''));
  const joined = all.some((t) => SPACELESS.test(t)) ? all.map((t) => normalizeText(t, lang).replace(/ /g, '')).join(' ') : '';
  return { pieces, joined };
}

/** A piece the vouchers have: as a word, or in a spaceless script as a run of characters. */
const vouched = (p: Piece, known: LabelVouchers): boolean => known.pieces.has(p.text) || (SPACELESS.test(p.text) && known.joined.includes(p.text));

const notVouched = (missing: readonly string[]) => `"${[...new Set(missing)].join('", "')}" is not in the transcript, context or glossary`;

/**
 * Why an LLM speaker role is rejected (null: accepted). A role describes; it must not name anyone the transcript does
 * not. Lowercase words and role words pass ("guest of the show", "Host"); every other word (capitalized, or in a
 * caseless script) must be vouched for, possessive left out ("Maya's guest"). A lowercase name ("barack obama")
 * passes here, but cannot vouch for a capitalized label (labelObjection).
 */
export function roleObjection(role: string, known: LabelVouchers, language: string): string | null {
  const lang = langOf(language);
  const roleWords = wordSet('roles', ROLE_WORDS, lang);
  const missing: string[] = [];
  for (const token of tokenizeDisplay(role)) {
    if (/\p{Ll}/u.test(token) && !/\p{Lu}/u.test(token)) continue;
    for (const p of piecesOf([withoutPossessive(token)], lang)) if (!roleWords.has(p.text) && !vouched(p, known)) missing.push(p.text);
  }
  return missing.length > 0 ? `${notVouched(missing)}, nor a role word` : null;
}

/**
 * Why an LLM speaker label is rejected (null: accepted). It must be at most MAX_LABEL_CHARS long, and every piece must
 * be in `known`, or the pieces together form one known word ("Drive Cover" for "DriveCover"). In a spaceless script
 * (Han, Kana, Thai, Lao, Khmer, Myanmar) a piece is vouched for when its characters occur in a voucher ("田中" in
 * "田中です"). Titles (HONORIFICS) need no vouching when a name piece remains. An accepted role vouches for a label
 * that repeats it ("Host"), or a part that does in parentheses or after a comma ("Maya (host)", "Lee, guest"). Pass
 * `role` only after roleObjection accepted it.
 */
export function labelObjection(label: string, role: string, known: LabelVouchers, language: string): string | null {
  if (label.length > MAX_LABEL_CHARS) return `longer than ${MAX_LABEL_CHARS} characters`;
  const lang = langOf(language);
  // the role vouches for a repeating part only when that part, as written, passes as a role too: a lowercase name
  // the role let through ("barack obama") must not become the label "Barack Obama"
  const same = (a: string, b: string) => b !== '' && normalizeText(a, lang) === normalizeText(b, lang) && roleObjection(a, known, language) === null;
  if (same(label, role)) return null;
  const checked = label
    .replace(/\s*\(([^)]*)\)/g, (m: string, inner: string) => (same(inner, role) ? ' ' : m))
    .replace(/,([^,]*)$/u, (m: string, tail: string) => (same(tail, role) ? ' ' : m))
    .replace(/[()]/g, ' ');
  const all = piecesOf(tokenizeDisplay(checked), lang);
  if (all.length === 0) return 'has no words';
  const titles = honorificsOf(language, lang);
  const names = all.filter((p) => !titles.has(p.text));
  const pieces = names.length > 0 ? names : all;
  if (pieces.every((p) => vouched(p, known)) || known.pieces.has(squash(pieces))) return null;
  return notVouched(pieces.filter((p) => !vouched(p, known)).map((p) => p.text));
}
