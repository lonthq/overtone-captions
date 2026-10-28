import type { Cue, Profile } from 'overtone-format';
import type { ResolvedProfile } from '../config.js';
import { langOf } from '../lang/index.js';
import type { SpeakerWord } from '../turns.js';
import { noBreakAfter, numberGroupEnds } from './groups.js';
import { mergeProposal, newDiagnostics, type BreakProposal, type CutDiagnostics } from './proposal.js';
import { timeCues } from './rules.js';
import { LATEST_RULESET, type RuleSet } from './rulesets/index.js';
import { splitBlock, type SplitContext } from './splitter.js';

export { checkCues, readingDeficit, timeCues, type RuleName, type Violation } from './rules.js';
export type { BreakProposal, CutDiagnostics } from './proposal.js';

/** Speaker blocks: runs of one speaker, also ended after a word where the speaker may change (`mayChange`). */
function blocks(words: readonly SpeakerWord[], mayChange?: readonly boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  words.forEach((w, i) => {
    if (i === 0 || w.speaker !== words[i - 1].speaker || mayChange?.[i - 1]) out.push([i, i]);
    else out[out.length - 1][1] = i;
  });
  return out;
}

export interface BuildProfileOptions {
  language: string;
  glossary: readonly string[];
  duration: number;
  proposal?: BreakProposal;
  /** The rule set (every layout parameter); default: the latest. */
  ruleset?: RuleSet;
  /**
   * Per word: its time is unknown ("interpolated"), so the silence next to it is no pause (splitter.ts `pauseAfter`).
   * Not set by recut, whose estimated word times come from cues.
   */
  untimed?: readonly boolean[];
  /**
   * Per word: the speaker may change after it, although its speaker id does not (recut: subtitles that do not name
   * their speakers, see recut.ts `possibleSpeakerChanges`). It ends a speaker block, so no cue spans it.
   */
  speakerMayChange?: readonly boolean[];
}

export interface BuildProfileResult {
  profile: Profile;
  blocks: number;
  /** Speaker blocks cut entirely as the LLM proposed. */
  fromProposal: number;
  /** Cues taken from the proposal / cues the deterministic splitter had to cut instead. */
  proposalCues: number;
  repairedCues: number;
  diagnostics: CutDiagnostics;
}

/**
 * Cut one profile into cues and lines, per speaker block: the deterministic splitter's cues, or, with an LLM
 * proposal, the proposal's valid cues mixed with deterministic cuts (see mergeProposal).
 */
export function buildProfile(words: readonly SpeakerWord[], spec: ResolvedProfile, opts: BuildProfileOptions): BuildProfileResult {
  const lang = langOf(opts.language);
  const ruleset = opts.ruleset ?? LATEST_RULESET;
  const texts = words.map((w) => w.text);
  const ctx: SplitContext = {
    texts,
    starts: words.map((w) => w.start),
    ends: words.map((w) => w.end),
    keep: noBreakAfter(texts, lang, opts.glossary, ruleset),
    tails: numberGroupEnds(texts, lang),
    lang,
    rules: spec.rules,
    ruleset,
    ...(opts.untimed ? { untimed: opts.untimed } : {}),
  };
  const cues: Cue[] = [];
  const bs = blocks(words, opts.speakerMayChange);
  let fromProposal = 0;
  let proposalCues = 0;
  let repairedCues = 0;
  const diagnostics = newDiagnostics();
  for (const [from, to] of bs) {
    const nextStart = to + 1 < words.length ? words[to + 1].start : opts.duration;
    const after = cues.at(-1)?.end ?? 0;
    const det = timeCues(splitBlock(ctx, from, to), words, spec.rules, opts.duration, nextStart, after, ruleset);
    const merged = opts.proposal ? mergeProposal(ctx, words, opts.duration, { from, to, nextStart, after, det }, opts.proposal, diagnostics) : undefined;
    if (merged) {
      cues.push(...merged.cues);
      proposalCues += merged.kept;
      repairedCues += merged.cues.length - merged.kept;
      if (merged.kept === merged.proposed) fromProposal++;
    } else {
      cues.push(...det);
      if (opts.proposal) repairedCues += det.length;
    }
  }
  const profile: Profile = {
    id: spec.id,
    ...(spec.description ? { description: spec.description } : {}),
    aspect: spec.aspect,
    ...(spec.window ? { window: spec.window } : {}),
    rules: spec.rules,
    cues,
  };
  return { profile, blocks: bs.length, fromProposal, proposalCues, repairedCues, diagnostics };
}
