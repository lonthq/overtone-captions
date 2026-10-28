import type { ProfileRules, WordRange } from 'overtone-format';
import type { Lang } from '../lang/index.js';
import { displayLength } from '../text/length.js';
import { breakCost, clauseEndAt } from './groups.js';
import { hesitationWeight } from './pauses.js';
import { LATEST_RULESET, type RuleSet } from './rulesets/index.js';

/** A cue before timing: its lines as inclusive global word ranges. */
export interface CueLayout { lines: WordRange[] }

export interface SplitContext {
  texts: readonly string[];
  starts: readonly number[];
  ends: readonly number[];
  keep: readonly boolean[];
  /** tails[i]: word i ends a number group (see numberGroupEnds); optional. */
  tails?: readonly boolean[];
  lang: Lang;
  rules: ProfileRules;
  /** The rule set (all layout parameters); default: the latest. */
  ruleset?: RuleSet;
  /**
   * untimed[i]: word i has an unknown time (align/fill.ts). The silence next to it is an artifact of placement, so
   * the pause rules read it as no pause.
   */
  untimed?: readonly boolean[];
}

/** The rule set of a context. */
export function rulesetOf(ctx: Pick<SplitContext, 'ruleset'>): RuleSet {
  return ctx.ruleset ?? LATEST_RULESET;
}

/** Characters of words a..b joined by single spaces (as a reader counts them: see displayLength). */
export function lineLength(texts: readonly string[], a: number, b: number): number {
  let n = b - a;
  for (let k = a; k <= b; k++) n += displayLength(texts[k]);
  return n;
}

/** Prefix sums of (word length + 1), cached per texts array, so any line length is O(1). */
const PREFIX = new WeakMap<readonly string[], Int32Array>();
function prefixOf(texts: readonly string[]): Int32Array {
  let p = PREFIX.get(texts);
  if (!p) {
    p = new Int32Array(texts.length + 1);
    for (let k = 0; k < texts.length; k++) p[k + 1] = p[k] + displayLength(texts[k]) + 1;
    PREFIX.set(texts, p);
  }
  return p;
}

/** The silence after word i before the next (Infinity after the last); 0 next to an untimed word. */
export function pauseAfter(ctx: Pick<SplitContext, 'starts' | 'ends' | 'untimed'>, i: number): number {
  if (i + 1 >= ctx.starts.length) return Infinity;
  if (ctx.untimed?.[i] || ctx.untimed?.[i + 1]) return 0;
  return ctx.starts[i + 1] - ctx.ends[i];
}

/** Seconds cue a..b may be on screen: up to the next word, at most layout.maxExtension past its last word (see timeCues). */
function shownFor(ctx: SplitContext, a: number, b: number): number {
  return Math.min(ctx.ends[b] + rulesetOf(ctx).layout.maxExtension, b + 1 < ctx.starts.length ? ctx.starts[b + 1] : Infinity) - ctx.starts[a];
}

/**
 * Where a cue must end in block [from, to], indexed from `from`: after a pause of pauses.cue, except inside a `keep`
 * group. While a piece between two such pauses (or a pause and the block edge) would be shown under
 * pauses.minShown, the shorter pause next to it is dropped (pauses.force pauses always stay).
 */
export function pauseCueBreaks(ctx: SplitContext, from: number, to: number): Uint8Array {
  const { force, cue, minShown } = rulesetOf(ctx).pauses;
  let breaks: number[] = [];
  for (let i = from; i < to; i++) {
    const gap = pauseAfter(ctx, i);
    if (gap >= force || (gap >= cue && !ctx.keep[i])) breaks.push(i);
  }
  const soft = (i: number) => pauseAfter(ctx, i) < force;
  for (let changed = true; changed;) {
    changed = false;
    const edges = [from - 1, ...breaks, to];
    for (let k = 0; k + 1 < edges.length; k++) {
      if (shownFor(ctx, edges[k] + 1, edges[k + 1]) >= minShown) continue;
      const left = k > 0 && soft(edges[k]) ? edges[k] : undefined;
      const right = k + 2 < edges.length && soft(edges[k + 1]) ? edges[k + 1] : undefined;
      if (left === undefined && right === undefined) continue;
      const drop = left === undefined ? right : right === undefined ? left : pauseAfter(ctx, left) <= pauseAfter(ctx, right) ? left : right;
      breaks = breaks.filter((i) => i !== drop);
      changed = true;
      break;
    }
  }
  const out = new Uint8Array(to - from + 1);
  for (const i of breaks) out[i - from] = 1;
  return out;
}

/**
 * Cost of words x..y (`size` characters) as line l (1-based) of `count` lines of `ideal` characters: distance from
 * the ideal (a longer top line costs a little more), a lone word, and the break after it. A line break at a
 * hesitation shows it: by its weight, text penalties are waived, it earns the line-pause bonus, and a lone word next
 * to it costs less.
 */
