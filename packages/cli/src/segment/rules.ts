import { roundTime, rangeText, type Cue, type ProfileRules } from 'overtone-format';
import { rulesOf } from '../lang/index.js';
import { displayLength } from '../text/length.js';
import { isUntimed } from '../align/align.js';
import type { SpeakerWord } from '../turns.js';
import { clauseEndAt, invertedAuxiliaryAt, mainVerbAt, plain, pronounEndAt, sentenceEndAt } from './groups.js';
import { LATEST_RULESET, type RuleSet } from './rulesets/index.js';
import { layoutLines, lineLength, pauseAfter, pauseCueBreaks, rulesetOf, type CueLayout, type SplitContext } from './splitter.js';

// Cue timing, and the checks on timed cues: the profile's hard rules (measured as in docs/format/spec.md §16.4)
// and, for LLM proposals, the reading rules.

export type BreakRule = 'group' | 'lineEnd' | 'pronounEnd' | 'sentenceEdge' | 'splitSentence';
export type RuleName = 'maxCharsPerLine' | 'maxLines' | 'maxDuration' | 'minDuration' | 'maxCps' | 'speaker' | 'overlap' | 'coverage' | 'pause' | BreakRule;
export interface Violation { cue: number; rule: RuleName; detail: string }

/** Reading-speed rules: a proposal may break them (speech can be too fast), within limits (see mergeProposal). */
export const TIMING_RULES: ReadonlySet<RuleName> = new Set(['maxCps', 'minDuration']);

/**
 * Time cues: start at the first word, end at the last, held up to layout.maxHold past it to reach minDuration or the
 * reading time at maxCps; never into the next cue, past `duration` or past maxDuration. Before a cue-break pause
 * (pauses.cue; none next to an untimed word), layout.minBlank of the silence stays blank so the pause shows. Starts
 * and words never move. Every cue lasts at least 1 ms and starts no earlier than `after` (previous cue end). A gap
 * under layout.closeGap before the same speaker's next cue is closed (within maxDuration).
 */
export function timeCues(
  layouts: readonly CueLayout[],
  words: readonly SpeakerWord[],
  rules: ProfileRules,
  duration: number,
  nextStartAfter?: number,
  after = 0,
  ruleset: RuleSet = LATEST_RULESET,
): Cue[] {
  const { maxHold, minBlank, closeGap } = ruleset.layout;
  const texts = words.map((w) => w.text);
  // a word no engine heard has an unknown time: the silence next to it is no pause (as splitter.ts pauseAfter reads it)
  let prevEnd = after;
  return layouts.map((c, k) => {
    const first = c.lines[0][0];
    const last = c.lines[c.lines.length - 1][1];
    const start = roundTime(Math.max(words[first].start, prevEnd));
    const lastEnd = words[last].end;
    const nextStart = k + 1 < layouts.length ? words[layouts[k + 1].lines[0][0]].start : (nextStartAfter ?? duration);
    const nextWord = k + 1 < layouts.length ? words[layouts[k + 1].lines[0][0]] : words[last + 1];
    const chars = lineLength(texts, first, last);
    const needed = Math.max(rules.minDuration ?? 0, rules.maxCps ? chars / rules.maxCps : 0);
    const longest = rules.maxDuration === undefined ? Infinity : start + rules.maxDuration;
    const pause = nextWord && !isUntimed(words[last]) && !isUntimed(nextWord) ? nextStart - lastEnd : 0;
    const room = pause >= ruleset.pauses.cue ? nextStart - minBlank : nextStart;
    // the time needed, rounded up to the millisecond: rounded down, a cue held for its reading time is still too fast
    const neededEnd = Math.ceil((start + needed) * 1000 - 1e-6) / 1000;
    let end = roundTime(Math.max(lastEnd, start + 0.001, Math.min(neededEnd, lastEnd + maxHold, room, duration, longest)));
    const gap = roundTime(nextStart - end);
    if (nextWord && nextWord.speaker === words[first].speaker && gap > 0 && gap < closeGap && nextStart <= duration
      && (rules.maxDuration === undefined || nextStart - start <= rules.maxDuration)) end = roundTime(nextStart);
    prevEnd = end;
    return {
      start,
      end,
      speaker: words[first].speaker,
      lines: c.lines.map((range) => ({ words: [range[0], range[1]] as [number, number], text: rangeText(words, range) })),
    };
  });
}

