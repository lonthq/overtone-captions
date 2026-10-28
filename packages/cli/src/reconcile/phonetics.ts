// How words sound, for the text vote: grapheme-to-phoneme per language, syllable counts and a feature-weighted
// phoneme distance. English uses the CMU Pronouncing Dictionary (BSD-style license, downloaded once by cmudict.ts) with
// a small letter-to-sound fallback; Dutch, German and Spanish use hand-written rules. Other languages use the Dutch
// rules, which read most Latin-script spellings plausibly.

import { loadCmudict, type DictionaryOptions } from './cmudict.js';

// ---------------------------------------------------------------- phoneme inventory and features

/** Vowels: [height 0..1, backness 0..1, rounded 0/1, has a glide]. */
const V: Record<string, readonly [number, number, number, boolean]> = {
  IY: [1.0, 0.0, 0, false], IH: [0.85, 0.15, 0, false], EY: [0.7, 0.05, 0, true], EH: [0.5, 0.1, 0, false], AE: [0.2, 0.1, 0, false],
  AA: [0.0, 0.7, 0, false], AO: [0.3, 1.0, 1, false], OW: [0.6, 1.0, 1, true], UH: [0.85, 0.85, 1, false], UW: [1.0, 1.0, 1, false],
  AH: [0.4, 0.6, 0, false], AX: [0.5, 0.5, 0, false], ER: [0.5, 0.5, 0, false], AW: [0.0, 0.6, 0, true], AY: [0.0, 0.5, 0, true],
  OY: [0.3, 1.0, 1, true], UE: [1.0, 0.0, 1, false], OE: [0.6, 0.1, 1, false], UI: [0.4, 0.3, 1, true], EI: [0.5, 0.1, 0, true],
};
type Manner = 'stop' | 'fric' | 'affr' | 'nasal' | 'lat' | 'rho' | 'glide';
/** Consonants: [place 0 bilabial … 7 glottal, manner, voiced]. */
const C: Record<string, readonly [number, Manner, number]> = {
  P: [0, 'stop', 0], B: [0, 'stop', 1], T: [3, 'stop', 0], D: [3, 'stop', 1], K: [6, 'stop', 0], G: [6, 'stop', 1],
  F: [1, 'fric', 0], V: [1, 'fric', 1], TH: [2, 'fric', 0], DH: [2, 'fric', 1], S: [3, 'fric', 0], Z: [3, 'fric', 1],
  SH: [4, 'fric', 0], ZH: [4, 'fric', 1], X: [6, 'fric', 0], HH: [7, 'fric', 0],
  CH: [4, 'affr', 0], JH: [4, 'affr', 1],
  M: [0, 'nasal', 1], N: [3, 'nasal', 1], NG: [6, 'nasal', 1],
  L: [3, 'lat', 1], R: [3, 'rho', 1], W: [0, 'glide', 1], Y: [5, 'glide', 1],
};
const MANNER: Record<string, number> = {
  'stop|fric': 0.5, 'stop|affr': 0.3, 'fric|affr': 0.3, 'stop|nasal': 0.5, 'nasal|lat': 0.6, 'lat|rho': 0.3,
  'rho|glide': 0.5, 'lat|glide': 0.5, 'fric|glide': 0.7, 'nasal|rho': 0.6,
};
const isVowel = (p: string): boolean => p in V;
/** Is the phoneme in the inventory above? */
const known = (p: string): boolean => Object.hasOwn(V, p) || Object.hasOwn(C, p);

