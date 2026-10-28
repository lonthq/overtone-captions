import { InternalError } from '../errors.js';
import { flatSimilarity, levenshteinWithin, similarity } from '../text/similarity.js';
import { findAnchors } from './anchors.js';
import { SimCache, joinedKey, joinedLength, joinedMask, lengthBound, popcount, prepareKeys, type Keys, type Unit } from './keys.js';

export type { Unit } from './keys.js';

/**
 * An alignment operation over unit indices (inclusive ranges).
 * - `sub`: 1 text unit ↔ 1 timing unit (identical keys = match)
 * - `split`: 2–3 text units ↔ 1 timing unit ("car cover" ↔ "carcover")
 * - `merge`: 1 text unit ↔ 2–3 timing units ("CarCover" ↔ "car cover"); extendMerges may widen splits and merges
 * - `ins`: text unit without timing counterpart; `del`: timing unit without text counterpart
 */
export type OpKind = 'sub' | 'split' | 'merge' | 'ins' | 'del';
export interface Op { kind: OpKind; a: [number, number] | null; b: [number, number] | null; sim: number }

export const COST = {
  /** substitution cost = SUB × (1 − similarity); < INS + DEL so dissimilar pairs still pair up */
  SUB: 1.6,
  INS: 1,
  DEL: 1,
  /** deleting a filler word that only the timing side has */
  DEL_FILLER: 0.1,
  /** extra cost per additional unit in a split/merge */
  MERGE_PENALTY: 0.15,
  /** split/merge only considered at or above this similarity … */
  MERGE_MIN_SIM: 0.75,
  /** … and below this one only when the joined pieces match better than the best single piece ("car covers") */
  MERGE_SURE_SIM: 0.9,
} as const;

export interface AlignUnitsOptions {
  /**
   * Half-width of the DP band for very long anchor-free stretches (default 100 units). A band ≥ the longer side (e.g.
   * `Infinity`) runs the full-matrix DP without anchors: the exact reference.
   */
  band?: number;
  /** Segments up to this many cells get the full matrix without an anchor search (default 250 000). */
  directCells?: number;
  /** Anchor-free segments up to this many cells get the full matrix; larger ones the band (default 4 000 000). */
  fullCells?: number;
  /**
   * Silence (seconds) before each timing unit, plus one after the last. An unpaired text unit is a hair cheaper next to
   * a long silence, so ties (a repeated chorus the timing side missed) go where there is room. The bonus is at most
   * 1e-6 per inserted unit, far below any real cost difference.
   */
  silence?: readonly number[];
}

const DIRECT_CELLS = 250_000;
/** Insertion bonus per second of silence (counted from 0.4 s, up to 10 s). */
const SILENCE_TIE = 1e-7;
const SILENCE_MIN = 0.4;
const SILENCE_CAP = 10;
const FULL_CELLS = 4_000_000;
const OP_NONE = 0, OP_SUB = 1, OP_INS = 2, OP_DEL = 3, OP_SPLIT2 = 4, OP_SPLIT3 = 5, OP_MERGE2 = 6, OP_MERGE3 = 7;

interface RunResult { ops: Op[]; touchedEdge: boolean }
interface Ctx { A: Keys; B: Keys; sim: SimCache; /** INS cost before timing unit k (k = |B|: after the last) */ ins: Float64Array }

/**
 * Similarity of a joined key and a single key, or 0 when it is certainly below MERGE_MIN_SIM. Each edit changes at
 * most two characters of the character set, so the set difference (`maskDiff`) rules most pairs out for free.
 */
function mergeSimilarity(x: string, y: string, maskDiff: number): number {
  const max = x.length > y.length ? x.length : y.length;
  const limit = Math.floor((1 - COST.MERGE_MIN_SIM) * max + 1e-9);
  if (popcount(maskDiff) > 2 * limit) return 0;
  const d = levenshteinWithin(x, y, limit);
  return d < 0 ? 0 : 1 - d / max;
}

