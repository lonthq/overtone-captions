import { deepFreeze } from './freeze.js';
import type { RuleSet } from './types.js';

/**
 * Rule set 1. FROZEN: never change a value or the logic it selects. Improvements go into a new rule set (see
 * types.ts); test/rulesets-golden.test.ts fails when this one's output changes.
 *
 * Pauses: hesitations count from a noise floor of 0.4 s, their weight rising linearly from 0.5 at 0.4 s to 1 at
 * 0.6 s; the weight scales the line-break bonus (10), the text-penalty waiver and the lone-word cost. A pause of 1 s
 * starts a cue (1.5 s always does); a flash is under 0.7 s.
 *
 * Line endings: besides an auxiliary that opens a question (logic.questionAuxiliary), a line may end on a main-verb
 * "have"/"do"/"be" before its object (logic.mainVerb: "You have / your robotics,") and on the subject of a question
 * head (logic.questionHead: "Why don't you / just admit").
 *
 * Display time: a cue short of minDuration or of reading time at maxCps is held into the silence after it, up to
 * 1.5 s (layout.maxHold) and never into the next cue. Before a pause of 1 s or more, 0.4 s stays blank
 * (layout.minBlank) so the pause still shows. The splitter counts on 0.5 s (layout.maxExtension) when it weighs
 * flashes and reading time.
 */
export const RULESET_1: RuleSet = deepFreeze({
  id: '1',
  summary: 'v1 layout: weighted hesitations from 0.4 s (full weight at 0.6 s), cues at 1 s, always at 1.5 s; short cues held up to 1.5 s',
  pauses: {
    force: 1.5,
    cue: 1.0,
    minShown: 0.7,
    floor: 0.4,
    floorWeight: 0.5,
    full: 0.6,
    proposalExempt: 0.4,
    pairExempt: 0.4,
    marker: 0.4,
  },
  layout: {
    linePenalty: 1,
    cuePenalty: 2,
    balance: 0.1,
    topLonger: 0.1,
    cueBreakWeight: 4,
    orphanPenalty: 6,
    twoWordPenalty: 4,
    orphanMaxChars: 12,
    oneWordLine: 6,
    readingWeight: 6,
    cuePauseBonus: 5,
    cuePauseFull: 0.8,
    linePauseBonus: 10,
    flashPenalty: 10,
    maxExtension: 0.5,
    maxHold: 1.5,
    minBlank: 0.4,
    closeGap: 0.1,
    minCharsPerWord: 2,
  },
  breaks: {
    sentenceEnd: 0,
    clauseEnd: 1,
    beforeConjunction: 2,
    other: 4,
    noLineEnd: 20,
    conjunctionLineEnd: 10,
    pronounEnd: 8,
    weakPronounEnd: 4,
    adjectiveEnd: 3,
    sentenceEdge: 8,
    nearSentenceEdge: 2,
    groupTail: 3,
    keep: 100,
    maxNameWords: 4,
  },
  merge: {
    readingTolerance: 1.25,
    readingSlack: 0.25,
    reflowMargin: 5,
    maxWiden: 2,
    tooShortShare: 0.5,
  },
  logic: {
    questionAuxiliary: true,
    hesitationWaiver: true,
    mainVerb: true,
    questionHead: true,
  },
  // a snapshot of overtone-format's DEFAULT_PROFILES at the time of this rule set
  profiles: {
    horizontal: { description: 'TV/desktop', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minDuration: 1.0, maxDuration: 7.0 } },
    vertical: { description: 'Phone', aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5.0 } },
  },
  styling: { maxStyledRatio: 0.15, maxKeyPerCue: 1 },
});