function vowelCost(a: string, b: string): number {
  if (a === b) return 0;
  const [h1, b1, r1, g1] = V[a]!;
  const [h2, b2, r2, g2] = V[b]!;
  const d = Math.hypot(h1 - h2, b1 - b2) / Math.SQRT2;
  let c = 0.1 + 0.8 * d + 0.1 * Math.abs(r1 - r2) + (g1 !== g2 ? 0.1 : 0);
  if (a === 'AX' || b === 'AX' || a === 'AH' || b === 'AH') c = Math.min(c, 0.35); // schwa is close to every vowel
  if ((a === 'ER' && b === 'AX') || (a === 'AX' && b === 'ER')) c = 0.25;
  return Math.min(1, c);
}
function consCost(a: string, b: string): number {
  if (a === b) return 0;
  const [p1, m1, v1] = C[a]!;
  const [p2, m2, v2] = C[b]!;
  const mk = m1 === m2 ? 0 : (MANNER[`${m1}|${m2}`] ?? MANNER[`${m2}|${m1}`] ?? 0.8);
  return Math.min(1, 0.05 + (0.3 * Math.abs(p1 - p2)) / 6 + mk + 0.15 * Math.abs(v1 - v2));
}
function subCost(a: string, b: string): number {
  if (a === b) return 0;
  const va = isVowel(a);
  const vb = isVowel(b);
  if (va && vb) return vowelCost(a, b);
  if (!va && !vb) return consCost(a, b);
  const [v, c] = va ? [a, b] : [b, a];
  if (c === 'R' && v === 'ER') return 0.4;
  if (c === 'W' && (v === 'UW' || v === 'UH')) return 0.5;
  if (c === 'Y' && (v === 'IY' || v === 'IH')) return 0.5;
  return 1;
}
/** Weak sounds are cheap to drop or add (h, schwa, glides). */
const indelCost = (p: string): number => (p === 'HH' || p === 'AX' ? 0.5 : p === 'W' || p === 'Y' ? 0.7 : 1);

/** Weighted edit distance between two phoneme lists. */
function phoneDistance(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  const m = b.length;
  let prev = new Float64Array(m + 1);
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1]! + indelCost(b[j - 1]!);
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1);
    cur[0] = prev[0]! + indelCost(a[i - 1]!);
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j - 1]! + subCost(a[i - 1]!, b[j - 1]!), prev[j]! + indelCost(a[i - 1]!), cur[j - 1]! + indelCost(b[j - 1]!));
    }
    prev = cur;
  }
  return prev[m]!;
}

/** How alike two phoneme lists sound, 0..1: 1 − distance / the cost of the longer side. */
export function phoneSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const ca = a.reduce((s, p) => s + indelCost(p), 0);
  const cb = b.reduce((s, p) => s + indelCost(p), 0);
  return Math.max(0, 1 - phoneDistance(a, b) / Math.max(ca, cb));
}

// ---------------------------------------------------------------- letter-to-sound rules

/** A rule: left context (tested on the text before), letters, right context (on the text after), phonemes. */
type Rule = readonly [RegExp | null, string, RegExp | null, string];
const VOW = '[aeiouy]';
const CONS = '[bcdfghjklmnpqrstvwxz]';
const R = (l: string, g: string, r: string, p: string): Rule => [l ? new RegExp(`${l}$`) : null, g, r ? new RegExp(`^${r}`) : null, p];

