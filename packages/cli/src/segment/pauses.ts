// Pauses in the line cutter (docs/format/spec.md §16.3): seconds of silence between two words of one speaker.
// Thresholds live in the rule set (`pauses`).
//
// Captions show hesitations so viewers who cannot hear them can read them: a break at a real pause is good, even
// mid-sentence or after a short word. Long pauses show in time (a new cue), shorter ones in space (a line break):
//
// - `force` (1.5 s in rule set 1): always a new cue (the LLM prompt marks it "‖").
// - `cue` (1 s): a new cue, unless inside a name, number group or glossary term, or a piece of speech would be shown
//   for less than `minShown` (pauseCueBreaks). An LLM proposal may make it a line break, never hide it in a line.
// - a hesitation, from `floor` (0.4 s): its weight (hesitationWeight) scales the line-break bonus, the waiver of a
//   break's text penalties (short word, pronoun, near a sentence edge; never inside a name, number group or glossary
//   term) and the cost of a lone word next to it. Any hesitation may split a one-line cue. Shorter gaps are breaths
//   and timing noise: two engines disagree on about half of the 0.2–0.3 s gaps.

import type { RuleSet } from './rulesets/index.js';

/** Hesitation weight (0..1) of a pause of `gap` seconds: 0 below the floor, then linear from floorWeight to 1 at `full`. */
export function hesitationWeight(p: RuleSet['pauses'], gap: number): number {
  if (!(gap >= p.floor)) return 0;
  if (p.full <= p.floor) return 1;
  return Math.min(1, p.floorWeight + ((1 - p.floorWeight) * (gap - p.floor)) / (p.full - p.floor));
}