/** May k text units a0..a0+k-1 become one timing unit b with similarity s? (mirror: one text unit vs k timing units) */
function mergeAllowed(s: number, pieces: Keys, from: number, k: number, single: Keys, at: number): boolean {
  if (s < COST.MERGE_MIN_SIM) return false;
  if (s >= COST.MERGE_SURE_SIM) return true;
  for (let u = from; u < from + k; u++) if (flatSimilarity(pieces.flat[u], single.flat[at]) >= s) return false;
  return true;
}

/**
 * Needleman–Wunsch with 1:n / n:1 merges over A[a0, a1) × B[b0, b1), restricted to the cells whose diagonal offset
 * (j − i) lies within `w` of the offsets a single one-sided gap would need (0 … m − n). `w = Infinity` = full matrix.
 */
function run({ A, B, sim, ins }: Ctx, a0: number, a1: number, b0: number, b1: number, w: number): RunResult {
  const n = a1 - a0;
  const m = b1 - b0;
  const dLo = Math.min(0, m - n) - w;
  const dHi = Math.max(0, m - n) + w;
  const lo = new Int32Array(n + 1);
  const hi = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    lo[i] = Math.max(0, Math.min(m, i + dLo));
    hi[i] = Math.min(m, Math.max(0, i + dHi));
  }
  const cost: Float64Array[] = [];
  const back: Uint8Array[] = [];
  const get = (i: number, j: number): number => (i < 0 || j < lo[i] || j > hi[i] ? Infinity : cost[i][j - lo[i]]);

  for (let i = 0; i <= n; i++) {
    const rlo = lo[i];
    const row = new Float64Array(hi[i] - rlo + 1);
    const brow = new Uint8Array(hi[i] - rlo + 1);
    cost.push(row);
    back.push(brow);
    const up = i > 0 ? cost[i - 1] : row;
    const upLo = i > 0 ? lo[i - 1] : 0;
    const upHi = i > 0 ? hi[i - 1] : -1;
    const ai = a0 + i - 1; // absolute index of text unit i (1-based row)
    for (let j = rlo; j <= hi[i]; j++) {
      if (i === 0 && j === 0) { row[0] = 0; brow[0] = OP_NONE; continue; }
      const bj = b0 + j - 1;
      let best = Infinity;
      let op = OP_NONE;
      if (i > 0 && j > 0 && j - 1 >= upLo && j - 1 <= upHi) {
        const c = up[j - 1 - upLo] + COST.SUB * (1 - sim.get(ai, bj));
        if (c < best) { best = c; op = OP_SUB; }
      }
      if (i > 0 && j >= upLo && j <= upHi) {
        const c = up[j - upLo] + ins[b0 + j];
        if (c < best) { best = c; op = OP_INS; }
      }
      if (j > rlo) {
        const c = row[j - 1 - rlo] + (B.units[bj].filler ? COST.DEL_FILLER : COST.DEL);
        if (c < best) { best = c; op = OP_DEL; }
      }
      for (let k = 2; k <= 3; k++) {
        // k text units ↔ 1 timing unit; the length bound of the similarity prunes most candidates cheaply
        if (i >= k && j >= 1) {
          const lb = lengthBound(joinedLength(A, ai - k + 1, ai), B.flat[bj].length);
          const base = lb >= COST.MERGE_MIN_SIM ? get(i - k, j - 1) + COST.MERGE_PENALTY * (k - 1) : Infinity;
          if (base + COST.SUB * (1 - lb) < best) {
            const s = mergeSimilarity(joinedKey(A, ai - k + 1, ai), B.flat[bj], joinedMask(A, ai - k + 1, ai) ^ B.masks[bj]);
            if (mergeAllowed(s, A, ai - k + 1, k, B, bj)) {
              const c = base + COST.SUB * (1 - s);
              if (c < best) { best = c; op = k === 2 ? OP_SPLIT2 : OP_SPLIT3; }
            }
          }
        }
        // 1 text unit ↔ k timing units
        if (j >= k && i >= 1) {
          const lb = lengthBound(A.flat[ai].length, joinedLength(B, bj - k + 1, bj));
          const base = lb >= COST.MERGE_MIN_SIM ? get(i - 1, j - k) + COST.MERGE_PENALTY * (k - 1) : Infinity;
          if (base + COST.SUB * (1 - lb) < best) {
            const s = mergeSimilarity(A.flat[ai], joinedKey(B, bj - k + 1, bj), A.masks[ai] ^ joinedMask(B, bj - k + 1, bj));
            if (mergeAllowed(s, B, bj - k + 1, k, A, ai)) {
              const c = base + COST.SUB * (1 - s);
              if (c < best) { best = c; op = k === 2 ? OP_MERGE2 : OP_MERGE3; }
            }
          }
        }
      }
      row[j - lo[i]] = best;
      brow[j - lo[i]] = op;
    }
  }

  const ops: Op[] = [];
  let touchedEdge = false;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if ((j === lo[i] && lo[i] > 0) || (j === hi[i] && hi[i] < m)) touchedEdge = true;
    const op = back[i][j - lo[i]];
    const ai = a0 + i - 1;
    const bj = b0 + j - 1;
    switch (op) {
      case OP_SUB:
        ops.push({ kind: 'sub', a: [ai, ai], b: [bj, bj], sim: sim.get(ai, bj) });
        i--; j--; break;
      case OP_INS:
        ops.push({ kind: 'ins', a: [ai, ai], b: null, sim: 0 });
        i--; break;
      case OP_DEL:
        ops.push({ kind: 'del', a: null, b: [bj, bj], sim: 0 });
        j--; break;
      case OP_SPLIT2: case OP_SPLIT3: {
        const k = op === OP_SPLIT2 ? 2 : 3;
        ops.push({ kind: 'split', a: [ai - k + 1, ai], b: [bj, bj], sim: flatSimilarity(joinedKey(A, ai - k + 1, ai), B.flat[bj]) });
        i -= k; j--; break;
      }
      case OP_MERGE2: case OP_MERGE3: {
        const k = op === OP_MERGE2 ? 2 : 3;
        ops.push({ kind: 'merge', a: [ai, ai], b: [bj - k + 1, bj], sim: flatSimilarity(A.flat[ai], joinedKey(B, bj - k + 1, bj)) });
        i--; j -= k; break;
      }
      default:
        throw new InternalError(`alignment traceback failed at (${i}, ${j})`);
    }
  }
  ops.reverse();
  return { ops, touchedEdge };
}

