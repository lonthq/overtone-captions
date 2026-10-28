import { flatSimilarity } from '../text/similarity.js';

/** One alignable unit: a word (plus any continuation words) with a non-empty comparison key. */
export interface Unit { key: string; filler: boolean }

/**
 * Units prepared for fast comparison: space-free keys plus prefix sums of their lengths, so joined keys of
 * neighboring units can be bounded by length without building strings.
 */
export interface Keys {
  readonly units: readonly Unit[];
  readonly flat: readonly string[];
  /** pre[k] = total length of flat[0..k) */
  readonly pre: Int32Array;
  /** Id of flat[k] in the dictionary shared by both sides (same id = same key). */
  readonly ids: Int32Array;
  /** Bit set of the characters of flat[k] (hashed into 32 bits): a cheap filter before edit distances. */
  readonly masks: Int32Array;
}

/** Prepare units; pass the same `dict` for both sides so equal keys get equal ids. */
export function prepareKeys(units: readonly Unit[], dict: Map<string, number> = new Map()): Keys {
  const flat = units.map((u) => u.key.replace(/ /g, ''));
  const pre = new Int32Array(units.length + 1);
  const ids = new Int32Array(units.length);
  const masks = new Int32Array(units.length);
  for (let k = 0; k < flat.length; k++) {
    pre[k + 1] = pre[k] + flat[k].length;
    for (let c = 0; c < flat[k].length; c++) masks[k] |= 1 << (flat[k].charCodeAt(c) & 31);
    let id = dict.get(flat[k]);
    if (id === undefined) { id = dict.size; dict.set(flat[k], id); }
    ids[k] = id;
  }
  return { units, flat, pre, ids, masks };
}

/** Memoized similarity of single units by key id (keys repeat a lot in speech). */
export class SimCache {
  private readonly memo = new Map<number, number>();
  /** `size`: number of distinct keys in the shared dictionary. */
  constructor(private readonly A: Keys, private readonly B: Keys, private readonly size: number) {}
  get(a: number, b: number): number {
    const x = this.A.ids[a];
    const y = this.B.ids[b];
    if (x === y) return 1;
    const id = x * this.size + y;
    let s = this.memo.get(id);
    if (s === undefined) {
      s = flatSimilarity(this.A.flat[a], this.B.flat[b]);
      this.memo.set(id, s);
    }
    return s;
  }
}

/** Length of the joined keys of units from..to (inclusive). */
export function joinedLength(K: Keys, from: number, to: number): number {
  return K.pre[to + 1] - K.pre[from];
}

/** Joined space-free keys of units from..to (inclusive). */
export function joinedKey(K: Keys, from: number, to: number): string {
  let s = '';
  for (let k = from; k <= to; k++) s += K.flat[k];
  return s;
}

/** Character bit set of the joined keys of units from..to (inclusive). */
export function joinedMask(K: Keys, from: number, to: number): number {
  let m = 0;
  for (let k = from; k <= to; k++) m |= K.masks[k];
  return m;
}

/** Number of set bits. */
export function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Upper bound of the similarity of two strings from their lengths alone. */
export function lengthBound(lx: number, ly: number): number {
  const max = lx > ly ? lx : ly;
  return max === 0 ? 1 : 1 - Math.abs(lx - ly) / max;
}
