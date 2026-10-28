import { SHARED, isFiller, rulesOf, type Lang } from '../lang/index.js';
import { numberKey, parseNumberAt } from './numbers.js';

/**
 * Comparison form of one display word.
 * - `key`: canonical, space-separated pieces ("€12" → "12 eur", "don't" → "do not", "worry-free" → "worry free").
 *   A number phrase spanning several words ("twelve euros") puts the whole key on its first word.
 * - `cont`: this word was consumed by a number phrase that started in an earlier word (its key is "").
 * - `filler`: the key is a hesitation sound ("uh", "ehm").
 */
export interface NormWord { text: string; key: string; cont: boolean; filler: boolean }

const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;
const OPENING = /^[([{“‘«„¿¡€$£]+$/u;
/** Closing punctuation: glued to the previous word without a space. */
const CLOSING = /^[.,;:!?…%)\]}”’»"']+$/u;

/**
 * Split display text into words on whitespace. Punctuation-only tokens join a neighbor so every word has letters or
 * digits: opening quotes/brackets and currency symbols join the next word ("€ 12" → "€12"); closing punctuation,
 * and a currency symbol or % after a number, join the previous one ("12 %" → "12%"); other symbols (dashes, "&",
 * "+", "/", emoji) join the previous word with a space, keeping the text: "Johnson & Johnson" → ["Johnson &",
 * "Johnson"]. Leading closing punctuation joins the first word.
 */
export function tokenizeDisplay(text: string): string[] {
  const raw = text.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  let pendingOpen = '';
  for (const tok of raw) {
    if (PUNCT_ONLY.test(tok)) {
      const last = out.length - 1;
      const afterNumber = last >= 0 && /\d$/.test(out[last]) && /^[€$£%]+$/.test(tok);
      if (OPENING.test(tok) && !afterNumber) pendingOpen += tok;
      else if (last < 0) pendingOpen += CLOSING.test(tok) ? tok : `${tok} `;
      else out[last] += afterNumber || CLOSING.test(tok) ? tok : ` ${tok}`;
      continue;
    }
    out.push(pendingOpen + tok);
    pendingOpen = '';
  }
  if (pendingOpen && out.length > 0) out[out.length - 1] += pendingOpen;
  return out;
}

interface Piece { text: string; word: number }

/** Marks the end of a display word that ends a clause ("thirty," "twenty."): number phrases never cross it. */
const BREAK = '\u0000';
const BOUNDARY = /[.,;:!?…]["'”’»)\]}]*$/u;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const FRACTIONS: Readonly<Record<string, number>> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
/** Currency symbols that become pieces of their own ("€12" → "€", "12"); their codes come from the language packs. */
const CURRENCY_SYMBOLS = '€$£';
const CURRENCY = SHARED.currency;

/** "1½" → "1.5", "½" → "0.5" (before NFKD would turn them into "1⁄2"). */
function expandFractions(s: string): string {
  return s.replace(/(\d+)?([½¼¾])/g, (_m, n: string | undefined, f: string) => String((n ? Number(n) : 0) + FRACTIONS[f]));
}

/**
 * Digits of every script as ASCII ("३०", "٣٠" → "30"), so numbers compare by value. Unicode keeps each script's
 * digits 0–9 in one ordered run of ten, and runs may follow each other (the mathematical digits).
 */
function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    if (d >= '0' && d <= '9') return d;
    const cp = d.codePointAt(0)!;
    let start = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
};

/** Marks a signed exponent in `splitSuperscripts`' output (a dash there would be split off like any other). */
const EXP_MINUS = '\u0001';
const EXP_PLUS = '\u0002';
const SIGNED_EXPONENT = /^([\u0001\u0002])(\d+)(.*)$/su;

/**
 * A superscript or subscript after a digit is a number of its own ("10⁶" → "10 6"). Its sign stays with it
 * ("10⁻⁶" → "10 -6"), marked EXP_MINUS / EXP_PLUS for `wordPieces`.
 */
function splitSuperscripts(s: string): string {
  return s.replace(/(?<=\d)([⁺⁻₊₋]?)([⁰¹²³⁴-⁹₀-₉]+)/gu, (_m, sign: string, digits: string) => {
    const mark = sign === '' ? '' : sign === '⁻' || sign === '₋' ? EXP_MINUS : EXP_PLUS;
    return ` ${mark}${[...digits].map((c) => SUPERSCRIPT_DIGITS[c]).join('')}`;
  });
}

/** Typographic apostrophes and look-alikes, all compared as "'". */
const APOSTROPHES = /[’‘`´ʼ]/g;

/** Lowercase, every apostrophe as "'" ("We’re", "Weʼre" → "we're"). */
export function unifyApostrophes(s: string): string {
  return s.toLowerCase().replace(APOSTROPHES, "'");
}

/** Strip apostrophes at the start or end, except before a Dutch clitic ("'t", "'n", "'k", "'s"), a word of its own. */
export function trimApostrophes(s: string): string {
  return s.replace(/^'+(?![tnks]$)/, '').replace(/'+$/, '');
}

function unify(s: string): string {
  return unifyApostrophes(s).replace(/[‐‑‒–—―−]/g, '-');
}

/**
 * Strip the accents of Latin, Greek and Cyrillic letters ("é" → "e"), and of Arabic and Hebrew (vowel points are
 * optional in writing). Other scripts keep their marks: Indic vowel signs are marks ("में" "in" vs "मैं" "I"), and so
 * are Japanese voicing marks ("かき" vs "がき"). The result stays decomposed (NFKD), so Korean compares by jamo.
 */
function foldAccents(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}])\p{M}+/gu, '$1');
}

function expandContraction(p: string, lang: Lang): string {
  const rules = rulesOf(lang);
  const whole = rules.contractions[p];
  if (whole) return whole;
  for (const [suffix, repl] of rules.contractionSuffixes) {
    if (p.endsWith(suffix) && p.length > suffix.length) return p.slice(0, -suffix.length) + repl;
  }
  return p;
}

/** Break one display word into comparison pieces (lowercase, folded, no punctuation). */
function wordPieces(word: string, lang: Lang): string[] {
  const rules = rulesOf(lang);
  const out: string[] = [];
  const spaced = expandFractions(unify(splitSuperscripts(asciiDigits(word)))).replace(/(?<=[\p{L}\p{N}])\+(?=[\p{L}\p{N}])/gu, ' + ');
  for (let part of spaced.split(/[-/\s]+/)) {
    // a signed exponent ("10⁻⁶" → "10", "-6"): the sign is part of the number
    const exp = SIGNED_EXPONENT.exec(part);
    if (exp) { out.push((exp[1] === EXP_MINUS ? '-' : '+') + exp[2]); part = exp[3]; }
    // standalone symbols with a spoken form: "Q & A" → "q and a", "5 + 5" → "5 plus 5" (display text is unchanged)
    if (part === '&' || part === '+') { const said = rules.symbolWords[part]; if (said) out.push(said); continue; }
    part = part.replace(/^[^\p{L}\p{M}\p{N}'€$£%]+|[^\p{L}\p{M}\p{N}'€$£%]+$/gu, '');
    part = trimApostrophes(part);
    if (!part) continue;
    // currency symbols and % become their own pieces: "€12" → ["€", "12"], "12%" → ["12", "%"]
    const split = part.split(new RegExp(`([${CURRENCY_SYMBOLS}%])`)).filter((x) => x.length > 0);
    for (let s of split) {
      const time = TIME.exec(s);
      if (time && Number(time[1]) <= 24 && Number(time[2]) <= 59) { out.push(`${Number(time[1])}:${time[2]}${time[3] ? `:${time[3]}` : ''}`); continue; }
      // an accented spelling of a number word is the number (Dutch "één", "Eén" → 1); the plain word stays a word
      const folded = foldAccents(s);
      const accented = folded !== s ? rules.accentedNumbers[folded] : undefined;
      if (accented) { out.push(accented); continue; }
      s = expandContraction(s, lang);
      for (const w of s.split(' ')) {
        const clean = foldAccents(w).replace(/'/g, '').replace(/[^\p{L}\p{M}\p{N}.,€$£%]/gu, '').replace(/^[.,]+|[.,]+$/g, '');
        if (clean) out.push(/\d/.test(clean) ? clean : clean.replace(/[.,]/g, ''));
      }
    }
  }
  return out.filter((p) => p.length > 0);
}

const isCurrency = (p: string | undefined): p is string => p !== undefined && p in CURRENCY;

/**
 * Normalize display words into comparison keys. A number phrase spanning words gets one canonical key on its first
 * word: "twelve euros" → ["12 eur", ""(cont)], "€12" → ["12 eur"], "EUR 12" → ["12 eur", ""(cont)],
 * "twenty per cent" → ["20 percent", cont, cont]. With `alternative`, an ambiguous number phrase takes its other
 * reading ("twenty-second" → "20 second").
 */
export function normalizeWords(words: readonly string[], lang: Lang, opts: { alternative?: boolean } = {}): NormWord[] {
  const pieces: Piece[] = [];
  words.forEach((w, word) => {
    wordPieces(w, lang).forEach((text) => pieces.push({ text, word }));
    if (BOUNDARY.test(w)) pieces.push({ text: BREAK, word });
  });
  const texts = pieces.map((p) => p.text);
  const clock = rulesOf(lang).dottedClockTimes;
  if (clock) {
    // clock times written with a dot ("10.30 uur", "om 10.30" in Dutch); elsewhere "12.50" stays a decimal
    texts.forEach((t, idx) => {
      const m = /^(\d{1,2})\.(\d{2})$/.exec(t);
      // only a '.' typed in the text, not one produced by a fraction ("2¼" → 2.25)
      if (!m || Number(m[1]) > 24 || Number(m[2]) > 59 || !words[pieces[idx].word].includes(t)) return;
      const next = texts[idx + 1];
      const priced = next !== undefined && (next in CURRENCY || SHARED.percentWords.has(next));
      if (clock.suffixes.has(next) || (clock.prepositions.has(texts[idx - 1]) && !priced)) texts[idx] = `${Number(m[1])}:${m[2]}`;
    });
  }
  const keys: string[][] = words.map(() => []);
  const consumed: boolean[] = words.map(() => false);
  const own: boolean[] = words.map(() => false);

  let i = 0;
  while (i < pieces.length) {
    if (texts[i] === BREAK) { i++; continue; }
    let j = i;
    let prefixCurrency: string | undefined;
    if (isCurrency(texts[j]) && texts[j + 1] !== undefined && parseNumberAt(texts, j + 1, lang)) {
      prefixCurrency = CURRENCY[texts[j]];
      j++;
    }
    const parsed = parseNumberAt(texts, j, lang);
    const num = opts.alternative && parsed?.alternative ? parsed.alternative : parsed;
    if (!num) {
      keys[pieces[i].word].push(texts[i]);
      own[pieces[i].word] = true;
      i++;
      continue;
    }
    j += num.length;
    let suffix = prefixCurrency ? ` ${prefixCurrency}` : '';
    if (!num.ordinal && !prefixCurrency) {
      if (isCurrency(texts[j])) { suffix = ` ${CURRENCY[texts[j]]}`; j++; }
      else if (texts[j] !== undefined && SHARED.percentWords.has(texts[j])) { suffix = ' percent'; j++; }
      else if (texts[j] === 'per' && texts[j + 1] === 'cent') { suffix = ' percent'; j += 2; }
    }
    const head = pieces[i].word;
    keys[head].push((num.raw ?? numberKey(num.value, num.ordinal)) + suffix);
    own[head] = true;
    for (let k = i + 1; k < j; k++) if (pieces[k].word !== head) consumed[pieces[k].word] = true;
    i = j;
  }

  return words.map((text, w) => {
    const key = keys[w].join(' ');
    return { text, key, cont: consumed[w] && !own[w], filler: isFiller(key, lang) };
  });
}

/** Key for a whole text: the keys of its display words joined by spaces. */
export function normalizeText(text: string, lang: Lang, opts: { alternative?: boolean } = {}): string {
  return normalizeWords(tokenizeDisplay(text), lang, opts)
    .map((w) => w.key)
    .filter((k) => k !== '')
    .join(' ');
}

/** Dashes and minus signs a number may start with, all read as "-". */
const MINUS = /^[-‐‑‒–—―−]$/u;

/**
 * The sign a display word writes before its number ("-5", "−5", "+5", "-€12", "(-3%)"), or "" when there is none.
 * A dash between digits or words ("5-3", "COVID-19") or one followed by a space ("- 5") is no sign.
 */
export function numberSign(word: string): '-' | '+' | '' {
  const m = /^[^\p{L}\p{N}\s+\-‐‑‒–—―−]*([+\-‐‑‒–—―−])[€$£]?\p{Nd}/u.exec(word);
  if (!m) return '';
  return MINUS.test(m[1]) ? '-' : '+';
}

/**
 * The numeric content of a text: numbers plus their currency/percent markers, in order. A written sign is part of
 * the number ("-5" ≠ "5" ≠ "+5"); a spoken one ("minus five") is not read, so it never equals a written one.
 * Known limitation: magnitude suffixes ("5k", "$5M", "2bn") are not expanded to numbers.
 */
export function numericKeys(text: string, lang: Lang, opts: { alternative?: boolean } = {}): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  for (const w of normalizeWords(tokenizeDisplay(text), lang, opts)) {
    let sign = numberSign(w.text);
    if (w.key === '') {
      // a number that a word before it took in ("EUR -12": the key "12 eur" is on "EUR") keeps this word's sign
      let k = sign !== '' && w.cont ? parts.length - 1 : -1;
      while (k >= 0 && !/^[+-]?\d/.test(parts[k])) k--;
      if (k >= 0 && /^\d/.test(parts[k])) parts[k] = sign + parts[k];
      continue;
    }
    for (const p of w.key.split(' ')) {
      // the sign goes to the word's first number
      if (sign !== '' && /^\d/.test(p)) { parts.push(sign + p); sign = ''; } else parts.push(p);
    }
  }
  const isNumber = (p: string | undefined) => p !== undefined && /^[+-]?\d/.test(p);
  parts.forEach((p, idx) => {
    if (isNumber(p)) out.push(p);
    else if (idx > 0 && isNumber(parts[idx - 1]) && SHARED.numberUnits.has(p)) out.push(p);
  });
  return out;
}

/** The numeric content of a text under each reading of its number words: one, or two for "twenty-second". */
export function numericReadings(text: string, lang: Lang): string[][] {
  const first = numericKeys(text, lang);
  const other = numericKeys(text, lang, { alternative: true });
  return other.join(' ') === first.join(' ') ? [first] : [first, other];
}

/** Whether two texts can say the same numbers: some reading of one equals some reading of the other. */
export function sameNumbers(a: string, b: string, lang: Lang, key: (keys: string[]) => string = (k) => k.join(' ')): boolean {
  const readings = new Set(numericReadings(a, lang).map(key));
  return numericReadings(b, lang).some((r) => readings.has(key(r)));
}
