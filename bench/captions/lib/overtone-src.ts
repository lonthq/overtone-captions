// The Overtone source helpers the caption benchmark reuses, so its rules are the CLI's own rules (word lists of the
// language packs, sentence/clause detection, name and number groups) and its deterministic layout is the CLI's
// splitter. lib/overtone.mjs bundles this file with esbuild into data/.build/ (git-ignored).
export { buildProfile } from '../../../packages/cli/src/segment/profile.js';
export { clauseEndAt, noBreakAfter, numberGroupEnds, plain, pronounEndAt, sentenceEndAt } from '../../../packages/cli/src/segment/groups.js';
export { getPack, langOf, rulesOf } from '../../../packages/cli/src/lang/index.js';
export { flattenTurns } from '../../../packages/cli/src/turns.js';
import { RULESETS } from '../../../packages/cli/src/segment/rulesets/index.js';
export { RULESETS };
/** A pause of at least this long always starts a new cue (rule set 1). */
export const FORCE_BREAK_PAUSE = RULESETS['1'].pauses.force;
/**
 * The metrics' threshold for an expressive break (lib/metrics.mjs): 0.5 s, the hesitation threshold when these metrics
 * were defined. Rule set 1 treats pauses from 0.4 s as hesitations; the metric keeps 0.5 s so results stay comparable.
 */
export const HESITATION_PAUSE = 0.5;