/** Banded DP whose band doubles while the best path touches its edge (anchor-free stretches only). */
function banded(ctx: Ctx, a0: number, a1: number, b0: number, b1: number, band: number): Op[] {
  const full = Math.max(a1 - a0, b1 - b0);
  let w = band;
  for (;;) {
    const { ops, touchedEdge } = run(ctx, a0, a1, b0, b1, w);
    if (!touchedEdge || w >= full) return ops;
    w *= 2;
  }
}

/**
 * Global alignment (Needleman–Wunsch with 1:n / n:1 merges) of text units A against timing units B.
 *
 * Long inputs are split at anchors (anchors.ts) and each segment between anchors is aligned on its own, recursively:
 * small segments with the full matrix, very large anchor-free ones (long garbled stretches) in a band around their
 * diagonal. A large one-sided gap (a missed or extra block) lands in one thin segment, and the work stays near-linear.
 */
export function alignUnits(A: readonly Unit[], B: readonly Unit[], opts: AlignUnitsOptions = {}): Op[] {
  const dict = new Map<string, number>();
  const KA = prepareKeys(A, dict);
  const KB = prepareKeys(B, dict);
  const ins = new Float64Array(B.length + 1).fill(COST.INS);
  opts.silence?.forEach((d, k) => {
    if (k <= B.length && d >= SILENCE_MIN) ins[k] -= SILENCE_TIE * Math.min(d, SILENCE_CAP);
  });
  const ctx: Ctx = { A: KA, B: KB, sim: new SimCache(KA, KB, dict.size), ins };
  const band = Math.max(1, opts.band ?? 100);
  if (band >= Math.max(A.length, B.length)) return run(ctx, 0, A.length, 0, B.length, Infinity).ops;
  const direct = opts.directCells ?? DIRECT_CELLS;
  const fullCells = opts.fullCells ?? FULL_CELLS;
  const out: Op[] = [];
  const append = (ops: readonly Op[]): void => { for (const op of ops) out.push(op); };

  const solve = (a0: number, a1: number, b0: number, b1: number): void => {
    const n = a1 - a0;
    const m = b1 - b0;
    if (n === 0 || m === 0 || n * m <= direct) { append(run(ctx, a0, a1, b0, b1, Infinity).ops); return; }
    let anchors = findAnchors(KA, KB, a0, a1, b0, b1, 3);
    if (anchors.length === 0) anchors = findAnchors(KA, KB, a0, a1, b0, b1, 1);
    if (anchors.length === 0) {
      append(n * m <= fullCells ? run(ctx, a0, a1, b0, b1, Infinity).ops : banded(ctx, a0, a1, b0, b1, band));
      return;
    }
    let pa = a0;
    let pb = b0;
    for (const [i, j] of anchors) {
      solve(pa, i, pb, j);
      out.push({ kind: 'sub', a: [i, i], b: [j, j], sim: 1 });
      pa = i + 1;
      pb = j + 1;
    }
    solve(pa, a1, pb, b1);
  };
  solve(0, A.length, 0, B.length);
  return out;
}

