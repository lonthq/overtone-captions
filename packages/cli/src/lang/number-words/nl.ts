import { dict } from '../dict.js';
import type { ParsedNumber } from '../types.js';

// Dutch number words for the `numbers.parseWords` field of the Dutch pack. Dutch writes numbers below a million as
// one compound word ("drieëntwintig", "tweehonderdvijftig"), so most of the work is splitting compounds.

const NL_UNITS: Readonly<Record<string, number>> = dict({ een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 });
const NL_TEENS: Readonly<Record<string, number>> = dict({
  tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19,
});
const NL_TENS: Readonly<Record<string, number>> = dict({
  twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90,
});
const NL_SCALES: Readonly<Record<string, number>> = dict({ miljoen: 1e6, miljard: 1e9 });

function nlBelow100(s: string): number | null {
  if (s in NL_TEENS) return NL_TEENS[s];
  if (s in NL_TENS) return NL_TENS[s];
  if (s in NL_UNITS) return NL_UNITS[s];
  for (const [u, v] of Object.entries(NL_UNITS)) {
    if (s.startsWith(`${u}en`) && s.slice(u.length + 2) in NL_TENS) return v + NL_TENS[s.slice(u.length + 2)];
  }
  return null;
}
function nlBelow1000(s: string): number | null {
  const at = s.indexOf('honderd');
  if (at < 0) return nlBelow100(s);
  const head = s.slice(0, at);
  const tail = s.slice(at + 'honderd'.length);
  const h = head === '' ? 1 : nlBelow100(head);
  const t = tail === '' ? 0 : nlBelow100(tail);
  return h === null || t === null ? null : h * 100 + t; // 10–99 hundreds too: "negentienhonderd" = 1900
}
/** One Dutch compound number word: "drieentwintig" (accents already folded), "tweehonderdvijftig", "duizend". */
export function parseDutchWord(s: string): { value: number; ordinal: boolean } | null {
  if (s === 'nul') return { value: 0, ordinal: false };
  if (s === 'een') return null; // the article; "één" is mapped to "1" before folding
  if (s === 'eerste') return { value: 1, ordinal: true };
  if (s === 'derde') return { value: 3, ordinal: true };
  const cardinal = (w: string): number | null => {
    const at = w.indexOf('duizend');
    if (at < 0) return nlBelow1000(w);
    const head = w.slice(0, at);
    const tail = w.slice(at + 'duizend'.length);
    const h = head === '' ? 1 : nlBelow1000(head);
    const t = tail === '' ? 0 : nlBelow1000(tail);
    return h === null || t === null ? null : h * 1000 + t;
  };
  const c = cardinal(s);
  if (c !== null) return { value: c, ordinal: false };
  for (const suffix of ['ste', 'de']) {
    if (s.endsWith(suffix) && s.length > suffix.length + 2) {
      const v = cardinal(s.slice(0, -suffix.length));
      if (v !== null) return { value: v, ordinal: true };
    }
  }
  return null;
}

/** The scale a Dutch number word ends on: "tweeduizend" → 1000, "honderd" → 100, "tweehonderdvijftig" → 0. */
function trailingScale(word: string): number {
  return word.endsWith('duizend') ? 1000 : word.endsWith('honderd') ? 100 : 0;
}

/**
 * Dutch number words, including split forms ("twee duizend", "vijf honderd", "twee miljoen") and remainders
 * after a scale ("drie miljoen tweehonderdduizend", "honderd twintig", "twee duizend vierentwintig").
 * `article` allows "een" to mean 1 in front of a scale word and "(een) half miljoen"; it is off for remainders.
 */
export function parseDutchWords(pieces: readonly string[], start: number, article = true): ParsedNumber | null {
  const word = pieces[start];
  const next = pieces[start + 1];
  if (article) {
    // "half miljoen", "een half miljoen" → 500 000
    const halfAt = word === 'half' ? start : word === 'een' && next === 'half' ? start + 1 : -1;
    if (halfAt >= 0 && pieces[halfAt + 1] in NL_SCALES) {
      return { value: 0.5 * NL_SCALES[pieces[halfAt + 1]], ordinal: false, length: halfAt + 2 - start };
    }
  }
  // the article doubles as the number 1 in front of a scale word: "een miljoen", "een duizend", "een honderd"
  let first = parseDutchWord(word);
  if (!first && article && word === 'een' && next !== undefined && (next in NL_SCALES || next === 'duizend' || next === 'honderd')) {
    first = { value: 1, ordinal: false };
  }
  if (!first) return null;
  if (first.ordinal) return { ...first, length: 1 };
  let value = first.value;
  let last = trailingScale(word);
  let i = start + 1;
  for (; i < pieces.length; i++) {
    const p = pieces[i];
    const scale = p in NL_SCALES ? NL_SCALES[p] : p === 'duizend' ? 1000 : p === 'honderd' ? 100 : 0;
    if (scale === 0 || value <= 0 || value >= (scale === 100 ? 10 : 1000)) break;
    value *= scale;
    last = scale;
  }
  // a remainder smaller than the scale just applied belongs to the same number
  if (last > 0 && i < pieces.length) {
    const rest = parseDutchWords(pieces, i, false);
    if (rest && !rest.ordinal && rest.value > 0 && rest.value < last) { value += rest.value; i += rest.length; }
  }
  return { value, ordinal: false, length: i - start };
}