// English fallback for words outside the dictionary: a small rule set in the spirit of the 1976 NRL rules (Elovitz et
// al.), written from scratch.
const EN_RULES: readonly Rule[] = [
  R('#', 'kn', '', 'N'), R('#', 'gn', '', 'N'), R('#', 'wr', '', 'R'), R('#', 'ps', '', 'S'), R('', 'wh', '', 'W'),
  R('', 'tch', '', 'CH'), R('', 'tion', '', 'SH AX N'), R('', 'sion', '', 'ZH AX N'), R('', 'ture', '', 'CH ER'),
  R('', 'igh', '', 'AY'), R('', 'ough', '#', 'OW'), R('', 'augh', '', 'AO'), R('', 'ould', '', 'UH D'),
  R('', 'sch', '', 'S K'), R('', 'ch', '', 'CH'), R('', 'sh', '', 'SH'), R('', 'ph', '', 'F'), R('#', 'th', '[aei]', 'DH'),
  R('', 'th', '', 'TH'), R('', 'ck', '', 'K'), R('', 'ng', '', 'NG'), R('', 'nk', '', 'NG K'), R('', 'qu', '', 'K W'),
  R('', 'dge', '', 'JH'), R('', 'gh', '', ''),
  R('', 'ar', `(?:${CONS}|#|e#|es#)`, 'AA R'), R('', 'or', `(?:${CONS}|#|e#)`, 'AO R'), R('', 'er', `(?:${CONS}|#|s#)`, 'ER'),
  R('', 'ir', `(?:${CONS}|#)`, 'ER'), R('', 'ur', `(?:${CONS}|#)`, 'ER'), R('', 'ear', '', 'IH R'), R('', 'air', '', 'EH R'),
  R('', 'ee', '', 'IY'), R('', 'ea', '', 'IY'), R('', 'oo', '[kd]', 'UH'), R('', 'oo', '', 'UW'), R('', 'ou', '', 'AW'),
  R('', 'ow', '#', 'OW'), R('', 'ow', '', 'AW'), R('', 'oi', '', 'OY'), R('', 'oy', '', 'OY'), R('', 'ai', '', 'EY'),
  R('', 'ay', '', 'EY'), R('', 'au', '', 'AO'), R('', 'aw', '', 'AO'), R('', 'ie', '#', 'AY'), R('', 'ie', '', 'IY'),
  R('', 'ei', '', 'EY'), R('', 'ey', '#', 'IY'), R('', 'ue', '#', 'UW'), R('', 'ew', '', 'UW'), R('', 'oa', '', 'OW'),
  R(`${CONS}`, 'le', '#', 'AX L'), R('[td]', 'ed', '#', 'IH D'), R('[pkfsx]|ch|sh', 'ed', '#', 'T'), R('', 'ed', '#', 'D'),
  R('(?:s|z|x|ch|sh|ge|ce)', 'es', '#', 'IH Z'), R('', 'es', '#', 'Z'), R('', 'e', '#', ''), R('', 'e', 's#', ''),
  R(`${VOW}|[bdgvmnlr]`, 's', '#', 'Z'), R(`${VOW}`, 's', `${VOW}`, 'Z'),
  R('', 'a', `${CONS}e(?:#|s#|d#|r)`, 'EY'), R('', 'i', `${CONS}e(?:#|s#|d#)`, 'AY'), R('', 'o', `${CONS}e(?:#|s#|d#)`, 'OW'),
  R('', 'u', `${CONS}e(?:#|s#|d#)`, 'UW'),
  R('#', 'y', '', 'Y'), R(`${CONS}`, 'y', '#', 'IY'), R('', 'y', '', 'IH'),
  R('', 'a', '#', 'AX'), R('', 'a', '', 'AE'), R('', 'e', '', 'EH'), R('', 'i', '', 'IH'), R('', 'o', '#', 'OW'),
  R('', 'o', '', 'AA'), R('', 'u', '', 'AH'),
  R('', 'c', '[eiy]', 'S'), R('', 'c', '', 'K'), R('', 'g', '[eiy]', 'JH'), R('', 'g', '', 'G'), R('', 'x', '', 'K S'),
  R('', 'j', '', 'JH'), R('', 'b', '', 'B'), R('', 'd', '', 'D'), R('', 'f', '', 'F'), R('', 'h', '', 'HH'), R('', 'k', '', 'K'),
  R('', 'l', '', 'L'), R('', 'm', '', 'M'), R('', 'n', '', 'N'), R('', 'p', '', 'P'), R('', 'r', '', 'R'), R('', 's', '', 'S'),
  R('', 't', '', 'T'), R('', 'v', '', 'V'), R('', 'w', '', 'W'), R('', 'z', '', 'Z'),
];

