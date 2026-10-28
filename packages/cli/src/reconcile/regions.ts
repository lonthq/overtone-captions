// Where the hearings disagree about the words: a time-constrained alignment of the text against each engine's words,
// then the disagreement regions and their class.
import { InternalError } from '../errors.js';
import { isFiller as packFiller, langOf } from '../lang/index.js';
import { normalizeText } from '../text/normalize.js';
import type { TimedWord } from '../types.js';
import { phrase, soundSimilarity } from './phonetics.js';

/** One engine's whole-file words, plus its snippet words where it had none. */
export interface EngineWords {
  /** Provider id ("azure-speech", "elevenlabs:scribe_v2"). */
  id: string;
  /** How the chooser prompt names it ("Azure Speech"). */
  label: string;
  words: readonly TimedWord[];
}

/** A text word as the vote sees it. `untimed`: no engine heard it there. */
export interface TextWord { text: string; start: number; end: number; untimed?: boolean }

/**
 * a: the text has no words and both engines heard words that sound alike; b: the text differs from two engines that
 * sound alike; c: any other disagreement.
 */
export type RegionClass = 'a' | 'b' | 'c';

export interface Region {
  /** Index in the file, for the chooser's answers. */
  id: number;
  cls: RegionClass;
  /** Kind of disagreement, for the log ("replace", "all-differ", "insert", …). */
  sub: string;
  /** Text words [first, last]; last = first − 1 marks an insertion before `first`. */
  first: number;
  last: number;
  start: number;
  end: number;
  /** The text words of the region. */
  text: string;
  /** Per engine (in engine order): its words in the region. */
  heard: TimedWord[][];
  /** Per hearing ('text' and each engine id): up to 4 of its words before and after the region. */
  around: Record<string, { before: string; after: string }>;
}

/**
 * Comparison key: lowercase letters, marks and digits. Marks stay because Indic vowel signs are marks ("में" "in" and
 * "मैं" "I" differ only there); NFC already joins Latin accents.
 */
export const wordKey = (w: string): string => w.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/**
 * Fillers and cut-off words ("Ye-", "th...") do not vote. Fillers come from the language packs only: "er" is a
 * hesitation in English but a word in Dutch and German.
 */
function isFillerWord(w: string, language: string): boolean {
  const k = wordKey(w);
  // pack fillers are written without accents ("ähm" → "ahm")
  if (k === '' || packFiller(k.normalize('NFD').replace(/\p{M}/gu, ''), langOf(language))) return true;
  const t = w.trim();
  return /[\p{L}][-–—]$/u.test(t) || /^\p{L}{1,3}(\.\.\.|…)$/u.test(t);
}

/** Normalized key of a phrase, without fillers. */
export function phraseKey(text: string, language: string): string {
  const lang = langOf(language);
  return normalizeText(text, lang).split(' ').filter((t) => t && !packFiller(t, lang)).join(' ');
}

const NUMBER_WORDS: Record<string, string> = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };

/**
 * 1 for the same key (or a small number as digits and as a word), else how alike the words sound (or are spelled, in
 * a script without letter-to-sound rules).
 */
export function wordSimilarity(a: string, b: string, language: string): number {
  const ka = wordKey(a);
  const kb = wordKey(b);
  if (ka === kb) return 1;
  if (!ka || !kb) return 0;
  if (language.startsWith('en') && (NUMBER_WORDS[ka] === kb || NUMBER_WORDS[kb] === ka)) return 1;
  return soundSimilarity(a, b, language).similarity;
}

/**
 * Words agree when they are the same or sound the same (Thom/Tom, OK/okay, 10/ten). Near homophones (glass/class,
 * 0.95) must not vote for each other.
 */
const AGREE = 0.97;
export const agree = (a: string, b: string, language: string): boolean => wordSimilarity(a, b, language) >= AGREE;

