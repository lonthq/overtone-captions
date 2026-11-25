import { RULESET_1 } from './1.js';
import { deepFreeze } from './freeze.js';
import type { RuleSet } from './types.js';

/**
 * Rule set 2. FROZEN: never change a value or the logic it selects. Improvements go into a new rule set (see
 * types.ts); test/rulesets-golden.test.ts fails when this one's output changes.
 *
 * Rule set 1, plus two rules for a sentence end followed by a pause of 0.55 s or more (pauses.sentenceCue): it
 * starts a new cue (an LLM proposal must end its cue there; the prompt marks it "‖"), and the cue before it is held
 * at most to the middle of the pause or 0.4 s before the next cue, whichever is later (layout.sentenceHold,
 * layout.minBlank). In rule set 1 such a pause weighed like a hesitation
 * mid-sentence, and a 0.6 s pause earned more as a line break than as a cue break, so a caption ran on from the end
 * of one sentence into the next ("…and she trusts her insurer more. / In Lont Studio,"); in films and talks that
 * pause is often also a scene change. Other pauses start a cue at 1 s, as in rule set 1.
 */
export const RULESET_2: RuleSet = deepFreeze({
  ...RULESET_1,
  id: '2',
  summary: 'rule set 1, plus: a sentence end before a pause of 0.55 s starts a cue, held at most to the middle of the pause or 0.4 s before the next cue',
  pauses: { ...RULESET_1.pauses, sentenceCue: 0.55 },
  layout: { ...RULESET_1.layout, sentenceHold: 0.5 },
});
