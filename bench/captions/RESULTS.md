# Caption readability benchmark: results

Scored on **2026-10-18** for **rule set 1**, Overtone's default line cutting (the rules alone; `meta.rules` `"1"`).
Three English clips, 20.8 minutes. How to run, the systems and every metric: [README.md](README.md). Full tables
(per clip, counts): `data/results/results.md` and `scores.json`, written by `score.mjs` (git-ignored). Rescored on
2026-10-28 with the current CLI: the same breaks, but Overtone's default cues now end later, so its reading-speed and
short-cue figures dropped (cues over 17 cps 49.0% → 35.1%, under 1 s 4.3% → 1.4%).

- **Words and times:** Overtone with `overtone-captions@0.1.0` and its default providers then (OpenAI
  `gpt-transcribe`, Azure Speech, OpenAI `gpt-6.1-sol`). Transcription and timing ran on 2026-10-17; the LLM steps
  ran again on 2026-10-18 (`run.mjs --refine`, plus a second run with `--repeat run2`). ElevenLabs `scribe_v2` ran on
  2026-10-17.
- **Overtone default:** the CLI's splitter at rule set 1, run offline by `score.mjs` on those words and times. It is
  what `overtone transcribe` writes by default.
- **Overtone `--llm-linebreaks`:** the cues stored in the same runs, made by the LLM line cutting and checked by the
  rules of that day, before rule set 1. Shown for comparison; not rerun.

A line or cue break followed by a pause of 0.5 s or more shows a hesitation. The rule checks skip such breaks in
every system, each on its own word times, and report them in their own column. "Hesitations shown" is the share of a
speaker's 0.5–1.5 s pauses that fall on a break (pauses of 1.5 s or more end a cue in every system). The metrics keep
the 0.5 s threshold, although rule set 1 treats pauses from 0.4 s as hesitations.

## Summary

- **Overtone's breaks follow the reading rules.** On horizontal, 1 of 333 breaks (0.3%) ends on an article,
  preposition, possessive, auxiliary or "and/or/but" without a pause after it, none starts a new sentence at the end
  of a line, and 1 carries a sentence's last words over a break.
- **It shows the hesitations:** all 47 of the 0.5–1.5 s pauses on horizontal (21 as cue breaks, 26 as line breaks),
  46 of 47 on vertical.
- **Both baselines do much worse.** On the same words and times, greedy filling ends 28.8% of its breaks on such a
  word, starts a sentence at a line end at 9.7%, and shows 28% of the hesitations. ElevenLabs' SRT export ends 16.1%
  of its breaks on such a word, 10.7% of its cues are 1–3-word fragments that are not a sentence (Overtone 0.0%), and
  it shows 72% of the hesitations in its own timing.
- **The optional LLM line cutting adds little here, and it varies.** Two `--llm-linebreaks` runs: 0.0% and 0.3% bad
  line ends (rules only 0.3%), 8.1% and 6.9% unbalanced two-line cues (3.9%), 77% and 83% of the hesitations shown
  (100%). In the second run 23% of the proposed vertical cues passed the checks, against 54% in the first.
- **Reading speed is every system's weak spot:** 35% of Overtone's horizontal cues are faster than 17 characters per
  second (greedy 56%, ElevenLabs 66%), because all of them caption fast speech verbatim.

## Horizontal (42 × 2), all clips pooled

% of breaks, cues or lines. Breaks followed by a pause of 0.5 s or more are not counted in the first five columns.

| System | Bad line ends | Sentence starts at line end | Sentence end carried over | Lone-word lines | 1–3-word cues, not a sentence | Unbalanced two-line cues | Cues > 20 cps | Cues < 1 s | Hesitations shown | Breaks at hesitations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Overtone default** (rules only, rule set 1) | 0.3 | **0.0** | 0.3 | **0.0** | **0.0** | **3.9** | **18.3** | **1.4** | **100.0** | 32.4 |
| Overtone `--llm-linebreaks` (run 1, before rule set 1) | **0.0** | **0.0** | **0.0** | **0.0** | 0.5 | 8.1 | 19.8 | 3.8 | 76.6 | 29.2 |
| Naive greedy | 28.8 | 9.7 | 11.2 | 2.5 | 2.4 | 10.3 | 32.9 | 12.2 | 27.7 | 23.4 |
| ElevenLabs SRT (defaults) | 16.1 | 0.6 | 7.5 | 0.6 | 10.7 | 25.2 | 40.2 | 26.2 | 72.2 | 32.8 |
| ElevenLabs SRT (7 s / 1 s) | 13.4 | 1.1 | 5.7 | 0.3 | 16.0 | 16.2 | 41.4 | 27.0 | 62.0 | 31.3 |

- No system has lines over 42 characters, cues over 2 lines or cues over 7 s.
- Subject-pronoun line ends ("we | call"), adjective + noun splits and name/number splits are rare except in greedy
  filling (2.2%, 2.9%, 2.2%); Overtone has 0.3%, 0.9%, 0.0%.