/** Region-level sound gate: phrase similarity, and syllable counts within 1. */
function soundsAlike(a: string, b: string, language: string, theta: number): { similarity: number; ok: boolean } {
  if (phraseKey(a, language) === phraseKey(b, language)) return { similarity: 1, ok: true };
  const s = soundSimilarity(a, b, language);
  if (!s.phonetic) return { similarity: s.similarity, ok: s.similarity >= theta }; // spellings: no syllables to compare
  if (phrase(a, language).phones.length === 0 || phrase(b, language).phones.length === 0) return { similarity: 0, ok: false };
  return { similarity: s.similarity, ok: s.similarity >= theta && Math.abs(s.syllables[0] - s.syllables[1]) <= 1 };
}

/** Disagreement detection (see `findRegions`). */
export const REGIONS = {
  /** A text word pairs with an engine word only when their midpoints are this close (seconds) … */
  window: 3,
  /** … or this close for a text word no engine heard (its time is an estimate). */
  untimedWindow: 12,
  /** Gap cost of the time-constrained alignment; a pair costs 1.15 − similarity. */
  gap: 0.6,
  /** Two engines' words "sound alike" for classes a and b at this similarity (±1 syllable). */
  engineTheta: 0.8,
  /** Events at most this many slots apart join one region (bridging one agreed text word). */
  bridge: 3,
  /** A pause longer than this (seconds) in which neither the text nor the most precise engine has a word splits a region. */
  splitPause: 1.2,
} as const;

/**
 * Needleman–Wunsch of text words T against engine words X, constrained in time. Returns each X word's slot (2i+1:
 * paired with text word i; 2g: inserted before text word g) and each text word's partner.
 */
function alignToEngine(T: readonly TextWord[], X: readonly TimedWord[], language: string): { slotOfX: Int32Array; pairOfT: Int32Array } {
  const n = T.length;
  const m = X.length;
  const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
  const xm = X.map(mid);
  const lowerBound = (v: number) => { let a = 0; let b = m; while (a < b) { const c = (a + b) >> 1; if (xm[c]! < v) a = c + 1; else b = c; } return a; };
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = mid(T[i]!);
    const w = T[i]!.untimed ? REGIONS.untimedWindow : REGIONS.window;
    lo[i] = lowerBound(t - w);
    hi[i] = lowerBound(t + w + 1e-9);
  }
  // The DP runs in a band around each text word's time window (plus SLACK): cells outside need long runs of gaps.
  // The band keeps an hour of speech at about a hundred cells per word.
  const SLACK = 30;
  const L = new Int32Array(n + 1);
  const H = new Int32Array(n + 1);
  L[0] = 0;
  H[0] = m;
  for (let i = 1; i <= n; i++) {
    // rows overlap (L[i] ≤ H[i − 1], L[i − 1] ≤ H[i]) so (n, m) stays reachable when the text's times go backwards
    L[i] = Math.max(0, Math.min(lo[i - 1]! + 1 - SLACK, H[i - 1]!));
    H[i] = i === n ? m : Math.min(m, Math.max(hi[i - 1]! + SLACK, L[i]!, L[i - 1]!));
  }
  const offset = new Int32Array(n + 2);
  for (let i = 0; i <= n; i++) offset[i + 1] = offset[i]! + (H[i]! - L[i]! + 1);
  const D = new Float64Array(offset[n + 1]!).fill(Infinity);
  const B = new Uint8Array(offset[n + 1]!);
  const at = (i: number, j: number) => (j < L[i]! || j > H[i]! ? -1 : offset[i]! + j - L[i]!);
  const get = (i: number, j: number) => { const k = at(i, j); return k < 0 ? Infinity : D[k]!; };
  D[0] = 0;
  for (let j = 1; j <= m; j++) { D[j] = j * REGIONS.gap; B[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = L[i]!; j <= H[i]!; j++) {
      const k = at(i, j);
      let best = get(i - 1, j) + REGIONS.gap;
      let b = 1;
      if (j > L[i]!) {
        const left = D[k - 1]! + REGIONS.gap;
        if (left < best) { best = left; b = 2; }
      }
      if (j >= 1 && j - 1 >= lo[i - 1]! && j - 1 < hi[i - 1]!) {
        const pair = get(i - 1, j - 1) + (1.15 - wordSimilarity(T[i - 1]!.text, X[j - 1]!.text, language));
        if (pair < best) { best = pair; b = 3; }
      }
      D[k] = best;
      B[k] = b;
    }
  }
  const slotOfX = new Int32Array(m);
  const pairOfT = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = at(i, j);
    if (i > 0 && k < 0) throw new InternalError(`regions: the alignment left its band at (${i}, ${j})`);
    const b = i === 0 ? 2 : B[k];
    if (b === 3) { pairOfT[i - 1] = j - 1; slotOfX[j - 1] = 2 * (i - 1) + 1; i--; j--; }
    else if (b === 1) i--;
    else { slotOfX[j - 1] = 2 * i; j--; }
  }
  return { slotOfX, pairOfT };
}