const NL_RULES: readonly Rule[] = [
  R('', 'ieuw', '', 'IY W'), R('', 'eeuw', '', 'EY W'), R('', 'aai', '', 'AA Y'), R('', 'ooi', '', 'OW Y'), R('', 'oei', '', 'UW Y'),
  R('', 'sch', '#', 'S'), R('', 'sch', '', 'S X'), R('', 'lijk', '#', 'L AX K'), R('', 'tie', '#', 'T S IY'),
  R('', 'aa', '', 'AA'), R('', 'ee', '', 'EY'), R('', 'oo', '', 'OW'), R('', 'uu', '', 'UE'), R('', 'ie', '', 'IY'),
  R('', 'oe', '', 'UW'), R('', 'eu', '', 'OE'), R('', 'ui', '', 'UI'), R('', 'ij', '', 'EI'), R('', 'ei', '', 'EI'),
  R('', 'ou', '', 'AW'), R('', 'au', '', 'AW'), R('', 'uw', '', 'UE W'),
  R('', 'ch', '', 'X'), R('', 'ng', '', 'NG'), R('', 'nk', '', 'NG K'), R('', 'sj', '', 'SH'), R('', 'tj', '', 'CH'),
  R('', 'dt', '#', 'T'), R('', 'th', '', 'T'), R('', 'ph', '', 'F'), R('', 'qu', '', 'K W'),
  R('(?:#|#in|#ont|#op|#aan|#uit|#af|#mee)[gb]', 'e', '', 'AX'), R('#v', 'e', 'r', 'AX'),
  R(`${CONS}`, 'ig', '#', 'AX X'), R('', 'en', '#', 'AX N'), R(`${VOW}${CONS}+`, 'e', '(?:ns|rs|ls|nd|nde|nt)#', 'AX'), R(`${VOW}${CONS}`, 'e', '#', 'AX'), R(`${CONS}`, 'e', '[lrn]#', 'AX'),
  R('', 'a', `(?:${CONS}${VOW}|#)`, 'AA'), R('', 'e', `(?:${CONS}${VOW}|#)`, 'EY'), R('', 'o', `(?:${CONS}${VOW}|#)`, 'OW'),
  R('', 'u', `(?:${CONS}${VOW}|#)`, 'UE'),
  R('', 'a', '', 'AA'), R('', 'e', '', 'EH'), R('', 'i', '', 'IH'), R('', 'o', '', 'AO'), R('', 'u', '', 'UE'), R('', 'y', '', 'IY'),
  R('', 'c', '[eiy]', 'S'), R('', 'c', '', 'K'), R('', 'g', '', 'X'), R('', 'j', '', 'Y'), R('', 'x', '', 'K S'),
  R('', 'd', '#', 'T'), R('', 'b', '#', 'P'), R('', 'v', '', 'V'), R('', 'w', '', 'W'), R('', 'z', '', 'Z'),
  R('', 'b', '', 'B'), R('', 'd', '', 'D'), R('', 'f', '', 'F'), R('', 'h', '', 'HH'), R('', 'k', '', 'K'), R('', 'l', '', 'L'),
  R('', 'm', '', 'M'), R('', 'n', '', 'N'), R('', 'p', '', 'P'), R('', 'r', '', 'R'), R('', 's', '', 'S'), R('', 't', '', 'T'),
];

