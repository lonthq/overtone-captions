# Held-out evaluation of Overtone 0.1.0: protocol

**Status:** written on 2026-10-19, before any material was chosen or any system was run. It is committed before
the first run. Any change after that is listed under [Changes](#changes), with the date and the reason.

This study compares the released version of Overtone with simpler ways to make captions, on media that none of
us tuned on. It asks viewers which captions are easier to read. The earlier benchmarks ([bench/RESULTS.md](../RESULTS.md),
[bench/captions/RESULTS.md](../captions/RESULTS.md)) were run while the 0.1.0 pipeline was developed (and rescored on
0.1.0), used public clips that the regression gate was tuned on, and checked rules, not readers.

## Questions

1. **Layout.** With the same words, are Overtone's caption cuts easier to read than a hosted service's SRT export,
   at 16:9 and at 9:16?
2. **The whole pipeline.** On unseen media, how do Overtone's default setups compare with simpler setups, on the
   words (word error rate) and on readability as viewers judge it?

Expected results, stated before the runs:

- **H1.** Viewers prefer D over B (Overtone's re-cut of the ElevenLabs SRT export, against the export itself).
- **H2.** Viewers prefer E over A (Overtone's default, against one OpenAI call cut by line length).
- **H3.** Viewers prefer E over B.
- **H4.** The word error rate of E and F is within 0.5 points of the best single engine (pooled). We expect no
  clear gain on the words.
- **H5.** D, E and F have fewer breaks on a weak word than A, B and C, on the metrics of
  [bench/captions](../captions/README.md#metrics).

## Version

- **Software.** `overtone-captions@0.1.0` as published on npm. Record the git commit and the npm tarball checksum
  in `bench/heldout/runs.json`.
- **Configuration.** A config written by `overtone init`, which pins rule set 1 and the default models. It is
  committed with the results.
- **Run window.** All systems run on all clips within 48 hours, with the model versions the providers report
  recorded per request.

## Material

- **Amount.** About 35 minutes in total, in English and Dutch (the two languages with full language packs), about
  half each, in the 10 clips below.
- **Genres,** in both languages where possible:
  1. an interview or podcast with two speakers;
  2. a vertical talking-head clip for social media, with one fast speaker;
  3. a product or explainer video with names, numbers and prices;
  4. a film scene or a clip with music under the speech;
  5. a meeting with three or more speakers.
- **Unseen.** Clips are recorded for this study, or they were published after 2026-07-01 under terms that allow
  this use: public domain, an open license, or a license that allows research use. Nothing from bench/, the gate
  fixtures (packages/cli/test/fixtures/bench) or examples/ is used.

### Clips

Each public excerpt is cut by the rule below, fixed before any system runs on it, with `cut.mjs`. Both ends move to
the middle of the nearest silence of 0.5 s or more within 30 s (`ffmpeg silencedetect`, at the first of −35, −30,
−25 and −20 dB that finds one). `clips.json` records each excerpt's source, position, threshold and SHA-256.

| Id | Language | Genre | Source and terms | Excerpt |
|---|---|---|---|---|
| en-podcast | EN | interview or podcast, 7 speakers, Canadian and Russian accents | NASA "Houston We Have a Podcast" episode 438, "Crew-13" (2026-09-25); NASA media, credit NASA | 5 min from 10:00 |
| en-briefing | EN | news conference: reporters asking questions | NASA Crew-13 crew news conference (2026-08-03); NASA media | 5 min from the middle of the recording |
| en-floor | EN | meeting: floor debate | US House floor, the first day after Labor Day 2026 with a debate on a bill (the House's own recording); public domain | 5 min from the start of that debate, by the Clerk's floor log |
| nl-debate | NL | meeting: debate with interruptions | Tweede Kamer, Algemene Politieke Beschouwingen (2026-09-16); Tweede Kamer licence, research use, credit the Tweede Kamer | 5 min from the first interruption in the first group leader's speech, by Debat Direct's speaker events |
| en-vertical, nl-vertical | EN, NL | vertical talking-head clip, one fast speaker | recorded for this study | 2–3 min each |
| nl-interview | NL | interview, two speakers | recorded for this study | 5 min |
| nl-product | NL | product or explainer video with names, numbers and prices | recorded for this study | 3 min |
| music-speech | EN or NL | speech with music under it | recorded for this study, with a CC-licensed music track | 3 min |

The recordings are cut by the same silence rule. A recording that is longer than its slot is cut from its start.

- **Music without speech.** Blender's *Singularity* (2026, CC BY) has music and no dialogue. The whole film checks
  that no captions are invented, and it is reported on its own.
- **Known hard datasets (secondary).** These are scored as a separate set and are not part of the primary
  analysis, because they may be in the engines' training data. Each comes with its own references.
  - Earnings-22 (earnings calls, many accents, CC BY-SA 4.0): the first three files of the set by file name,
    5 min from the start of each.
  - DiPCo (dinner party, far-field microphones, overlapping speech, CDLA-Permissive): the first two evaluation
    sessions by id, the first far-field channel, 5 min from 10:00.
  - PriMock57 (mock doctor consultations): the first three consultations by id, 5 min from the start.
- **Consent.** Every recorded speaker signs a release for the study and for publishing the transcript and short
  excerpts. A clip that cannot be published is still scored, and marked as such.
- **Frozen list.** `bench/heldout/clips.json` lists each clip (id, language, genre, duration, source, license,
  SHA-256 of the audio). It is frozen (`"status": "frozen"`) before the first full run, together with a reserve
  list. Until then it is a draft (`"status": "draft"`).
  - No clip is dropped after it has run.
  - A clip that cannot be processed for a technical reason (a broken file) is replaced by the next clip of the
    reserve list, and the replacement is listed under Changes.
- **Storage.** Media stay outside git; the list holds checksums and download or storage locations. Tweede Kamer
  video is deleted within one month of the download, as its licence requires; the transcripts, captions and
  scores are kept.

## References

- **Transcripts.** Each clip gets a verbatim transcript (fillers and false starts included) made from the audio
  without any system's output. A second person checks it against the audio.
- **Published transcripts as a start.** Where a source publishes a transcript made by people, it can be the
  starting point and is then made verbatim against the audio. This covers NASA's podcast transcript, the
  Handelingen of the Tweede Kamer and the Congressional Record.
- **Speaker turns.** The reference marks speaker turns, so a caption that spans a speaker change can be counted.
- **Normalizer.** Scoring uses the same normalizer as the earlier benchmark (`bench/lib/normalize.mjs`).
- **No subtitles as reference.** Human-made subtitles are not used as a reference for layout or timing: line and
  caption breaks have no single right answer, so viewers judge them.

## Systems

Each system runs on the clip's audio (the video track is used only for display) and produces captions for 16:9
(42 characters × 2 lines) and 9:16 (22 × 2).

| Id | System | Words and times | Caption cut |
|---|---|---|---|
| A | One OpenAI call | `whisper-1` with word timestamps | lines filled up to the length limit (the `naiveTrack` baseline of bench/captions); no speakers |
| B | One ElevenLabs call | ElevenLabs `scribe_v2`, diarization on | its own SRT export at its defaults (42/84 and 22/44 characters) |
| C | One Azure call | Azure AI Speech fast transcription, with speakers | lines filled up to the length limit |
| D | Overtone layout only | B's SRT | `overtone recut` (word times estimated from the cue times) |
| E | Overtone default | `overtone transcribe` (OpenAI `gpt-transcribe` and `gpt-6.1-sol`, Azure AI Speech) | rule set 1 |
| F | Overtone with ElevenLabs | E plus `ELEVENLABS_API_KEY` (Scribe as the second hearing) | rule set 1 |
| G | WhisperX (optional) | WhisperX with `large-v3`, alignment and pyannote diarization, on a rented GPU | its SRT output |

The word error rate is also reported for `gpt-transcribe` alone (the raw text of E's transcribe stage), as in
the earlier benchmark.

## Automatic metrics

- **Word error rate,** plain and formatted, per clip and pooled over words. Formatted keeps casing and `. , ?`.
- **Caption metrics,** for each system on its own words and times, for both cuts. These are the metrics of
  [bench/captions](../captions/README.md#metrics): bad line ends, the sentence-edge checks, hesitations shown,
  lone-word lines, 1–3-word fragments and reading speed.
- **Speaker changes inside a caption:** captions that span a speaker change of the reference, as a share of all
  captions.
- **Cost and speed:** cost per audio minute at list prices, and wall time per audio minute.
- **Not measured:** word timing precision, because the new material has no word-level reference times.
  Viewers judge timing indirectly.

## Human study

### Segments

- Each clip gives 2–3 segments of 20–40 s, 24–30 segments in all.
- They start at fixed points (25%, 50% and 75% of the clip), moved to the nearest silence of 0.5 s or more that
  `ffmpeg silencedetect` finds. The points are fixed before any output is seen.

### Trials

- A trial shows one segment at one aspect (16:9 or 9:16), twice, with the captions of two systems. The order is
  random and the versions are labeled only "Version 1" and "Version 2".
- Every version is shown in the same player and style: `videojs-overtone`, the `clean` pack, in plain mode, so
  the semantic styling plays no part. A system's SRT output becomes a profile with exactly its cues and lines,
  without any re-cutting.
- The compared pairs are D–B (the layout, with the same words), E–B and E–A.

### Questions per trial

1. Which version was easier to read? (Version 1 / Version 2 / no difference)
2. Which version showed better how it was said: the pauses, the hesitations and who was speaking? (same choices)
3. Did you notice a wrong word? (in version 1 / in version 2 / in both / in neither)
4. An optional comment.

### Viewing conditions

- **Hearing raters** answer question 1 with the sound off, then watch the pair again with the sound on for
  questions 2 and 3.
- **Deaf and hard-of-hearing raters** watch as they usually do.

### Raters

- 15–20 raters, each for about 30 minutes (20–24 trials).
- At least 5 of them are deaf or hard of hearing and use captions regularly. Their results are reported
  separately and in the pooled result.
- Raters judge clips in a language they are fluent in.
- No rater works at Lont or has worked on Overtone. Raters are paid.
- **Assignment.** Each rater sees each segment at most once. Segments, pairs and aspects are balanced with a
  Latin square, so that each combination of segment, pair and aspect gets at least two ratings.
- **Attention checks.** Two trials: one shows the same captions twice ("no difference" expected), and in one,
  one version's captions are 3 s late. A rater who fails both is excluded. There is no other exclusion rule.
- **Data.** Raters give consent, and only what the analysis needs is kept: language, self-reported hearing
  status, caption use and the answers.

### Analysis

- **Primary result:** for each of the three pairs, pooled over aspects, the share of question 1 answers that
  prefer the first system, among answers that are not "no difference". The share of "no difference" is reported
  with it.
  - The confidence intervals (95%) come from a logistic mixed model with random intercepts for rater and
    segment, or from a bootstrap over raters and segments if the model does not converge.
  - The three primary tests are corrected with Holm's method.
- **Secondary results:** per aspect, language, genre and rater group (deaf and hard of hearing, hearing), and
  questions 2 and 3.
- **Power.** About 140 judgments per pair are enough to detect a 60/40 preference, not a smaller one.

## Publishing

- Everything goes in `bench/heldout/`:
  - the anonymized ratings;
  - the per-clip metrics;
  - each system's caption files, where the license allows;
  - the scripts.
- `RESULTS.md` there reports every question, with the results where Overtone does worse given as much space as
  those where it does better. The README links to it.

## Changes

- **2026-10-20, a first run on the four public clips.** The four public clips ran before the own recordings
  existed, after this protocol was written, with `clips.json` still a draft without a reserve list. When the own
  recordings are added, `clips.json` is frozen and every system runs again on all clips within one 48-hour window,
  as the protocol says.
  - System A did not run because the OpenAI key had expired.
  - E and F used Azure OpenAI deployments of the same models (`gpt-transcribe`, `gpt-6.1-sol`).
  - Word error rates wait for the references. Only the caption metrics were scored (`score.mjs`).
- **2026-10-28, wording only.** The introduction no longer says the earlier benchmarks ran before 0.1.0 (they were
  rescored on it), and "Frozen list" and the 2026-10-20 entry now say that `clips.json` is still a draft. No change
  to the questions, systems, clips or analysis.