const joinText = (ws: ReadonlyArray<{ text: string }>) => ws.map((w) => w.text).join(' ');

/**
 * The disagreement regions between the text and the engines. Events (an unsupported text word, or an engine word with
 * no text partner) within REGIONS.bridge slots join one region; a long pause on the text and the `precise` engine
 * splits it. Regions that match after normalization or differ only in fillers are dropped. `textIsEngine`: that
 * engine's words are the text, so it does not vote.
 */
export function findRegions(T: readonly TextWord[], engines: readonly EngineWords[], o: { language: string; precise?: number; textIsEngine?: number }): Region[] {
  const lang = o.language;
  const n = T.length;
  const voting = engines.map((_, k) => k !== o.textIsEngine);
  const words = engines.map((e) => e.words.filter((w) => !isFillerWord(w.text, lang)).slice().sort((a, b) => a.start - b.start));
  const aligned = words.map((X) => alignToEngine(T, X, lang));
  const supported = T.map((t, i) => aligned.some((al, k) => voting[k] && al.pairOfT[i]! >= 0 && agree(t.text, words[k]![al.pairOfT[i]!]!.text, lang)));
  const event = new Uint8Array(2 * n + 1);
  for (let i = 0; i < n; i++) if (!isFillerWord(T[i]!.text, lang) && !supported[i]) event[2 * i + 1] = 1;
  aligned.forEach((al, k) => { if (voting[k]) al.slotOfX.forEach((s) => { if (s % 2 === 0) event[s] = 1; }); });

  const precise = o.precise !== undefined && voting[o.precise] ? o.precise : voting.findIndex((v) => v);
  const out: Region[] = [];
  const nextEvent = (k: number) => { for (let q = k; q <= 2 * n; q++) if (event[q]) return q; return Infinity; };
  let s = 0;
  while (s <= 2 * n) {
    if (!event[s]) { s++; continue; }
    let e = s;
    for (;;) {
      if (e + 1 <= 2 * n && event[e + 1]) { e++; continue; }
      const q = nextEvent(e + 1);
      if (q !== Infinity && q - e <= REGIONS.bridge) { e = q; continue; }
      break;
    }
    const tIdx: number[] = [];
    for (let k = s; k <= e; k++) if (k % 2 === 1) tIdx.push((k - 1) / 2);
    const inRegion = (slot: number) => slot >= s && slot <= e;
    const heard = words.map((X, k) => X.filter((_, x) => inRegion(aligned[k]!.slotOfX[x]!)));
    const a0 = tIdx.length > 0 ? tIdx[0]! : Math.ceil(s / 2);
    // split by time on the text and the most precise engine; the other engines' words join the nearest part
    type Item = { w: { start: number; end: number }; kind: number; i?: number; word?: TimedWord };
    const items: Item[] = [
      ...tIdx.map((i) => ({ w: T[i]!, kind: -1, i })),
      ...(precise >= 0 ? heard[precise]!.map((w) => ({ w, kind: precise, word: w })) : []),
    ].sort((x, y) => x.w.start - y.w.start || x.kind - y.kind);
    const parts: Item[][] = [];
    let cur: Item[] = [];
    let maxEnd = -Infinity;
    for (const it of items) {
      if (cur.length > 0 && it.w.start - maxEnd > REGIONS.splitPause) { parts.push(cur); cur = []; maxEnd = -Infinity; }
      cur.push(it);
      maxEnd = Math.max(maxEnd, it.w.end);
    }
    if (cur.length > 0) parts.push(cur);
    if (parts.length === 0) parts.push([]);
    mergeOverlappingParts(parts);
    heard.forEach((ws, k) => {
      if (k === precise) return;
      for (const w of ws) {
        let best = 0;
        let bestDist = Infinity;
        parts.forEach((p, pi) => {
          if (p.length === 0) return;
          const plo = Math.min(...p.map((x) => x.w.start));
          const phi = Math.max(...p.map((x) => x.w.end));
          const d = w.end < plo ? plo - w.end : w.start > phi ? w.start - phi : 0;
          if (d < bestDist) { bestDist = d; best = pi; }
        });
        parts[best]!.push({ w, kind: k, word: w });
      }
    });
    const ranges = parts.map(textRange).filter((r): r is [number, number] => r !== undefined);
    let tBefore = 0;
    for (const part of parts) {
      const ti = part.filter((x) => x.kind === -1).map((x) => x.i!).sort((x, y) => x - y);
      let first = ti.length > 0 ? ti[0]! : a0 + tBefore;
      // a place between words never lands inside another part's text words (possible when times go backwards)
      if (ti.length === 0) { const inside = ranges.find(([lo, hi]) => lo < first && first <= hi); if (inside) first = inside[1] + 1; }
      const last = ti.length > 0 ? ti[ti.length - 1]! : first - 1;
      tBefore += ti.length;
      const partHeard = engines.map((_, k) => part.filter((x) => x.kind === k).map((x) => x.word!).sort((x, y) => x.start - y.start));
      // the same words with one neighbor on each side ("$12 [] a" ↔ "12 [dollars] a"): a split or merge, not a disagreement
      if (sameWithNeighbors(T, words, aligned, partHeard, first, last, voting, lang)) continue;
      const r = classify(T, { first, last, heard: partHeard }, { lang, voting });
      if (r) out.push({ ...r, id: out.length, around: aroundOf(T, words, partHeard, engines, first, last, r.start, r.end) });
    }
    s = e + 1;
  }
  return out;
}