/** Total cost of an alignment under COST (the quantity the DP minimizes). */
export function opsCost(ops: readonly Op[], B: readonly Unit[]): number {
  let total = 0;
  for (const op of ops) {
    if (op.kind === 'ins') total += COST.INS;
    else if (op.kind === 'del') total += B[op.b![0]].filler ? COST.DEL_FILLER : COST.DEL;
    else {
      const extra = op.kind === 'split' ? op.a![1] - op.a![0] : op.kind === 'merge' ? op.b![1] - op.b![0] : 0;
      total += COST.SUB * (1 - op.sim) + COST.MERGE_PENALTY * extra;
    }
  }
  return total;
}

/**
 * Let a merge (or split) absorb neighboring timing-only (text-only) units while that raises its similarity, so names
 * of more than three pieces come out whole: "SafeDriveNowPlus" ↔ "safe drive now" + "plus".
 */
export function extendMerges(ops: readonly Op[], A: readonly Unit[], B: readonly Unit[]): Op[] {
  const out = [...ops];
  const join = (U: readonly Unit[], [f, t]: [number, number]): string => U.slice(f, t + 1).map((u) => u.key).join('');
  const simOf = (a: [number, number], b: [number, number]): number => similarity(join(A, a), join(B, b));
  for (let k = 0; k < out.length; k++) {
    const op = out[k];
    if ((op.kind !== 'merge' && op.kind !== 'split') || op.sim === 1) continue;
    const side = op.kind === 'merge' ? 'b' : 'a';
    const loose = op.kind === 'merge' ? 'del' : 'ins';
    let cur = op;
    for (const dir of [1, -1] as const) {
      for (;;) {
        const at = dir === 1 ? k + 1 : k - 1;
        const nb = out[at];
        if (!nb || nb.kind !== loose) break;
        const r = cur[side]!;
        const range: [number, number] = dir === 1 ? [r[0], nb[side]![1]] : [nb[side]![0], r[1]];
        const sim = side === 'b' ? simOf(cur.a!, range) : simOf(range, cur.b!);
        if (sim <= cur.sim) break;
        cur = { ...cur, [side]: range, sim };
        out.splice(at, 1);
        if (dir === -1) k--;
      }
    }
    out[k] = cur;
  }
  return out;
}
