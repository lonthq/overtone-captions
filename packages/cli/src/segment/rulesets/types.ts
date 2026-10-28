import type { ProfileRules } from 'overtone-format';

/**
 * A rule set: every parameter of the rule-based layout (line and cue cutting, cue timing, merging LLM proposals,
 * pause marks in the LLM prompt) plus switches for parts of its logic. Same words, language data and rule set give
 * the same cues.
 *
 * Released rule sets never change. An improvement is a new file here, registered in index.ts, and LATEST moves to
 * it. Users pin one with `"rules"` in overtone.config.json or `--rules`; test/rulesets-golden.test.ts guards each.
 */
export interface RuleSet {
  /** The id users pin ("1"). */
  readonly id: string;
  /** One line: what this rule set changed. */
  readonly summary: string;
  /** Pauses (seconds of silence between two words of one speaker). See ../pauses.ts. */
  readonly pauses: {
    /** A pause of at least this long always starts a new cue (the LLM prompt marks it "‖"). */
    readonly force: number;
    /** A pause this long starts a new cue, unless inside a name, number group or glossary term, or a piece of speech would be shown under `minShown`. */
    readonly cue: number;
    /** A cue with less time on screen than this (s, including the extension cue timing may give it) is a flash. */
    readonly minShown: number;
    /**
     * Noise floor of a hesitation: shorter pauses play no part in the hesitation terms (line-break bonus,
     * text-penalty waiver, lone-word cost, splitting a one-line cue).
     */
    readonly floor: number;
    /** Hesitation weight at `floor`; it grows linearly to 1 at `full` (full <= floor: a step of 1 at the floor). */
    readonly floorWeight: number;
    readonly full: number;
    /** A break of an LLM proposal followed by a pause of at least this long breaks no reading rule but "group". */
    readonly proposalExempt: number;
    /** A cue of two longer words next to a pause of at least this long is not a fragment (see unpausedPair). */
    readonly pairExempt: number;
    /** The LLM prompt marks a pause of at least this long (and shorter than `force`) with its length (" ·0.7s"). */
    readonly marker: number;
  };
  /** Costs and limits of the splitter (../splitter.ts) and cue timing (../rules.ts). */
  readonly layout: {
    /** Cost per extra line. */
    readonly linePenalty: number;
    /** Cost per cue. */
    readonly cuePenalty: number;
    /** Cost per character a line is away from the ideal (balanced) length. */
    readonly balance: number;
    /** Extra cost per character the top line of two is longer than the ideal. */
    readonly topLonger: number;
    /** Weight of the soft break cost at a cue boundary: a cue break is more visible than a line break. */
    readonly cueBreakWeight: number;
    /** Extra cost of a cue holding one short word that could have joined a neighbor (an orphan). */
    readonly orphanPenalty: number;
    /** Extra cost of a cue of two short words, or of two words that are a fragment (unpausedPair). */
    readonly twoWordPenalty: number;
    /** A word or two words of at most this many characters is "short" for the two penalties above. */
    readonly orphanMaxChars: number;
    /** Extra cost of a line holding a single word next to a longer one (scaled down by a hesitation next to it). */
    readonly oneWordLine: number;
    /** Cost per second of reading time a cue lacks (for its minDuration and maxCps). */
    readonly readingWeight: number;
    /** Bonus for a cue break at a pause: cuePauseBonus · min(1, pause / cuePauseFull). */
    readonly cuePauseBonus: number;
    readonly cuePauseFull: number;
    /** Bonus for a line break at a hesitation, times its weight. */
    readonly linePauseBonus: number;
    /** Extra cost of a cue with less than pauses.minShown seconds on screen. */
    readonly flashPenalty: number;
    /**
     * Seconds past its last word the splitter (flash and reading-time costs) and the LLM prompt count on a cue
     * staying on screen. Conservative, since speech often follows right after; cue timing may hold longer (maxHold).
     */
    readonly maxExtension: number;
    /** Seconds cue timing may hold a cue past its last word, into the silence after it, to reach minDuration / maxCps. */
    readonly maxHold: number;
    /** When a cue is held into a pause of pauses.cue or longer, at least this much of the pause stays blank. */
    readonly minBlank: number;
    /** Gaps shorter than this (s) between two cues of the same speaker are closed. */
    readonly closeGap: number;
    /** The splitter tries cues of at most ceil(maxCharsPerLine · maxLines / minCharsPerWord) + 1 words. */
    readonly minCharsPerWord: number;
  };
  /** Soft cost of ending a line or cue after a word (../groups.ts, breakCost). */
  readonly breaks: {
    /** Base cost after a sentence end, a clause end, before a conjunction, elsewhere. */
    readonly sentenceEnd: number;
    readonly clauseEnd: number;
    readonly beforeConjunction: number;
    readonly other: number;
    /** Ending on an article, preposition, possessive or auxiliary (noLineEnd). */
    readonly noLineEnd: number;
    /** Ending on and/or/but/so (lineStartConjunctions). */
    readonly conjunctionLineEnd: number;
    /** Ending on a subject pronoun or relative word. */
    readonly pronounEnd: number;
    /** Ending on a pronoun that may be an object (after a verb), or a contracted pronoun ("it's"). */
    readonly weakPronounEnd: number;
    /** Ending on a likely adjective before its noun. */
    readonly adjectiveEnd: number;
    /** A break that leaves one word of a sentence on the other side. */
    readonly sentenceEdge: number;
    /** A break that leaves two words of a sentence on the other side. */
    readonly nearSentenceEdge: number;
    /** Breaking right after the last word of a number group. */
    readonly groupTail: number;
    /** Breaking inside a name, number group or glossary term. */
    readonly keep: number;
    /** Longest run of capitalized words treated as one name. */
    readonly maxNameWords: number;
  };
  /** Merging an LLM line-cutting proposal (../proposal.ts). */
  readonly merge: {
    /** A block keeps the proposed cues when its missing reading time is at most readingTolerance × the rules' + readingSlack s. */
    readonly readingTolerance: number;
    readonly readingSlack: number;
    /** The lines of a kept proposed cue are re-cut when the rules' layout costs at least this much less. */
    readonly reflowMargin: number;
    /** How often a stretch of rejected cues may take in its kept neighbors. */
    readonly maxWiden: number;
    /** A proposed cue shown this share of the profile's minDuration or less is too short (when the rules show it longer). */
    readonly tooShortShare: number;
  };
  /** Switches for parts of the logic, so a later rule set can differ in behavior, not only in numbers. */
  readonly logic: {
    /** An auxiliary right after an opening question word may end a line ("How did | the project start?"). */
    readonly questionAuxiliary: boolean;
    /** A break at a hesitation has its text penalties waived (scaled by the hesitation weight). */
    readonly hesitationWaiver: boolean;
    /**
     * An auxiliary used as the main verb, between a subject pronoun and an article or possessive, may end a line
     * ("You have | your robotics"). Left out: off.
     */
    readonly mainVerb?: boolean;
    /**
     * A subject pronoun that closes the head of a question ("Why don't you | just admit", "Can you | tell me") may
     * end a line. Left out: off.
     */
    readonly questionHead?: boolean;
  };
  /** The built-in profiles; they are also the two anchors rulesFor() interpolates between (16:9 and 9:16). */
  readonly profiles: Readonly<Record<'horizontal' | 'vertical', { readonly description: string; readonly aspect: string; readonly rules: Readonly<ProfileRules> }>>;
  /** The styling budget: most styled words (share of the words) and most `key` phrases per cue. */
  readonly styling: { readonly maxStyledRatio: number; readonly maxKeyPerCue: number };
}
