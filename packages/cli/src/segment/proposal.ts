import { rangeText, type Cue, type ProfileRules } from 'overtone-format';
import type { SpeakerWord } from '../turns.js';
import { breakRule, checkCues, hiddenPause, readabilityBreaks, readingDeficit, timeCues, TIMING_RULES, type Readability, type RuleName } from './rules.js';
import { layoutLines, linesCost, rulesetOf, shortCue, splitBlock, type CueLayout, type SplitContext } from './splitter.js';

/** LLM line-cutting proposal: global word indices where a cue / a line inside a cue starts. */
export interface BreakProposal { cueStarts: number[]; lineStarts: number[] }

// Merge parameters live in the rule set (`merge`); see rulesets/types.ts.

const MAX_EXAMPLES = 3;

/**
 * Why a proposed cue was not used: a broken rule; "shortCue" = one or two short words that could join a neighbor;
 * "tooShort" = shown for at most half the minimum duration where the deterministic cue lasts longer;
 * "afterBadBreak" = valid, but follows a bad break and is re-cut with it; "widened" = valid, re-cut with a rejected
 * neighbor that could not be cut well alone.
 */
export type RejectReason = Exclude<RuleName, 'maxCps' | 'minDuration'> | 'shortCue' | 'tooShort' | 'afterBadBreak' | 'widened';

export interface CutDiagnostics {
  /** Proposed cues considered. */
  proposed: number;
  /** Rejected proposed cues per reason (a cue counts once per reason it breaks). */
  rejected: Partial<Record<RejectReason, number>>;
  /** A few rejected cues per reason: the cue's lines joined by " / ". */
  examples: Partial<Record<RejectReason, Array<{ cue: string; detail: string }>>>;
  /** Kept proposed cues whose lines were re-cut (see merge.reflowMargin), and a few of them: proposed → used. */
  reflowed: number;
  reflowExamples: Array<{ cue: string; to: string }>;
  /** Blocks that used the deterministic layout because the mix lacked too much reading time. */
  timingFallback: number;
  /** A few of those blocks: first words, and the missing reading time (s, see readingDeficit) of the mix and of the deterministic layout. */
  fallbacks: Array<{ block: string; mixed: number; deterministic: number }>;
}

export function newDiagnostics(): CutDiagnostics {
  return { proposed: 0, rejected: {}, examples: {}, reflowed: 0, reflowExamples: [], timingFallback: 0, fallbacks: [] };
}

/** One speaker block [from, to] with its timing context and its deterministic cues. */
export interface Block { from: number; to: number; nextStart: number; after: number; det: readonly Cue[] }

/** Turn a proposal into layouts for block [from, to]; the block start is always a cue start. */
function proposalLayouts(p: BreakProposal, from: number, to: number): CueLayout[] {
  const cueStarts = [...new Set([from, ...p.cueStarts.filter((i) => Number.isInteger(i) && i > from && i <= to)])].sort((a, b) => a - b);
  const lineStarts = new Set(p.lineStarts.filter((i) => Number.isInteger(i)));
  return cueStarts.map((s, k) => {
    const e = k + 1 < cueStarts.length ? cueStarts[k + 1] - 1 : to;
    const starts = [s, ...[...lineStarts].filter((i) => i > s && i <= e).sort((a, b) => a - b)];
    return { lines: starts.map((ls, m) => [ls, m + 1 < starts.length ? starts[m + 1] - 1 : e] as [number, number]) };
  });
}

/** Better lines for a kept proposed cue (same words), or undefined when its own lines are fine (see merge.reflowMargin). */
function reflowLines(ctx: SplitContext, layout: CueLayout, r: Readability): CueLayout | undefined {
  const best = layoutLines(ctx, layout.lines[0][0], layout.lines[layout.lines.length - 1][1]);
  if (!best || linesCost(ctx, layout.lines) < best.cost + rulesetOf(ctx).merge.reflowMargin) return undefined;
  // only a layout that keeps the reading rules and hides no pause inside a line
  if (best.lines.slice(0, -1).some(([start, end]) => breakRule(end, start, false, r))) return undefined;
  if (best.lines.some(([start, end]) => hiddenPause(start, end, r) !== undefined)) return undefined;
  return { lines: best.lines };
}

const show = (words: readonly SpeakerWord[], l: CueLayout) => l.lines.map((r) => rangeText(words, r)).join(' / ');

/**
 * Merge an LLM proposal into one speaker block: proposed cues that pass the hard and reading rules (Readability)
 * are kept; the deterministic splitter cuts the stretches between them. Undefined (use the deterministic cues) when
 * none is kept or the mix lacks clearly more reading time (merge.readingTolerance).
 */