/** A speaker block whose LLM-proposed breaks are checked against the reading rules (see `breakRule`). */
export interface Readability { ctx: SplitContext; blockStart: number; blockEnd: number }

const BREAKS = new WeakMap<Readability, Uint8Array>();
/** The block's pauseCueBreaks (indexed from blockStart), computed once per Readability. */
export function readabilityBreaks(r: Readability): Uint8Array {
  let b = BREAKS.get(r);
  if (!b) {
    b = pauseCueBreaks(r.ctx, r.blockStart, r.blockEnd);
    BREAKS.set(r, b);
  }
  return b;
}

/**
 * The first word of line [first, last] followed by a cue-break pause (pauseCueBreaks) hidden inside the line, if
 * any. A proposal must show such a pause as a cue or line break.
 */
export function hiddenPause(first: number, last: number, r: Readability): number | undefined {
  const breaks = readabilityBreaks(r);
  for (let w = Math.max(first, r.blockStart); w < Math.min(last, r.blockEnd); w++) if (breaks[w - r.blockStart]) return w;
  return undefined;
}

const BREAK_DETAIL: Record<BreakRule, string> = {
  group: 'break inside a group after',
  lineEnd: 'line ends on',
  pronounEnd: 'line ends on',
  sentenceEdge: 'sentence cut off at',
  splitSentence: 'cue ends inside a short sentence at',
};

/** True when the sentence around a break after word `at` fits one cue (characters, lines, no long pause, maxDuration). */
function fitsOneCue(at: number, r: Readability): boolean {
  const { texts, starts, ends, rules } = r.ctx;
  let s = at;
  while (s > r.blockStart && !sentenceEndAt(texts, s - 1)) s--;
  let e = at + 1;
  while (e < r.blockEnd && !sentenceEndAt(texts, e)) e++;
  if (lineLength(texts, s, e) > rules.maxCharsPerLine * rules.maxLines) return false;
  const breaks = readabilityBreaks(r);
  for (let k = s; k < e; k++) if (breaks[k - r.blockStart]) return false;
  if (rules.maxDuration !== undefined && ends[e] - starts[s] > rules.maxDuration) return false;
  return layoutLines(r.ctx, s, e) !== null;
}

/**
 * The reading rule (for LLM proposals) that ending a line after word `at` breaks, if any, when more words of the
 * block follow. `lineStart`: the line's first word; `cueEnd`: the line ends its cue. A line may not end:
 * - inside a no-break group ("group");
 * - on an article, preposition, possessive, auxiliary or coordinating conjunction without clause punctuation
 *   ("lineEnd"; "is up to," is fine; except invertedAuxiliaryAt and mainVerbAt);
 * - on a subject pronoun or relative word ("pronounEnd", pronounEndAt);
 * - one word before or after a sentence end on the same line ("sentenceEdge": "the 2004 | class.",
 *   "That's correct. I | think").
 * A cue may not end inside a sentence that fits one cue ("splitSentence": "Jim, thank you | for joining us.").
 * A break before a hesitation of pauses.proposalExempt (with logic.hesitationWaiver) breaks only "group". The
 * deterministic splitter treats most of these as soft costs.
 */
export function breakRule(at: number, lineStart: number, cueEnd: boolean, r: Readability): BreakRule | undefined {
  const { texts, keep, lang } = r.ctx;
  const rs = rulesetOf(r.ctx);
  if (at >= r.blockEnd) return undefined;
  if (keep[at]) return 'group';
  const exempt = rs.logic.hesitationWaiver && pauseAfter(r.ctx, at) >= rs.pauses.proposalExempt;
  if (clauseEndAt(texts, at) || exempt) return undefined;
  const cutting = rulesOf(lang).lineCutting;
  const lineEnd = cutting?.noLineEnd.has(plain(texts[at])) && !invertedAuxiliaryAt(texts, lang, at, rs) && !mainVerbAt(texts, lang, at, rs);
  if (lineEnd || cutting?.lineStartConjunctions.has(plain(texts[at]))) return 'lineEnd';
  if (pronounEndAt(texts, lang, at, rs) === 'subject') return 'pronounEnd';
  if (sentenceEndAt(texts, at + 1) || (at - 1 >= lineStart && sentenceEndAt(texts, at - 1))) return 'sentenceEdge';
  if (cueEnd && fitsOneCue(at, r)) return 'splitSentence';
  return undefined;
}

/**
 * Check timed cues against the profile's hard rules; `range` = the words they must cover exactly. With
 * `readability` (LLM proposals), also the reading rules (breakRule) and "pause" for a cue-break pause hidden inside
 * a line.
 */
