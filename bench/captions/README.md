# Caption readability benchmark

Measures how captions are cut into lines and cues: where they break, whether the breaks show the speaker's
hesitations, how full and balanced the lines are, and how fast they read. Overtone is compared with a naive
baseline and a hosted service. Human subtitles are not the reference: they are not a gold standard, and layout has
no single right answer. Results: [RESULTS.md](RESULTS.md). Word error rates:
[../RESULTS.md](../RESULTS.md).

## How to run

From the repository root, after `npm run build`, with `ffmpeg` on the PATH and `OPENAI_API_KEY`,
`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` and `ELEVENLABS_API_KEY` in `.env`:

```bash
node bench/captions/fetch.mjs   # media, about 230 MB downloaded, 40 MB kept
node bench/captions/run.mjs     # live and billable: 20.8 audio minutes, about $0.60 with --llm-linebreaks (Overtone $0.50 at list price; ElevenLabs $0.08 at list price, about $0.12 at the rate its API reports); less without it
node bench/captions/score.mjs   # no API calls; writes data/results/results.md and scores.json
```

- `run.mjs` skips outputs that exist. `--fresh` runs again; `--clip <id>` and `--system overtone|elevenlabs` narrow
  it; `--llm-linebreaks` passes that flag to Overtone (the stored runs used it). `--refine` reruns only Overtone's
  LLM steps on the cached transcription and timing, in place (about $0.15–0.30). `--repeat <name>` does the same
  into `runs/<clip>/overtone-<name>/`, and `score.mjs` then reports the run-to-run variation. Up to 3 runs go in
  parallel. Keys are read from `.env`, never printed or stored. With `OVERTONE_DEBUG=1`, `cli.log` also shows how
  many of the LLM's proposed cues passed the checks, and why the others did not.
- Everything downloaded or generated goes to the git-ignored `bench/captions/data/`: audio, API outputs, the
  Overtone cache (`data/cache`, set in [overtone.captions.json](overtone.captions.json)) and results. Never commit
  media.
- [checksums.json](checksums.json) holds the SHA-256 of each clip's `audio.wav`; a re-fetch that differs fails with
  `CHECKSUM MISMATCH` (`--update-checksums` accepts a deliberate change).
- `score.mjs` reuses Overtone's own source (language packs, sentence, clause, name and number detection, the
  splitter): [lib/overtone-src.ts](lib/overtone-src.ts) is bundled with esbuild (installed with tsup) into
  `data/.build/` on every run, so the rules always match `packages/cli/src`.

## Systems

Every system is scored on the horizontal profile (42 characters × 2 lines, at most 17 characters per second, cues of
1–7 s) and the vertical profile (22 × 2).

| System | Text and times | Line and cue breaks |
|---|---|---|
| **Overtone default** | the words and times of the Overtone run (its `.overtone.json`): `overtone transcribe audio.wav --context "<one line>"` (OpenAI `gpt-transcribe` text, Azure Speech word times and speakers, OpenAI `gpt-6.1-sol` editor) | the rules alone at rule set 1: `score.mjs` runs the CLI's splitter (`buildProfile` without an LLM proposal, `segment/splitter.ts`) on those words, offline |
| **Overtone `--llm-linebreaks`** | the same words and times | the cues stored in the run's `.overtone.json`: the LLM proposes line and cue breaks, code checks each cue against the hard rules and the language's reading rules and falls back to the rules where it fails (`segment/proposal.ts`). Without `run.mjs --llm-linebreaks` this track equals the default |
| **Naive greedy** | the same words and times | greedy fill, typical of auto-captioning tools: words go on a line until the next would pass 42 characters, at most 2 lines; a new cue when the next word does not fit, the cue would pass 7 s, or after a pause over 1 s. Speakers are ignored. A cue runs from its first word's start to its last word's end |
| **ElevenLabs SRT** | ElevenLabs speech-to-text, `scribe_v2`, its own transcript (diarization on, audio-event tags off) | its built-in SRT export (`additional_formats`): `max_characters_per_line` 42 and `max_segment_chars` 84 (its defaults), other options at their defaults (cue at most 4 s, new cue after 0.8 s of silence). Vertical: 22 and 44, in the same request |
| **ElevenLabs SRT, 7 s / 1 s** | the same ElevenLabs transcription | a third SRT export in the same request with Overtone's limits: `max_segment_duration_s` 7, `segment_on_silence_longer_than_s` 1 (horizontal only) |

The two Overtone tracks and naive greedy share the text, so they differ only in breaking (and the naive cue
timing). ElevenLabs has its own text, punctuation and casing.

## Metrics

Every metric uses each system's own text and word times. A word is a whitespace token with a letter or digit; a
line's length is its displayed text. Word classes and sentence, clause, name and number detection come from
Overtone's language pack for the clip (`packages/cli/src/lang/<code>.ts`, `segment/groups.ts`), so the checks work
for every language with a pack. All clips here are English.

A **break** is a line end followed by more text: a line break inside a cue, or a cue break. The end of the last cue
is not a break. A word **ends a clause** when it ends a sentence or carries a comma, semicolon, colon or dash
(`clauseEndAt`).

**Pauses.** A break at a real pause shows the viewer a hesitation they cannot hear, so it is good even after a short
word. A break followed by a pause of 0.5 s or more (`HESITATION_PAUSE` in `lib/overtone-src.ts`; rule set 1 itself
treats pauses from 0.4 s as hesitations) is expressive, and the rule checks do not count it:

- the break checks (bad line ends, subject-pronoun ends, adjective + noun and name/number splits, both
  sentence-edge checks) skip it;
