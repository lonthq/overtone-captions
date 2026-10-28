import type { Keys } from './keys.js';

/** Length of the n-grams that must be unique on both sides. */
const GRAM = 3;
/** An exact run must be at least this long; its first and last units are left to the DP. */
const MIN_RUN = 4;
/** A run without a neighbor run on a similar diagonal is dropped unless it has at least this many anchored units. */
const LONE_RUN = 8;

/**
 * Confident pairs between units of A[a0, a1) and B[b0, b1).
 *
 * Seeds are key n-grams unique in both ranges, extended to the longest run of equal keys on their diagonal. Runs
 * shorter than `MIN_RUN` are chance matches. Every unit of a run except its ends becomes a pair; the ends stay free
 * so the DP can shift them (stutters, fillers, merges). The pairs are cut to the longest chain increasing on both
 * sides (patience LIS). Runs no neighbor run confirms are dropped: a chance match in a one-sided gap or a repetitive
 * stretch would pin a whole region to the wrong place. Dropping an anchor only makes a segment larger; the DP still
 * decides.
 */
export function findAnchors(A: Keys, B: Keys, a0: number, a1: number, b0: number, b1: number, n = GRAM): Array<[number, number]> {
  if (a1 - a0 < n || b1 - b0 < n) return [];
  const inA = uniqueGrams(A, a0, a1, n);
  const inB = uniqueGrams(B, b0, b1, n);
  const same = (i: number, j: number): boolean => A.units[i].key === B.units[j].key;
  const pairs: Array<[number, number]> = [];
  const seen = new Set<number>();
  const width = B.flat.length + 1;
  for (const [gram, p] of inA) {
    const q = inB.get(gram);
    if (p < 0 || q === undefined || q < 0) continue;
    let s = 0;
    while (p - s - 1 >= a0 && q - s - 1 >= b0 && same(p - s - 1, q - s - 1)) s++;
    let e = n;
    while (p + e < a1 && q + e < b1 && same(p + e, q + e)) e++;
    if (s + e < MIN_RUN) continue;
    for (let k = -s + 1; k < e - 1; k++) {
      const id = (p + k) * width + (q + k);
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push([p + k, q + k]);
    }
  }
  return confirmed(increasingChain(pairs));
}

/** Keep the chain's runs (consecutive diagonal pairs) that are long or confirmed by a neighbor run. */
function confirmed(chain: Array<[number, number]>): Array<[number, number]> {
  const runs: Array<Array<[number, number]>> = [];
  for (const p of chain) {
    const last = runs[runs.length - 1];
    const q = last?.[last.length - 1];
    if (q && p[0] === q[0] + 1 && p[1] === q[1] + 1) last.push(p);
    else runs.push([p]);
  }
  const offset = (r: Array<[number, number]>): number => r[0][1] - r[0][0];
  const near = (x: Array<[number, number]>, y: Array<[number, number]>): boolean => {
    // the diagonal may drift by a few units plus a fifth of the shorter distance between the runs
    const di = Math.abs(y[0][0] - x[0][0]);
    const dj = Math.abs(y[0][1] - x[0][1]);
    return Math.abs(offset(x) - offset(y)) <= 3 + 0.2 * Math.min(di, dj);
  };
  return runs
    .filter((r, t) => r.length >= LONE_RUN || (t > 0 && near(runs[t - 1], r)) || (t + 1 < runs.length && near(r, runs[t + 1])))
    .flat();
}

/** n-gram of keys starting at unit p → p, or -1 when it occurs more than once in [from, to). */
function uniqueGrams(K: Keys, from: number, to: number, n: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let p = from; p + n <= to; p++) {
    let gram = K.units[p].key;
    for (let k = 1; k < n; k++) gram += `\u0001${K.units[p + k].key}`;
    out.set(gram, out.has(gram) ? -1 : p);
  }
  return out;
}

/** Longest subsequence of pairs strictly increasing in both i and j. */
function increasingChain(pairs: Array<[number, number]>): Array<[number, number]> {
  if (pairs.length === 0) return [];
  pairs.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const tails: number[] = []; // tails[len - 1] = pair index ending the best chain of that length (smallest j)
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const chain: Array<[number, number]> = [];
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) chain.push(pairs[k]);
  return chain.reverse();
}