- "Hesitations shown" counts each system's own pauses: 47 in Overtone's word times (half of them in Tears of
  Steel), 79 in ElevenLabs'. ElevenLabs' SRT export starts a new cue after 0.8 s of silence (1 s for the 7 s / 1 s
  export), greedy filling after 1 s.
- "ElevenLabs SRT (7 s / 1 s)" is the same transcription exported with Overtone's limits (cues up to 7 s, new cue
  after 1 s of silence) instead of its defaults (4 s, 0.8 s): fewer bad line ends, more fragment cues, fewer
  hesitations shown.
- Cues over 17 cps: Overtone 35.1%, `--llm-linebreaks` 48.1%, greedy 55.5%, ElevenLabs 66.0%. Greedy cues end at
  their last word (no extension) and ElevenLabs makes many cues under 1 s, so both read faster.

### Breaks at hesitations

Without the pause exemption, Overtone's horizontal bad line ends would be 2.7% (`--llm-linebreaks` run 1: 0.6%). The
table counts the rule hits the exemption waives, all clips pooled.

| Profile | System | Breaks at a pause ≥ 0.5 s | Bad line ends | Sentence edge | Lone-word lines | 1–3-word cues | Unbalanced |
|---|---|---:|---:|---:|---:|---:|---:|
| horizontal | Overtone default | 108 of 333 | 8 | 7 | 7 | 7 | 10 |
| horizontal | Overtone `--llm-linebreaks` (run 1) | 97 of 332 | 2 | 3 | 1 | 5 | 4 |
| horizontal | Naive greedy | 65 of 278 | 2 | 4 | 0 | 7 | 0 |
| horizontal | ElevenLabs SRT (defaults) | 118 of 360 | 1 | 2 | 1 | 10 | 6 |
| vertical | Overtone default | 107 of 584 | 7 | 6 | 6 | 6 | 7 |
| vertical | Overtone `--llm-linebreaks` (run 1) | 106 of 598 | 6 | 4 | 6 | 6 | 8 |
| vertical | Naive greedy | 70 of 510 | 4 | 5 | 0 | 8 | 0 |
| vertical | ElevenLabs SRT (22 / 44) | 124 of 606 | 1 | 3 | 1 | 10 | 1 |

Examples from Overtone's default layout (pause in ‖ ‖): "Working at NASA meant that I could ‖0.72‖ / use my
creativity and design process", "as a STEM career or STEM engineer that ‖0.64‖ / you don't know that even are out
there," and "Are you ready? Of ‖0.56‖ / course you're ready. You're a rock star.".

## Optional LLM line cutting (`--llm-linebreaks`), all clips pooled

The LLM line cutting adds little here, hides hesitations the rules show, and varies from run to run.

| Profile | Run | System | Bad line ends | Sentence end carried over | Lone-word lines | 1–3-word cues, not a sentence | Unbalanced two-line cues | Cues < 1 s | Hesitations shown | Cues | Cues identical to the default | Proposed cues used |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| horizontal | – | Overtone default (rule set 1) | 0.3 | 0.3 | 0.0 | 0.0 | 3.9 | 1.4 | 100.0 | 208 | – | – |
| horizontal | 1 | `--llm-linebreaks` | 0.0 | 0.0 | 0.0 | 0.5 | 8.1 | 3.8 | 76.6 | 212 | 51.9% | 155 of 220 |
| horizontal | 2 | `--llm-linebreaks` | 0.3 | 0.0 | 0.0 | 0.5 | 6.9 | 4.6 | 83.0 | 217 | 55.8% | 145 of 223 |
| vertical | – | Overtone default (rule set 1) | 2.2 | 5.3 | 1.2 | 6.8 | 9.5 | 9.8 | 97.9 | 325 | – | – |
| vertical | 1 | `--llm-linebreaks` | 1.7 | 6.2 | 1.5 | 8.2 | 10.4 | 11.1 | 95.7 | 342 | 64.0% | 189 of 349 |
| vertical | 2 | `--llm-linebreaks` | 1.9 | 5.9 | 1.5 | 8.6 | 9.8 | 13.0 | 93.6 | 339 | 77.3% | 87 of 379 |

Run 2 repeats only the LLM steps (`run.mjs --repeat run2`); the default layout is the same for both. "Proposed cues
used" comes from the CLI's debug log (`OVERTONE_DEBUG=1`): the LLM's cues that passed the checks; the rules of that
day re-cut the others. The runs did not store the proposals, so the LLM rows could not be re-merged with rule set 1.

- **The LLM hides short hesitations the rules show.** 10 of the 11 pauses its horizontal layout keeps inside a line
  are in Tears of Steel, in short exclamations on one line: "Be tender to her. ‖0.88‖ Be honest." or "Are you ready?
  Of ‖0.56‖ course you're ready.". The prompt asked for a break there, but the checks of that day insisted only at
  pauses of 1 s or more. On the two NASA clips it shows 23 of 24 (vertical: all 24).