- a 1–3-word cue is exempt when both its edges are such a pause, a speaker change or the clip edge;
- a lone-word line is exempt when a line or cue break next to it is at such a pause;
- an unbalanced two-line cue is exempt when its line break is at such a pause.

The waived hits are reported separately ("breaks at hesitations"). A pause is the silence between two words in the
system's own word times: Overtone's (from the `.overtone.json`) for both Overtone tracks and greedy, ElevenLabs'
(from its saved response) for its SRT exports. The definitions come from an offline pause study on these clips (not
in the repository) at 0.5 s.

**Breaks** (% of breaks, without the breaks at a pause of 0.5 s or more)

| Metric | Definition |
|---|---|
| Bad line ends | The word before the break is an article, preposition, possessive, auxiliary or coordinating conjunction (the pack's `articles`, `prepositions`, `possessives`, `auxiliaries`, `lineStartConjunctions`) and does not end a clause. "is" in "that's what it is \| and" counts too (a known false positive, as in Overtone's own rule). |
| Subject-pronoun ends | The line ends on a subject pronoun or relative word that opens what follows ("we \| affectionately call"), as Overtone's `pronounEndAt` judges it. |
| Adjective + noun split | A likely adjective (the pack's adjective list or endings) before a lowercase content word ("operational \| pilot"), same test as Overtone's soft rule. |
| Name/number split | The break falls inside a name (a run of capitalized words, "Jim \| Dutton") or a number group ("one in \| five"), as `noBreakAfter` finds them (no glossary). |
| Sentence starts at line end | A new sentence starts in the last one or two words before the break ("That's correct. I \| think"), and the word before the break does not end a clause. |
| Sentence end carried over | The last one or two words of a sentence come right after the break ("the 2004 \| class."), and the word before the break does not end a clause. |

**Layout** (% of cues or lines; the pause exemptions apply to lone-word lines, 1–3-word cues and unbalanced cues)

| Metric | Definition |
|---|---|
| Two-line cues | Share of cues with two lines (informational). |
| Lone-word lines | A line of one word in a cue of two or more lines, except a top line whose word ends a clause ("Okay." / "Well,"). % of all lines. |
| 1–3-word cues | Cues of one to three words. "…not a whole sentence": of those, the ones that are not a complete sentence on their own ("Watch out!" is one; "every single" is not). % of all cues. |
| Lines over limit | Lines longer than the profile's characters per line (a single word that is too long is exempt). |
| Cues over 2 lines | Cues with more than two lines. |
| Unbalanced two-line cues | Two-line cues whose shorter line is less than half as long as the longer one. Also the median of bottom/top length. |

**Hesitations**

| Metric | Definition |
|---|---|
| Hesitations shown | Same-speaker pauses of 0.5–1.5 s that fall on a cue break or a line break, % of all such pauses (also split into cue and line breaks). Pauses of 1.5 s or more are left out: they end a cue in every system. |
| Hidden per minute | Such pauses inside a line, per minute of audio. |
| Breaks at hesitations | Breaks followed by a pause of 0.5 s or more, % of all breaks; and per rule, the hits these breaks would otherwise count as. |

**Timing** (% of cues)

| Metric | Definition |
|---|---|
| Median cps | Characters per second: the cue's characters (lines joined with one space) divided by its duration. |
| Cues > 17 cps, > 20 cps | Reading speed above 17 (the profile's maximum) and 20 characters per second. |
| Cues < 1 s, > 7 s | Cue duration. |

Clips are pooled by adding counts (micro-average), so long clips weigh more.

## Datasets

Three English clips, 20.8 minutes, used as audio only. Selection: [clips.json](clips.json). `fetch.mjs` downloads
the smallest official media rendition into an empty folder, extracts 16 kHz mono audio with ffmpeg and deletes the
media. Nothing is committed.

| Clip | Source | License | Kind | Duration |
|---|---|---|---|---:|
| `tears-of-steel` | Blender Foundation, *Tears of Steel* (2012), `TOS_DVDSTEREOMIX.aif` | CC BY 3.0 | film: dialogue, music, effects | 734.0 s |
| `nasa-oravec` | NASA, *Surprisingly STEM: Space Tire Engineer* (2023), `~mobile.mp4` | US public domain (NASA) | interview-style documentary | 289.2 s |
| `nasa-ayers` | NASA, *Connecting Classrooms to Space: Ham Radio Explainer* (2025), `~mobile.mp4` | US public domain (NASA) | talk to camera | 223.3 s |

### Tears of Steel

- **Source:** `https://download.blender.org/demo/movies/ToS/TOS_DVDSTEREOMIX.aif` (the official stereo mix of the
  whole film, 211 MB).
- **License:** the film is CC BY 3.0, "(CC) Blender Foundation | mango.blender.org". (The `copyright.txt` in the
  same folder covers only the soundtrack album, CC BY-ND 3.0.)
- **Caveats:** music and effects under the dialogue, little dialogue, long stretches without speech.

### NASA clips

- **Source:** `https://images.nasa.gov/details/SurprisinglySTEM_HeatherOravec_Social_jsc2023m000129` and
  `https://images.nasa.gov/details/jsc2025m000040_Connecting_Classrooms_to_Space-Ham_Radio_Explainer_by_NASA_Astronaut_Nichole_Ayers`;
  media from `images-assets.nasa.gov` (URLs in clips.json).
- **License:** NASA media is generally not subject to copyright in the United States
  ([NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)). It may not be used
  to imply NASA's endorsement; NASA does not endorse this project.