const DE_RULES: readonly Rule[] = [
  R('', 'tsch', '', 'CH'), R('', 'sch', '', 'SH'), R('#', 'sp', '', 'SH P'), R('#', 'st', '', 'SH T'), R('', 'chs', '', 'K S'),
  R('[aou]', 'ch', '', 'X'), R('', 'ch', '', 'SH'), R('', 'ck', '', 'K'), R('', 'ng', '', 'NG'), R('', 'nk', '', 'NG K'),
  R('', 'pf', '', 'P F'), R('', 'ph', '', 'F'), R('', 'th', '', 'T'), R('', 'tz', '', 'T S'), R('', 'qu', '', 'K V'),
  R('', 'tion', '', 'T S Y OW N'),
  R('', 'äu', '', 'OY'), R('', 'eu', '', 'OY'), R('', 'ei', '', 'AY'), R('', 'ai', '', 'AY'), R('', 'au', '', 'AW'),
  R('', 'ie', '', 'IY'), R('', 'aa', '', 'AA'), R('', 'ah', '', 'AA'), R('', 'ee', '', 'EY'), R('', 'eh', '', 'EY'),
  R('', 'oo', '', 'OW'), R('', 'oh', '', 'OW'), R('', 'uh', '', 'UW'), R('', 'ih', '', 'IY'), R('', 'üh', '', 'UE'), R('', 'öh', '', 'OE'),
  R(`${CONS}`, 'ig', '#', 'IH SH'), R(`${VOW}${CONS}+`, 'en', '#', 'AX N'), R(`${VOW}${CONS}+`, 'er', '#', 'ER'),
  R(`${VOW}${CONS}+`, 'el', '#', 'AX L'), R(`${VOW}${CONS}+`, 'e', '#', 'AX'), R('#(?:b|g)', 'e', '', 'AX'),
  R('', 'a', '', 'AA'), R('', 'ä', '', 'EH'), R('', 'e', `${CONS}${CONS}`, 'EH'), R('', 'e', '', 'EY'), R('', 'i', '', 'IH'),
  R('', 'o', `${CONS}${CONS}`, 'AO'), R('', 'o', '', 'OW'), R('', 'u', `${CONS}${CONS}`, 'UH'), R('', 'u', '', 'UW'),
  R('', 'ü', '', 'UE'), R('', 'ö', '', 'OE'), R('', 'y', '', 'UE'),
  R('#', 's', `${VOW}`, 'Z'), R(`${VOW}`, 's', `${VOW}`, 'Z'), R('', 'ß', '', 'S'), R('', 'z', '', 'T S'), R('', 'w', '', 'V'),
  R('', 'v', '', 'F'), R('', 'j', '', 'Y'), R('', 'c', '', 'K'), R('', 'x', '', 'K S'),
  R('', 'b', `(?:#|${CONS})`, 'P'), R('', 'd', `(?:#|${CONS})`, 'T'), R('', 'g', `(?:#|${CONS})`, 'K'),
  R('', 'b', '', 'B'), R('', 'd', '', 'D'), R('', 'f', '', 'F'), R(`${VOW}`, 'h', '', ''), R('', 'h', '', 'HH'), R('', 'k', '', 'K'),
  R('', 'l', '', 'L'), R('', 'm', '', 'M'), R('', 'n', '', 'N'), R('', 'p', '', 'P'), R('', 'r', '', 'R'), R('', 's', '', 'S'),
  R('', 't', '', 'T'), R('', 'g', '', 'G'),
];

// Latin American Spanish (seseo, yeísmo)
const ES_RULES: readonly Rule[] = [
  R('', 'ch', '', 'CH'), R('', 'll', '', 'Y'), R('', 'rr', '', 'R'), R('', 'qu', '[ei]', 'K'), R('', 'gu', '[ei]', 'G'),
  R('', 'gü', '', 'G W'), R('', 'ñ', '', 'N Y'),
  R('[aeo]', 'i', '', 'Y'), R('', 'i', '[aeo]', 'Y'), R('[aeo]', 'u', '', 'W'), R('', 'u', '[aeio]', 'W'),
  R('', 'a', '', 'AA'), R('', 'e', '', 'EH'), R('', 'i', '', 'IY'), R('', 'o', '', 'OW'), R('', 'u', '', 'UW'),
  R(`(?:${CONS}|#)`, 'y', `(?:${CONS}|#)`, 'IY'), R('', 'y', '#', 'IY'), R('', 'y', '', 'Y'),
  R('', 'c', '[ei]', 'S'), R('', 'c', '', 'K'), R('', 'z', '', 'S'), R('', 'g', '[ei]', 'X'), R('', 'g', '', 'G'),
  R('', 'j', '', 'X'), R('', 'h', '', ''), R('', 'v', '', 'B'), R('', 'b', '', 'B'), R('', 'x', '', 'K S'),
  R('', 'd', '', 'D'), R('', 'f', '', 'F'), R('', 'k', '', 'K'), R('', 'l', '', 'L'), R('', 'm', '', 'M'), R('', 'n', '', 'N'),
  R('', 'p', '', 'P'), R('', 'r', '', 'R'), R('', 's', '', 'S'), R('', 't', '', 'T'), R('', 'w', '', 'W'),
];