function lineCost(ctx: SplitContext, x: number, y: number, l: number, count: number, ideal: number, size: number): number {
  const rs = rulesetOf(ctx);
  const L = rs.layout;
  let c = L.balance * Math.abs(size - ideal);
  if (count === 2 && l === 1 && size > ideal) c += L.topLonger * (size - ideal);
  const pausedAfter = l < count ? hesitationWeight(rs.pauses, pauseAfter(ctx, y)) : 0;
  const pausedBefore = l > 1 ? hesitationWeight(rs.pauses, pauseAfter(ctx, x - 1)) : 0;
  if (x === y && !(l === 1 && clauseEndAt(ctx.texts, x))) c += L.oneWordLine * (1 - Math.max(pausedAfter, pausedBefore));
  if (l < count) {
    c += breakCost(ctx, y, { lineStart: x, hesitation: pausedAfter }) + L.linePenalty;
    c -= L.linePauseBonus * pausedAfter;
  }
  return c;
}

/** The cost layoutLines gives `lines` (consecutive ranges of one cue); 0 for a single line. */
export function linesCost(ctx: SplitContext, lines: readonly WordRange[]): number {
  if (lines.length === 1) return 0;
  const pre = prefixOf(ctx.texts);
  const len = (x: number, y: number) => pre[y + 1] - pre[x] - 1;
  const ideal = (len(lines[0][0], lines[lines.length - 1][1]) - (lines.length - 1)) / lines.length;
  return lines.reduce((sum, [x, y], k) => sum + lineCost(ctx, x, y, k + 1, lines.length, ideal, len(x, y)), 0);
}

/**
 * Best way to put words a..b on at most maxLines lines of at most maxCharsPerLine (an over-long single word may
 * have its own line), by lineCost. Null if impossible. Words that fit on one line stay there, unless a line break at
 * a hesitation costs less than nothing.
 */
export function layoutLines(ctx: SplitContext, a: number, b: number): { lines: WordRange[]; cost: number } | null {
  const { maxCharsPerLine: max, maxLines } = ctx.rules;
  const pre = prefixOf(ctx.texts);
  const len = (x: number, y: number) => pre[y + 1] - pre[x] - 1;
  const fits = (x: number, y: number) => x === y || len(x, y) <= max;
  const oneLine = fits(a, b);
  if (oneLine) {
    let hesitation = false;
    const { floor } = rulesetOf(ctx).pauses;
    for (let k = a; k < b && !hesitation && maxLines > 1; k++) hesitation = pauseAfter(ctx, k) >= floor;
    if (!hesitation) return { lines: [[a, b]], cost: 0 };
  }
  const n = b - a + 1;
  const total = len(a, b);
  let bestCost = Infinity;
  let bestLines: WordRange[] | null = null;
  for (let count = 2; count <= maxLines; count++) {
    const ideal = (total - (count - 1)) / count;
    // best[l][j]: cheapest way to put words a..a+j-1 on l lines
    const best: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const prev: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
    best[0][0] = 0;
    for (let l = 1; l <= count; l++) {
      for (let j = 1; j <= n; j++) {
        if (l === count && j !== n) continue;
        for (let i = j - 1; i >= 0; i--) {
          if (!fits(a + i, a + j - 1)) break;
          if (best[l - 1][i] === Infinity) continue;
          const c = best[l - 1][i] + lineCost(ctx, a + i, a + j - 1, l, count, ideal, len(a + i, a + j - 1));
          if (c < best[l][j]) { best[l][j] = c; prev[l][j] = i; }
        }
      }
    }
    if (best[count][n] < bestCost) {
      bestCost = best[count][n];
      const lines: WordRange[] = [];
      for (let j = n, l = count; l > 0; l--) { const i = prev[l][j]; lines.unshift([a + i, a + j - 1]); j = i; }
      bestLines = lines;
    }
  }
  if (oneLine && !(bestCost < 0)) return { lines: [[a, b]], cost: 0 };
  return bestLines ? { lines: bestLines, cost: bestCost } : null;
}

/**
 * 1 or 2 when cue a..b holds one or two short words (at most layout.orphanMaxChars) that could have joined a
 * neighbor in block [blockStart, blockEnd]: no pause (pauses.force, or one of `breaks`) isolates them on both
 * sides. Otherwise 0.
 */
export function shortCue(
  ctx: SplitContext,
  a: number,
  b: number,
  blockStart: number,
  blockEnd: number,
  breaks: Uint8Array = pauseCueBreaks(ctx, blockStart, blockEnd),
): 0 | 1 | 2 {
  const rs = rulesetOf(ctx);
  if (b - a > 1 || blockEnd - blockStart <= b - a || lineLength(ctx.texts, a, b) > rs.layout.orphanMaxChars) return 0;
  const before = a > blockStart ? pauseAfter(ctx, a - 1) : Infinity;
  const after = b < blockEnd ? pauseAfter(ctx, b) : Infinity;
  if (Math.min(before, after) >= rs.pauses.force) return 0;
  if ((a === blockStart || breaks[a - 1 - blockStart]) && (b === blockEnd || breaks[b - blockStart])) return 0;
  return a === b ? 1 : 2;
}