export function mergeProposal(
  ctx: SplitContext,
  words: readonly SpeakerWord[],
  duration: number,
  block: Block,
  proposal: BreakProposal,
  diagnostics: CutDiagnostics,
): { cues: Cue[]; kept: number; proposed: number } | undefined {
  const { from, to, nextStart, after, det } = block;
  const rules: ProfileRules = ctx.rules;
  const rs = rulesetOf(ctx);
  const M = rs.merge;
  const reject = (reason: RejectReason, layout: CueLayout, detail: string) => {
    diagnostics.rejected[reason] = (diagnostics.rejected[reason] ?? 0) + 1;
    const list = (diagnostics.examples[reason] ??= []);
    if (list.length < MAX_EXAMPLES) list.push({ cue: show(words, layout), detail });
  };
  const readability: Readability = { ctx, blockStart: from, blockEnd: to };
  const proposed = proposalLayouts(proposal, from, to);
  diagnostics.proposed += proposed.length;
  /** How long the deterministic cue holding word w is shown. */
  const detShown = (w: number) => {
    const c = det.find((x) => x.lines[0].words[0] <= w && w <= x.lines[x.lines.length - 1].words[1]);
    return c ? c.end - c.start : 0;
  };
  // a proposed cue is kept when, timed on its own, it breaks no hard or reading rule
  const valid = proposed.map((layout) => {
    const first = layout.lines[0][0];
    const last = layout.lines[layout.lines.length - 1][1];
    const single = timeCues([layout], words, rules, duration, last + 1 <= to ? words[last + 1].start : nextStart, 0, rs);
    const hard = checkCues(single, words, rules, [first, last], readability).filter((v) => !TIMING_RULES.has(v.rule));
    const seen = new Set<RuleName>();
    for (const v of hard) if (!seen.has(v.rule)) { seen.add(v.rule); reject(v.rule as RejectReason, layout, v.detail); }
    if (hard.length > 0) return false;
    const shown = single[0].end - single[0].start;
    if (rules.minDuration !== undefined && shown <= rules.minDuration * rs.merge.tooShortShare + 1e-9 && detShown(first) > shown) {
      reject('tooShort', layout, `shown ${shown.toFixed(2)} s`);
      return false;
    }
    if (!shortCue(ctx, first, last, from, to, readabilityBreaks(readability))) return true;
    reject('shortCue', layout, `${last - first + 1} word${last > first ? 's' : ''} between other words`);
    return false;
  }).map((ok, k) => {
    // a bad break (inside a group, after a stopword) also taints the cue it leads into: re-cut both together
    if (k === 0 || !ok) return ok;
    const prevLine = proposed[k - 1].lines[proposed[k - 1].lines.length - 1];
    if (!breakRule(prevLine[1], prevLine[0], true, readability)) return true;
    reject('afterBadBreak', proposed[k], `previous cue ends on "${words[prevLine[1]].text}"`);
    return false;
  });
  // a rejected stretch whose deterministic cut still breaks a reading rule or leaves a short cue takes in its kept
  // neighbors, so the splitter has room for a better cut
  const flawed = (layouts: CueLayout[]) => layouts.some((c) =>
    shortCue(ctx, c.lines[0][0], c.lines[c.lines.length - 1][1], from, to, readabilityBreaks(readability)) !== 0
    || c.lines.some(([start, end], m) => breakRule(end, start, m === c.lines.length - 1, readability) !== undefined));
  const stretchEnd = (k: number) => { let m = k; while (m + 1 < proposed.length && !valid[m + 1]) m++; return m; };
  const span = (k: number, m: number) => [proposed[k].lines[0][0], proposed[m].lines[proposed[m].lines.length - 1][1]] as const;
  for (let pass = 0; pass < M.maxWiden; pass++) {
    let changed = false;
    for (let k = 0; k < proposed.length; k++) {
      if (valid[k]) continue;
      const m = stretchEnd(k);
      if (flawed(splitBlock(ctx, ...span(k, m)))) {
        for (const j of [k - 1, m + 1]) {
          if (j < 0 || j >= proposed.length || !valid[j]) continue;
          valid[j] = false;
          reject('widened', proposed[j], 're-cut with a rejected neighbour');
          changed = true;
        }
      }
      k = m + 1;
    }
    if (!changed) break;
  }
  const mixed: CueLayout[] = [];
  let kept = 0;
  for (let k = 0; k < proposed.length; k++) {
    if (valid[k]) {
      const better = reflowLines(ctx, proposed[k], readability);
      if (better) {
        diagnostics.reflowed++;
        if (diagnostics.reflowExamples.length < MAX_EXAMPLES) diagnostics.reflowExamples.push({ cue: show(words, proposed[k]), to: show(words, better) });
      }
      mixed.push(better ?? proposed[k]);
      kept++;
      continue;
    }
    const m = stretchEnd(k);
    mixed.push(...splitBlock(ctx, ...span(k, m)));
    k = m;
  }
  if (kept === 0) return undefined;
  const hybrid = timeCues(mixed, words, rules, duration, nextStart, after, rs);
  const mixedDeficit = readingDeficit(hybrid, rules);
  const detDeficit = readingDeficit(det, rules);
  if (mixedDeficit <= detDeficit * M.readingTolerance + M.readingSlack + 1e-9) return { cues: hybrid, kept, proposed: proposed.length };
  diagnostics.timingFallback++;
  if (diagnostics.fallbacks.length < MAX_EXAMPLES) {
    diagnostics.fallbacks.push({ block: rangeText(words, [from, Math.min(to, from + 5)]), mixed: mixedDeficit, deterministic: detDeficit });
  }
  return undefined;
}