function applyRules(word: string, rules: readonly Rule[]): string[] {
  const w = `#${word}#`;
  const out: string[] = [];
  let i = 1;
  while (i < w.length - 1) {
    // a doubled consonant sounds once
    if (i > 1 && w[i] === w[i - 1] && !/[aeiouy]/.test(w[i]!) && /[a-z]/.test(w[i]!)) { i++; continue; }
    let hit = false;
    for (const [l, g, r, p] of rules) {
      if (!w.startsWith(g, i)) continue;
      if (l && !l.test(w.slice(0, i))) continue;
      if (r && !r.test(w.slice(i + g.length))) continue;
      if (p) out.push(...p.split(' '));
      i += g.length;
      hit = true;
      break;
    }
    if (!hit) i++;
  }
  return out;
}

// ---------------------------------------------------------------- English

let CMU: Map<string, string[]> | undefined;
let loading: Promise<void> | undefined;

/** Does this language use the CMU dictionary (English)? Only then is it worth loading. */
export const usesDictionary = (language: string): boolean => language.slice(0, 2).toLowerCase() === 'en';

/**
 * Loads the CMU dictionary once per process (about 135,000 words: a local copy, the user cache, or a one-time
 * download). Call before `phrase` for English. If it cannot be had, one warning is logged and English uses the rules
 * only; never throws.
 */