export function checkCues(
  cues: readonly Cue[],
  words: readonly SpeakerWord[],
  rules: ProfileRules,
  range: [number, number] = [0, words.length - 1],
  readability?: Readability,
): Violation[] {
  const force = (readability ? rulesetOf(readability.ctx) : LATEST_RULESET).pauses.force;
  const out: Violation[] = [];
  let expected = range[0];
  let prevEnd = -Infinity;
  cues.forEach((cue, i) => {
    if (cue.lines.length > rules.maxLines) out.push({ cue: i, rule: 'maxLines', detail: `${cue.lines.length} lines` });
    for (const line of cue.lines) {
      if (line.words[0] !== expected) out.push({ cue: i, rule: 'coverage', detail: `expected word ${expected}, got ${line.words[0]}` });
      expected = line.words[1] + 1;
      const length = displayLength(line.text);
      if (line.words[1] > line.words[0] && length > rules.maxCharsPerLine) out.push({ cue: i, rule: 'maxCharsPerLine', detail: `${length} chars: "${line.text}"` });
      const last = line.words[1];
      const bad = readability ? breakRule(last, line.words[0], line === cue.lines[cue.lines.length - 1], readability) : undefined;
      if (bad) out.push({ cue: i, rule: bad, detail: `${BREAK_DETAIL[bad]} "${words[last].text}"` });
      for (let w = line.words[0]; w <= line.words[1]; w++) {
        if (words[w]?.speaker !== cue.speaker) { out.push({ cue: i, rule: 'speaker', detail: `word ${w} is ${words[w]?.speaker}` }); break; }
      }
    }
    let paused = false;
    for (let w = cue.lines[0].words[0]; w < cue.lines[cue.lines.length - 1].words[1]; w++) {
      const gap = !words[w + 1] ? 0 : readability ? pauseAfter(readability.ctx, w) : words[w + 1]!.start - words[w]!.end;
      if (gap >= force) { out.push({ cue: i, rule: 'pause', detail: `pause before word ${w + 1}` }); paused = true; break; }
    }
    for (const line of readability && !paused ? cue.lines : []) {
      const w = hiddenPause(line.words[0], line.words[1], readability!);
      if (w === undefined) continue;
      out.push({ cue: i, rule: 'pause', detail: `${(words[w + 1].start - words[w].end).toFixed(1)} s pause inside a line after "${words[w].text}"` });
      break;
    }
    const dur = cue.end - cue.start;
    const multiWord = cue.lines.length > 1 || cue.lines[0].words[1] > cue.lines[0].words[0];
    if (rules.maxDuration !== undefined && dur > rules.maxDuration + 1e-9 && multiWord) out.push({ cue: i, rule: 'maxDuration', detail: `${dur.toFixed(2)} s` });
    if (rules.minDuration !== undefined && dur < rules.minDuration - 1e-9) out.push({ cue: i, rule: 'minDuration', detail: `${dur.toFixed(2)} s` });
    const chars = cue.lines.reduce((n, l) => n + displayLength(l.text), 0) + cue.lines.length - 1;
    if (rules.maxCps !== undefined && dur > 0 && chars / dur > rules.maxCps + 1e-9) out.push({ cue: i, rule: 'maxCps', detail: `${(chars / dur).toFixed(1)} cps` });
    if (cue.start < prevEnd - 1e-9) out.push({ cue: i, rule: 'overlap', detail: `starts ${cue.start} before previous end ${prevEnd}` });
    prevEnd = cue.end;
  });
  if (expected !== range[1] + 1) out.push({ cue: cues.length - 1, rule: 'coverage', detail: `words ${expected}–${range[1]} not covered` });
  return out;
}

/**
 * Reading time the cues lack (s): per cue, how far it falls short of minDuration and of maxCps. Unlike a violation
 * count, it does not grow when a stretch is cut into more cues, and a slightly fast cue costs a little.
 */
export function readingDeficit(cues: readonly Cue[], rules: ProfileRules): number {
  let total = 0;
  for (const cue of cues) {
    const chars = cue.lines.reduce((n, l) => n + displayLength(l.text), 0) + cue.lines.length - 1;
    const needed = Math.max(rules.minDuration ?? 0, rules.maxCps ? chars / rules.maxCps : 0);
    total += Math.max(0, needed - (cue.end - cue.start));
  }
  return total;
}