/** The [first, last] text word indices of a part, or undefined when it has none. */
function textRange(part: ReadonlyArray<{ kind: number; i?: number }>): [number, number] | undefined {
  const ti = part.filter((x) => x.kind === -1).map((x) => x.i!);
  return ti.length > 0 ? [Math.min(...ti), Math.max(...ti)] : undefined;
}

/**
 * Merges, in place, region parts whose text ranges overlap. Parts are split by time, so an untimed word's estimate can
 * make one part's range reach into another's, and the vote would replace the words between twice. Afterwards the
 * ranges are disjoint.
 */
function mergeOverlappingParts<P extends { kind: number; i?: number }>(parts: P[][]): void {
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < parts.length && !merged; a++) {
      const ra = textRange(parts[a]!);
      if (!ra) continue;
      for (let b = a + 1; b < parts.length; b++) {
        const rb = textRange(parts[b]!);
        if (!rb || rb[1] < ra[0] || rb[0] > ra[1]) continue;
        parts[a]!.push(...parts[b]!);
        parts.splice(b, 1);
        merged = true;
        break;
      }
    }
  }
}

/**
 * Do the text and a voting engine match once the region's neighbors are taken along? Catches one word written as two
 * ("$12" ↔ "12 dollars", "ad-lib" ↔ "ad lib") that the word alignment splits.
 */