- **Its proposals often break the rules, and how often depends on the run.** In run 2, 19 of 155 and 16 of 140
  proposed vertical cues on the two NASA clips passed (run 1: 88 of 143 and 48 of 124). About half the rejections
  are a line ending on a weak word with no pause after it; most others are neighbors re-cut with such a cue. Those
  requests ran at the default `low` reasoning effort and used 17 and 124 reasoning tokens (other line-cutting
  requests: up to 3,000). The checks catch these lines and the rules re-cut them, so the output stays clean, and the
  LLM adds little.
- **It reads the hesitation marks.** In both runs' proposals the LLM broke at 93 of the 96 marked hesitations on the
  NASA clips, but at only 63 of 92 in Tears of Steel. The checks rejected one cue per run for hiding a pause of 1 s
  or more ("We're out of ‖1.3 s‖ time." on one line). No response failed to parse.
- These metrics cannot see what an LLM may do better: keeping idioms and phrases together ("in a million | years"
  is a break no rule flags), or breaking by meaning. That needs a human preference test.

## Vertical (22 × 2), all clips pooled

Overtone still has by far the fewest bad line ends and sentence-edge cuts. Greedy filling has fewer fragment cues and
fewer unbalanced cues. Values in %.

| System | Bad line ends | Sentence starts at line end | Sentence end carried over | Lone-word lines | 1–3-word cues, not a sentence | Unbalanced two-line cues | Cues > 20 cps | Hesitations shown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Overtone default** (rules only, rule set 1) | 2.2 | 0.0 | 5.3 | 1.2 | 6.8 | 9.5 | 26.2 | 97.9 |
| Overtone `--llm-linebreaks` (run 1, before rule set 1) | 1.7 | 0.0 | 6.2 | 1.5 | 8.2 | 10.4 | 27.2 | 95.7 |
| Naive greedy | 30.6 | 9.4 | 13.7 | 2.5 | 5.7 | 6.0 | 31.9 | 36.2 |
| ElevenLabs SRT (22 / 44) | 22.6 | 1.2 | 13.4 | 5.9 | 23.9 | 18.1 | 43.3 | 79.7 |

Narrow lines leave less room: every system carries more sentence ends over a break, and Overtone makes more short
cues than on horizontal. Greedy filling fills every line, hence its fewer fragment cues (5.7% vs 6.8%). The bad-line-end
metric counts "have", "do" or "be" as an auxiliary also where it is the main verb, so a break rule set 1 allows,
such as "You have / your robotics,", counts here.

## Caveats

- **Small sample.** Three clips, 20.8 minutes, 280–360 breaks per system on horizontal, 47 hesitations in Overtone's
  timing. One standard error of a 10% rate on 300 breaks is about 1.7 points, so differences of a point or two (rules
  only vs `--llm-linebreaks` on bad line ends) are noise. The large gaps (Overtone vs greedy vs ElevenLabs) are not.
- **Each system is judged on its own text and word times.** ElevenLabs has its own punctuation and pauses (79
  against 47). Missing punctuation hides sentence edges (fewer "sentence" flags) and removes the clause-end
  exemption (more "bad line end" flags). Overtone and greedy share words and times.
- **The default layout was computed offline:** the same splitter `overtone transcribe` runs without
  `--llm-linebreaks`, at rule set 1, on the stored words, without a glossary (the runs had none). Not a new live run.
- **The pause exemption trusts the word times.** A break at a gap the recognizer made up is exempt too. Below 0.5 s,
  gaps are mostly ordinary phrase boundaries and timing noise, hence the 0.5 s threshold.
- **Tears of Steel has little dialogue** and many dramatic pauses: it holds half the hesitations, and it is where
  the LLM hides them.
- **Overtone's text on Tears of Steel came from its fallback.** `gpt-transcribe` returned 12 words for the whole
  film (58 after loudness normalization), so Overtone used Azure Speech's words as the text.
- **The greedy baseline ignores speakers** and ends each cue at its last word, which inflates its short-cue and
  reading-speed numbers a little; its break metrics do not depend on timing.
- **Two runs of Overtone's LLM steps,** which varied a lot. The default layout depends only on words and times.
- **English only.** The metrics would also work for Dutch; the detection-only packs (German, French, Spanish,
  Italian, Portuguese) have no word lists for the bad-line-end metric.

## Cost of this run

At list prices ([../PRICES.md](../PRICES.md); OpenAI's direct prices for `gpt-transcribe` and `gpt-6.1-sol` assumed
equal to the Azure Global list prices there):

| Item | Cost |
|---|---:|
| Overtone run 1, LLM steps only ($0.222), plus a second `gpt-transcribe` request for Tears of Steel ($0.055) | $0.28 |
| Overtone run 2, LLM steps only | $0.14 |
| **Total of 2026-10-18** | **about $0.42** |

Transcription, timing and ElevenLabs outputs come from the run of 2026-10-17 (about $0.65–0.70). The rule set 1
re-score made no API calls. The LLM costs include line-cutting requests, which the default does not make.
