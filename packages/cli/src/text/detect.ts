/**
 * Stopword language guess, to give the timing provider a locale when neither the user nor the text provider named
 * one: Azure Fast Transcription's automatic language ID covers a fixed set of locales (no Dutch).
 *
 * A wrong locale is worse than none, so the guess is conservative: related languages without detection are scored
 * as decoys (lang/decoys.ts), and a decoy that wins or comes close makes the result undefined.
 */
import { DECOYS, PACKS } from '../lang/index.js';

/** Languages the guess may return: the packs with detection stopwords. */
const DETECTED: Record<string, readonly string[]> = Object.fromEntries(PACKS.flatMap((p) => (p.detection ? [[p.code, p.detection.stopwords]] : [])));

/** word → languages listing it; a word shared by k languages counts 1/k for each. */
const INDEX = new Map<string, string[]>();
for (const [lang, words] of [...Object.entries(DETECTED), ...Object.entries(DECOYS)]) {
  for (const w of new Set(words)) INDEX.set(w, [...(INDEX.get(w) ?? []), lang]);
}

/** Minimum weighted stopword score of the winner. */
const MIN_SCORE = 3;
/** The winner must beat the runner-up (decoys included) by this factor. */
const MIN_MARGIN = 1.5;
/** At least this share of all words must be stopwords of the winner. */
const MIN_SHARE = 0.2;
/** At least this many different stopwords of the winner must occur ("la la la" is one). */
const MIN_DISTINCT = 4;

/** ISO 639-1 code of the text's language ('en', 'nl', 'de', …: a pack with detection), or undefined when unsure. */
export function detectLanguage(text: string): string | undefined {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = new Map<string, number>();
  const hits = new Map<string, number>();
  const distinct = new Map<string, Set<string>>();
  for (const word of tokens) {
    const langs = INDEX.get(word);
    if (!langs) continue;
    for (const l of langs) {
      scores.set(l, (scores.get(l) ?? 0) + 1 / langs.length);
      hits.set(l, (hits.get(l) ?? 0) + 1);
      if (!distinct.has(l)) distinct.set(l, new Set());
      distinct.get(l)!.add(word);
    }
  }
  const [best, second] = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!best || !Object.hasOwn(DETECTED, best[0])) return undefined;
  const [lang, score] = best;
  if (score < MIN_SCORE || (second && score < second[1] * MIN_MARGIN)) return undefined;
  if ((hits.get(lang) ?? 0) / tokens.length < MIN_SHARE || (distinct.get(lang)?.size ?? 0) < MIN_DISTINCT) return undefined;
  return lang;
}

/** Language names users may type ('dutch', 'flemish') → code, from the packs' aliases. */
const NAMES: Record<string, string> = Object.fromEntries(PACKS.flatMap((p) => (p.aliases ?? []).map((a) => [a, p.code])));

/** A provider's language value ('en', 'nl-NL', 'pt_BR', 'dutch') → primary ISO code ('en', 'nl', 'pt'), or undefined. */
export function normalizeLanguageCode(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (Object.hasOwn(NAMES, v)) return NAMES[v];
  const m = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/.exec(v);
  return m?.[1];
}

/**
 * A user's --language value in canonical BCP-47 casing ('nl_be' → 'nl-BE', 'dutch' → 'nl'), or undefined when it
 * is neither a known language name nor shaped like a language tag.
 */
export function canonicalLanguage(value: string): string | undefined {
  const v = value.trim();
  if (Object.hasOwn(NAMES, v.toLowerCase())) return NAMES[v.toLowerCase()];
  if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(v)) return undefined;
  const [primary, ...rest] = v.split(/[-_]/);
  const sub = rest.map((p) => (/^[a-z]{2}$/i.test(p) ? p.toUpperCase() : /^[a-z]{4}$/i.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase()));
  return [primary.toLowerCase(), ...sub].join('-');
}
