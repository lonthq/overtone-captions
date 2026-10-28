import { SHARED, getPack, langOf, type Lang } from '../lang/index.js';
import { normalizeWords } from '../text/normalize.js';

/**
 * How long a word takes to say: shares a timed span among its words, gives unheard words a natural length and
 * measures a recording's speaking rate.
 */

/** Speaking rate (seconds per spoken character) when it cannot be measured. */
const DEFAULT_SEC_PER_CHAR = 0.07;

/** Split [start, end] into consecutive pieces proportional to `weights` (e.g. character lengths). */
export function splitSpan(start: number, end: number, weights: readonly number[]): Array<[number, number]> {
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Array<[number, number]> = [];
  let t = start;
  weights.forEach((w, i) => {
    const e = i === weights.length - 1 ? end : t + ((end - start) * w) / (total || 1);
    out.push([t, e]);
    t = e;
  });
  return out;
}

/** Weight of a display word when a timed span is shared among the words that said it: its length, at least 1. */
export function charWeight(text: string): number {
  return Math.max(1, text.length);
}

/** Spoken characters of a whole number, roughly and language-neutral ("twelve" ≈ 7, "twenty one" ≈ 10). */
function integerChars(n: number): number {
  if (n === 0) return 4;
  // years and other four-digit numbers are usually said in pairs ("nineteen ninety")
  if (n >= 1100 && n < 10000 && n % 100 !== 0) return integerChars(Math.floor(n / 100)) + 1 + integerChars(n % 100);
  const group = (g: number): number => {
    const h = Math.floor(g / 100);
    const r = g % 100;
    const rest = r >= 20 ? 6 + (r % 10 > 0 ? 5 : 0) : r >= 10 ? 7 : r > 0 ? 4 : 0;
    return (h > 0 ? 12 : 0) + rest;
  };
  let chars = 0;
  let scale = 0;
  for (let rest = Math.floor(n); rest > 0; rest = Math.floor(rest / 1000), scale++) {
    const g = rest % 1000;
    if (g > 0) chars += group(g) + (scale > 0 ? 9 : 0);
  }
  return chars;
}

/** Spoken characters of a comparison-key piece that is a number: "12", "1.5", "3th", "007", "10:30". */
function numberChars(piece: string): number {
  if (piece.includes(':')) return piece.split(':').reduce((n, p) => n + numberChars(p) + 1, -1);
  if (/^0\d+$/.test(piece)) return piece.length * 5; // digits said one by one ("oh oh seven")
  const ordinal = piece.endsWith('th');
  const [int, frac] = piece.replace(/th$/, '').split('.');
  const value = Number(int);
  // too many digits for a double ("9" × 309 is Infinity): said digit by digit
  let chars = value === Infinity ? int.length * 5 : integerChars(value);
  if (frac) chars += 6 + frac.length * 5; // "point five"
  return chars + (ordinal ? 2 : 0);
}

/** The language's own word for a currency code ("usd" → "dollars" in English), else a typical length. */
function currencyChars(code: string, lang: Lang): number {
  const words = Object.entries(getPack(lang).numbers?.currencyWords ?? {}).filter(([w, c]) => c === code && /^\p{L}+$/u.test(w));
  return words.length > 0 ? Math.max(...words.map(([w]) => w.length)) : 6;
}

const CURRENCY_CODES = new Set(Object.values(SHARED.currency));

/**
 * Expected spoken length of a display word, in characters: its comparison key with numbers, currencies and percent
 * signs said out ("$12" → "twelve dollars", "10:30" → "ten thirty"), plus one for the pause after it.
 */
export function spokenLength(text: string, lang: Lang): number {
  const key = normalizeWords([text], lang)[0]?.key ?? '';
  const pieces = key.split(' ').filter((p) => p.length > 0);
  if (pieces.length === 0) return Math.max(1, text.length) + 1;
  let chars = pieces.length; // the spaces between pieces and the pause after the word
  for (const p of pieces) {
    if (/^\d/.test(p)) chars += numberChars(p);
    else if (CURRENCY_CODES.has(p)) chars += currencyChars(p, lang);
    else if (p === 'percent') chars += getPack(lang).numbers?.percentWords?.[0]?.length ?? 7;
    else chars += p.length;
  }
  return chars;
}

/** Natural length of a word no engine timed: speaking rate × expected spoken length, at least `minDur`. */
export function naturalLength(word: string, secPerChar: number, minDur: number, lang: Lang): number {
  return Math.max(minDur, spokenLength(word, lang) * secPerChar);
}

/**
 * Seconds per spoken character of running speech, measured from word to word on consecutive exact matches (so the
 * short pauses between words count; a pause over 1 s does not), clamped to a plausible range.
 */
export function speakingRate(
  textWords: readonly string[],
  timings: ReadonlyArray<{ start: number; match: string } | null | undefined>,
  language?: string,
): number {
  const lang = langOf(language);
  let time = 0;
  let chars = 0;
  for (let i = 0; i + 1 < timings.length; i++) {
    const r = timings[i];
    const next = timings[i + 1];
    if (r?.match !== 'exact' || next?.match !== 'exact') continue;
    const step = next.start - r.start;
    if (step <= 0 || step > 1) continue;
    time += step;
    chars += spokenLength(textWords[i]!, lang);
  }
  return chars < 20 ? DEFAULT_SEC_PER_CHAR : Math.min(0.15, Math.max(0.03, time / chars));
}