export function loadPhonetics(opts: DictionaryOptions = {}): Promise<void> {
  loading ??= (async () => {
    const dictionary = await loadCmudict(opts);
    if (!dictionary) return;
    const map = new Map<string, string[]>();
    for (const [word, phones] of dictionary) {
      if (word.includes('(')) continue; // first pronunciation only
      const list = phones.split(' ').map((p) => (p === 'AH0' ? 'AX' : p.replace(/\d/, '')));
      if (!list.every(known)) continue; // a phoneme without features (a local copy's "SPN"): use the rules
      map.set(word, list);
    }
    CMU = map;
  })();
  return loading;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function enNumber(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${enNumber(n % 100)}` : ''}`;
  if (n < 1e6) return `${enNumber(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${enNumber(n % 1000)}` : ''}`;
  return String(n).split('').map((d) => ONES[+d]).join(' ');
}
/** 1990 → "nineteen ninety"; other numbers as cardinals. */
function enYear(n: number): string {
  if (n >= 1100 && n < 2000 && n % 100 !== 0) return `${enNumber(Math.floor(n / 100))} ${n % 100 < 10 ? 'oh ' : ''}${enNumber(n % 100)}`;
  return enNumber(n);
}
const COLLOQUIAL: Record<string, string> = { coulda: 'could', woulda: 'would', shoulda: 'should', musta: 'must', gotta: 'got', outta: 'out', kinda: 'kind', sorta: 'sort' };

function enWord(raw: string): string[] {
  const w = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
  if (!w) return [];
  if (/^\d+$/.test(w)) {
    const n = Number(w);
    return enText(n >= 1100 && n < 2100 ? enYear(n) : enNumber(n));
  }
  const dict = CMU;
  const bare = w.replace(/'/g, '');
  if (dict) {
    if (dict.has(w)) return dict.get(w)!;
    if (dict.has(bare)) return dict.get(bare)!;
    if (w.includes("'")) {
      const parts = w.split("'").filter(Boolean);
      if (parts.every((p) => dict.has(p) || p === 'a')) return parts.flatMap((p) => (p === 'a' ? ['AX'] : dict.get(p)!));
    }
    const colloquial = COLLOQUIAL[bare];
    if (colloquial && dict.has(colloquial)) return [...dict.get(colloquial)!, 'AX'];
    // compounds of two dictionary words (adlib = ad + lib), longest first part first
    for (let k = bare.length - 2; k >= 2; k--) {
      const a = bare.slice(0, k);
      const b = bare.slice(k);
      if (b.length >= 3 && dict.has(a) && dict.has(b)) return [...dict.get(a)!, ...dict.get(b)!];
    }
  }
  return applyRules(bare, EN_RULES);
}
function enText(text: string): string[] {
  return text.split(/\s+/).filter(Boolean).flatMap(enWord);
}

// ---------------------------------------------------------------- other languages

// digit readings for nl/de/es, to keep the syllable counts sane
const DIGITS: Record<string, readonly string[]> = {
  nl: ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'],
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
};
const RULES: Record<string, readonly Rule[]> = { nl: NL_RULES, de: DE_RULES, es: ES_RULES };

/** Phonemes of one word in a language ("en", "nl", "de", "es"; others use the Dutch rules). */
function wordPhones(word: string, language: string): string[] {
  const L = language.slice(0, 2).toLowerCase();
  if (L === 'en') return enWord(word);
  const rules = RULES[L] ?? NL_RULES;
  let w = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (L === 'es') w = w.normalize('NFD').replace(/́/g, '').normalize('NFC'); // á → a, keep ñ and ü
  else if (L !== 'de') w = w.normalize('NFD').replace(/\p{M}/gu, '');
  if (!w) return [];
  if (/^\d+$/.test(w)) return w.split('').flatMap((d) => applyRules((DIGITS[L] ?? DIGITS.nl!)[Number(d)]!, rules));
  return applyRules(w, rules);
}

export interface Sound { phones: string[]; syllables: number }

const cache = new Map<string, Sound>();

/** The phonemes of a phrase (word boundaries ignored) and its syllable count. */
export function phrase(text: string, language: string): Sound {
  const key = `${language}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const words = text.split(/[\s\-–—/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const phones = words.flatMap((w) => wordPhones(w, language));
  const sound = { phones, syllables: phones.filter(isVowel).length };
  if (cache.size > 50_000) cache.clear();
  cache.set(key, sound);
  return sound;
}

// ---------------------------------------------------------------- scripts without letter-to-sound rules

/**
 * Has the text a word in a script the rules do not cover (Japanese, Chinese, Cyrillic, Greek, …)? Such a word gives no
 * phonemes, so two different words would both be empty and sound the same.
 */
export const hasUnvoicedWord = (text: string): boolean => /(?=\p{L})\P{Script=Latin}/u.test(text);

/** Comparison key for the spelling fallback: graphemes of the letters, marks and digits, lowercase (NFKC). */
function graphemes(text: string): string[] {
  const key = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(key), (g) => g.segment);
}

/** How alike two spellings are, 0..1: 1 − grapheme edit distance / the longer side (1 for two empty keys). */
export function spellingSimilarity(a: string, b: string): number {
  const x = graphemes(a);
  const y = graphemes(b);
  if (x.length === 0 && y.length === 0) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1), prev[j]! + 1, cur[j - 1]! + 1);
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

/**
 * How alike two phrases sound (0..1), and their syllable counts. When either side has a word in a script without
 * letter-to-sound rules, the spellings are compared instead (`phonetic: false`, syllable counts meaningless).
 */
export function soundSimilarity(a: string, b: string, language: string): { similarity: number; syllables: [number, number]; phonetic: boolean } {
  const pa = phrase(a, language);
  const pb = phrase(b, language);
  const syllables: [number, number] = [pa.syllables, pb.syllables];
  if (hasUnvoicedWord(a) || hasUnvoicedWord(b)) return { similarity: spellingSimilarity(a, b), syllables, phonetic: false };
  return { similarity: phoneSimilarity(pa.phones, pb.phones), syllables, phonetic: true };
}