/**
 * True when cue a..b holds two short words (each at most layout.orphanMaxChars, together longer: "Most subtitle")
 * in a longer block, with no pause of pauses.pairExempt on either side: a fragment that could have joined a
 * neighbor. Next to a pause, the short cue shows it.
 */
export function unpausedPair(ctx: SplitContext, a: number, b: number, blockStart: number, blockEnd: number): boolean {
  if (b - a !== 1 || blockEnd - blockStart <= 1) return false;
  const rs = rulesetOf(ctx);
  const max = rs.layout.orphanMaxChars;
  if (Math.max(displayLength(ctx.texts[a]), displayLength(ctx.texts[b])) > max || lineLength(ctx.texts, a, b) <= max) return false;
  const before = a > 0 ? pauseAfter(ctx, a - 1) : 0;
  const after = b + 1 < ctx.starts.length ? pauseAfter(ctx, b) : 0;
  return Math.max(before, after) < rs.pauses.pairExempt;
}

/**
 * Cost of one cue a..b inside block [blockStart, blockEnd] (both inclusive), or null if it breaks a hard rule or
 * spans one of `breaks` (the block's pauseCueBreaks).
 */
function cueCost(ctx: SplitContext, a: number, b: number, blockStart: number, blockEnd: number, breaks: Uint8Array): { cost: number; lines: WordRange[] } | null {
  const layout = layoutLines(ctx, a, b);
  if (!layout) return null;
  for (let k = a; k < b; k++) if (breaks[k - blockStart]) return null;
  const r = ctx.rules;
  const rs = rulesetOf(ctx);
  const L = rs.layout;
  const duration = ctx.ends[b] - ctx.starts[a];
  if (r.maxDuration !== undefined && duration > r.maxDuration && b > a) return null;
  let cost = L.cuePenalty + layout.cost;
  const short = shortCue(ctx, a, b, blockStart, blockEnd, breaks);
  if (short) cost += short === 1 ? L.orphanPenalty : L.twoWordPenalty;
  else if (unpausedPair(ctx, a, b, blockStart, blockEnd)) cost += L.twoWordPenalty;
  if (b < blockEnd) {
    // a cue break at a pause shows it: text penalties waived by the hesitation's weight, and a bonus growing with the pause
    const gap = pauseAfter(ctx, b);
    const lastLineStart = layout.lines[layout.lines.length - 1][0];
    cost += L.cueBreakWeight * breakCost(ctx, b, { lineStart: lastLineStart, hesitation: hesitationWeight(rs.pauses, gap) });
    cost -= L.cuePauseBonus * Math.min(1, Math.max(0, gap) / L.cuePauseFull);
  }
  const available = shownFor(ctx, a, b);
  if (available < rs.pauses.minShown) cost += L.flashPenalty;
  // reading time the cue lacks (as readingDeficit measures it): a cue that is a little fast costs a little
  const chars = prefixOf(ctx.texts)[b + 1] - prefixOf(ctx.texts)[a] - 1;
  const needed = Math.max(r.minDuration ?? 0, r.maxCps ? chars / r.maxCps : 0);
  cost += L.readingWeight * Math.max(0, needed - available);
  return { cost, lines: layout.lines };
}

/**
 * Deterministic splitter: dynamic programming over cue boundaries within one speaker block
 * [from, to], minimizing soft-rule cost under the hard rules.
 */
export function splitBlock(ctx: SplitContext, from: number, to: number): CueLayout[] {
  const breaks = pauseCueBreaks(ctx, from, to);
  const n = to - from + 1;
  const maxWords = Math.ceil((ctx.rules.maxCharsPerLine * ctx.rules.maxLines) / rulesetOf(ctx).layout.minCharsPerWord) + 1;
  const best = new Array<number>(n + 1).fill(Infinity);
  const choice: Array<{ i: number; lines: WordRange[] } | null> = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= Math.max(0, j - maxWords); i--) {
      const c = cueCost(ctx, from + i, from + j - 1, from, to, breaks);
      // a cue that breaks a hard rule (or spans a pause) stays impossible when it grows to the left
      if (!c) break;
      if (best[i] === Infinity) continue;
      if (best[i] + c.cost < best[j]) { best[j] = best[i] + c.cost; choice[j] = { i, lines: c.lines }; }
    }
    if (best[j] === Infinity) {
      // a single-word cue always fits, so this runs only when a cost is NaN (a word without valid times): force a
      // single-word cue instead of failing in the traceback
      best[j] = best[j - 1] + 1000;
      choice[j] = { i: j - 1, lines: [[from + j - 1, from + j - 1]] };
    }
  }
  const cues: CueLayout[] = [];
  for (let j = n; j > 0; j = choice[j]!.i) cues.unshift({ lines: choice[j]!.lines });
  return cues;
}