function sameWithNeighbors(
  T: readonly TextWord[], words: readonly TimedWord[][], aligned: ReadonlyArray<{ pairOfT: Int32Array }>, heard: readonly TimedWord[][],
  first: number, last: number, voting: readonly boolean[], lang: string,
): boolean {
  const lo = Math.max(0, first - 1);
  const hi = Math.min(T.length - 1, last + 1);
  const key = (text: string) => phraseKey(text, lang).replace(/ /g, '');
  const textKey = key(joinText(T.slice(lo, hi + 1)));
  if (!textKey) return false;
  return words.some((X, k) => {
    if (!voting[k] || heard[k]!.length === 0) return false;
    const partner = (i: number) => (i >= 0 && i < T.length && aligned[k]!.pairOfT[i]! >= 0 ? [X[aligned[k]!.pairOfT[i]!]!] : []);
    const ext = [...(lo < first ? partner(lo) : []), ...heard[k]!, ...(hi > last ? partner(hi) : [])];
    return key(joinText(ext)) === textKey;
  });
}

function aroundOf(T: readonly TextWord[], words: readonly TimedWord[][], heard: readonly TimedWord[][], engines: readonly EngineWords[], first: number, last: number, start: number, end: number): Region['around'] {
  const ctx = (X: ReadonlyArray<{ text: string; start: number }>, xs: readonly unknown[]) => {
    let i0: number;
    let i1: number;
    if (xs.length > 0) { i0 = X.indexOf(xs[0] as never); i1 = X.indexOf(xs[xs.length - 1] as never); }
    else { i0 = X.findIndex((w) => w.start >= (start + end) / 2); if (i0 < 0) i0 = X.length; i1 = i0 - 1; }
    return { before: joinText(X.slice(Math.max(0, i0 - 4), i0)), after: joinText(X.slice(i1 + 1, i1 + 5)) };
  };
  const out: Region['around'] = { text: { before: joinText(T.slice(Math.max(0, first - 4), first)), after: joinText(T.slice(last + 1, last + 5)) } };
  engines.forEach((e, k) => { out[e.id] = ctx(words[k]!, heard[k]!); });
  return out;
}

function classify(
  T: readonly TextWord[], r: { first: number; last: number; heard: TimedWord[][] }, o: { lang: string; voting: readonly boolean[] },
): Omit<Region, 'id' | 'around'> | undefined {
  const lang = o.lang;
  const tw = T.slice(r.first, r.last + 1);
  const all = [...tw, ...r.heard.flat()];
  if (all.length === 0) return undefined;
  const start = Math.min(...all.map((w) => w.start));
  const end = Math.max(...all.map((w) => w.end));
  const text = joinText(tw);
  const voteText = joinText(tw.filter((w) => !isFillerWord(w.text, lang)));
  const said = r.heard.map((ws, k) => (o.voting[k] ? joinText(ws) : ''));
  const base = { first: r.first, last: r.last, start, end, text, heard: r.heard };
  const has = (x: string) => phraseKey(x, lang).length > 0;
  const despaced = (x: string) => phraseKey(x, lang).replace(/ /g, '');
  if (has(voteText) && said.some((x) => has(x) && despaced(x) === despaced(voteText))) return undefined; // the same after normalization
  const present = said.filter(has);
  if (!has(voteText) && present.length === 0) return undefined; // fillers only
  if (!has(voteText) && present.length >= 2) {
    const alike = soundsAlike(present[0]!, present[1]!, lang, REGIONS.engineTheta).ok;
    return { ...base, cls: alike ? 'a' : 'c', sub: alike ? 'insert' : 'insert-engines-differ' };
  }
  if (!has(voteText)) return { ...base, cls: 'c', sub: 'insert-one-engine' };
  if (present.length >= 2) {
    const alike = soundsAlike(present[0]!, present[1]!, lang, REGIONS.engineTheta).ok;
    return { ...base, cls: alike ? 'b' : 'c', sub: alike ? 'replace' : 'all-differ' };
  }
  if (present.length === 1) return { ...base, cls: 'c', sub: o.voting.filter(Boolean).length > 1 ? 'one-engine-silent' : 'replace-one-engine' };
  return undefined; // no engine heard anything there: nothing to vote with
}
