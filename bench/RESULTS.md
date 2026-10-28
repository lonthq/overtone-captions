# Overtone benchmark

Overtone's text, word times, speakers and cost, measured against public references and against each engine it
combines. Clips and licenses: [DATASETS.md](DATASETS.md). Prices: [PRICES.md](PRICES.md). Line and cue breaks:
[captions/RESULTS.md](captions/RESULTS.md).

Default setup of every run, unless a section says otherwise:

- text: `azure-openai:gpt-transcribe`
- timing and speakers: `azure-speech` (fast transcription)
- LLM: `azure-openai:gpt-6.1-sol`
- profiles `horizontal,vertical`, a one-line genre context per clip, no glossary

Two setups: **no Scribe** (no ElevenLabs key, `--timing-second-opinion none`; gpt-transcribe and Azure Speech are
the hearings) and **with Scribe** (ElevenLabs Scribe as the second hearing for word times and the text vote).
Metrics: [Methodology](#methodology).

Results: [Release version](#release-version-2026-10-23) ·
[Open ASR Leaderboard sets](#open-asr-leaderboard-sets) · [Non-speech set](#non-speech-set) ·
[Word timing](#word-timing) · [t-WER and AS-WER](#t-wer-and-as-wer) ·
[MAI-Transcribe-2](#mai-transcribe-2-2026-10-26) · [Cost breakdown](#cost-breakdown-2026-10-19) ·
[Quick tests](#quick-tests-one-run-each) · [Loudness normalization](#loudness-normalization-2026-10-26) ·
[Caption layout](#caption-layout). Method: [Methodology](#methodology) · [Caveats](#caveats) ·
[Regression gate](#regression-gate) · [Reproduce](#reproduce).

## Release version (2026-10-23)

Overtone beats gpt-transcribe alone in every run: 5.3% WER against 6.2–6.5%, pooled over the 5 clips with text.

Main set: 6 clips, 20.1 minutes, 4 languages: two AMI meetings (headset mix, `Mix-Headset.wav`), one LibriSpeech
test-clean chapter, FLEURS read sentences in Dutch, German and Spanish. Overtone 0.1.0 at commit `d45e124` (plus
uncommitted changes to docs, the style gallery and a test, none in the pipeline), both setups, 3 runs each
(`bench/run.mjs --fresh`).

WER in %, 3-run means; Overtone's per-run values in brackets.

| Clip | Ref words | Overtone, no Scribe | Overtone, with Scribe | gpt-transcribe alone | Azure Speech alone |
|---|---:|---:|---:|---:|---:|
| `ami-es2004a`: meeting, scenario, 4 speakers | 736 | **13.0** (13.5, 12.6, 12.8) | 14.2 (13.9, 14.7, 14.1) | 14.0–14.5 | 15.4 |
| `ami-en2002a`: meeting, natural, 4 speakers | 957 | **32.8** (32.3, 32.8, 33.4) | 33.3 (34.0, 32.4, 33.4) | 100 (empty, 6 of 6 runs) | 42.9 |
| `libri-672-122797`: audiobook, 1 speaker | 427 | **0.5** (0.5, 0.5, 0.5) | 0.6 (0.5, 0.5, 0.7) | 0.5–0.6 | 0.7 |
| `fleurs-nl`: Dutch read speech | 402 | 2.5 (2.2, 2.7, 2.7) | **1.8** (2.0, 2.0, 1.5) | 5.2–5.7 | 9.8 |
| `fleurs-de`: German read speech | 294 | 2.2 (2.4, 1.7, 2.4) | **1.9** (1.7, 1.7, 2.4) | 2.3–2.4 | 2.4 |
| `fleurs-es`: Spanish read speech | 373 | **1.1** (1.1, 1.1, 1.1) | 1.2 (1.1, 1.3, 1.3) | 1.5–1.6 | 2.7 |
| **Pooled, all 6 clips** | 3189 | **13.6** | 13.9 | 34.3–34.6 | 18.3 |
| **Pooled, without `ami-en2002a`** | 2232 | **5.3** (5.4, 5.2, 5.3) | 5.6 (5.4, 5.7, 5.6) | 6.2–6.5 | 7.7 |

gpt-transcribe is the raw text stage of the same runs (a range over both setups, which sent their own requests).
Azure Speech gave the same words in every run except on `fleurs-nl` (9.7–10.0%; the table shows the mean).

- The gain over gpt-transcribe is largest on Dutch (2.5% against 5.2%; with Scribe 1.8% against 5.7%) and on the
  scenario meeting.
- gpt-transcribe returned an empty text for the quiet meeting `ami-en2002a` in every run. The retry sends the
  language the engines heard and got 604–716 words back; the vote filled in what Azure (and Scribe) heard: 32.8%
  against Azure's 42.9%. A test on 2026-10-23 (2 requests per setting) showed the language decides it: with
  `language: "en"` gpt-transcribe returned about 700 words, with or without the context prompt; without a language
  it returned nothing, also with loudness-normalized audio.
- Scribe did not lower the pooled WER (5.6% against 5.3%, within the run-to-run spread). It helped Dutch and German
  and cost a point on the scenario meeting. Its main gain is timing on films
  ([CLI README](../packages/cli/README.md)), which this set does not measure.
- Cost: $0.023–0.025 per audio minute without Scribe, $0.029 with Scribe (list prices, per run).

## Open ASR Leaderboard sets

Overtone beats every engine on LibriSpeech test-other (1.0% against 1.3–1.5% for gpt-transcribe). On the two
Earnings-22 calls it does not.

Short slices of two Open ASR Leaderboard test sets: one LibriSpeech test-other chapter and two 240 s windows of
Earnings-22 calls, reported apart so the main set stays comparable. Clips and selection:
[DATASETS.md](DATASETS.md#open-asr-leaderboard-sets-librispeech-test-other-earnings-22). Release version, both
setups, 3 runs each, 2026-10-23, together with the [non-speech set](#non-speech-set)
(`bench/runs/2026-10-23-new`, git-ignored). Both sets: 153 audio minutes, about $2.70 at Azure list prices plus
$0.30 for Scribe; failed and repeated attempts added roughly $0.50.

WER in %, 3-run means; Overtone's per-run values in brackets. Scored with our normalizer, so the numbers compare
the systems with each other, not with the leaderboard.

| Clip | Ref words | Overtone, no Scribe | Overtone, with Scribe | gpt-transcribe alone | Azure Speech alone | Scribe alone |
|---|---:|---:|---:|---:|---:|---:|
| `libri-other-7018-75788`: audiobook, test-other | 524 | failed in 3 of 3 runs | **1.0** (1.0, 1.0, 1.0) | 1.3–1.5 | 2.9 | 1.8 |
| `earnings22-4423872`: earnings call, Chile, 2 speakers | 552 | 6.9 (6.5, 6.9, 7.4) | 7.1 (6.9, 7.2, 7.2) | 7.4–8.3 | **6.5** | 6.6 |
| `earnings22-4351517`: earnings call, Indonesia, 5 speakers | 525 | 26.9 (26.9, 26.7, 27.0) | 27.3 (27.2, 27.0, 27.6) | 26.7–28.0 | 28.0 | **24.4** |
| **Pooled, 3 clips (with Scribe)** | 1601 | | 11.7 (11.6, 11.7, 11.9) | 12.0–12.2 | 12.4 | **10.8–11.1** |

- Earnings-22, Chilean call: 0.3–0.6 points above Azure and Scribe. Indonesian call: level with
  gpt-transcribe and Azure (about 27%), 3 points above Scribe (24.4%). The vote changes gpt-transcribe's text only
  where the hearings disagree; gpt-transcribe is the weakest engine on the Chilean call, and Scribe clearly the best
  on the Indonesian one. That call's WER comes from names (people, "Telkom", products), accents and letter-by-letter
  acronyms in the reference ("H S B C", "o m").
- Speakers: word speaker accuracy 99.5–100% for every system. All systems found 4 of the 5 speakers of the
  Indonesian window (the operator and an analyst merged).
- `libri-other-7018-75788` without Scribe: the CLI stopped in all 3 runs. Azure OpenAI's content filter refused an
  align-stage request (HTTP 400, "content management policy"; the chapter is a Sinbad story with "crushed in his
  skull"). With Scribe the vote sent other requests and all 3 runs passed.
- Cost: $0.019–0.027 per audio minute.

## Non-speech set

No engine invented a word on audio without speech, so the CLI stopped with "No words to caption" and wrote no
captions. The Whisper-style hallucinations from the literature ("Thank you for watching") did not occur.

Four generated 1-minute clips (`silence-60`, `noise-white-60`, `noise-pink-60`, `hum-60`) and *Spring*, an animated
film without dialogue. `music-then-speech` is 60 s of *Spring* followed by `fleurs-nl`.
[Details](DATASETS.md#non-speech-set). Release version, both setups, 3 runs each, 2026-10-23.

Words output after the WER normalizer; all 6 runs gave the same result:

| Clip | Minutes | Overtone | gpt-transcribe alone | Azure Speech alone | Scribe alone (with Scribe) |
|---|---:|---:|---:|---:|---:|
| `silence-60`, `noise-white-60`, `noise-pink-60`, `hum-60` | 1.0 each | 0 | 0 | 0 | 0 |
| `spring`: animated film without dialogue | 7.7 | 0 | 0 | 0 | 0 |
| **Clips with any words** | | **0 of 5** | **0 of 5** | **0 of 5** | **0 of 5** |

- `music-then-speech`: the speech WER matches `fleurs-nl` alone (Overtone 1.7–2.7% against 1.5–2.7%; Azure 8.7%
  against 9.7–10.0%).
- Every timed system placed exactly one word in the music. "Volgens", said at 60.0 s, starts at 0.62 s in Scribe's
  words and at 41.5 s in Azure's; Overtone took the time of its hearing, so the first caption came 59 s early with
  Scribe and 18 s early without.
- These runs predate the stray-fragment rule: a sentence's first 1–3 words more than 5 s before the rest, which no
  other engine heard at that time, get an unknown time just before the rest (`STRAY_FRAGMENT` in
  [hearings.ts](../packages/cli/src/hearings.ts)). On the gate's frozen hearings, "Volgens" starts at 60.47 s with
  and without Scribe, and the WER is unchanged. On the frozen Tears of Steel hearings without Scribe, cues more
  than 2 s off the official subtitles went from 8 to 4 (more than 1 s: 16 to 11); with Scribe nothing changed.

### Removing the music first does not help

Isolating the voice made things worse: the engines transcribed the processed music and effects as speech.

One run on 2026-10-24 (commit `36f8b79`, with Scribe): each clip went through ElevenLabs' Voice Isolator
(`/v1/audio-isolation`) and was then captioned as usual. The isolated audio has the same duration (within 0.02 s)
and is 2 ms behind the original, so word times stay comparable. The music in `music-then-speech` dropped 13 dB; it
did not disappear.

| Clip | Metric | Original | Isolated |
|---|---|---:|---:|
| `spring` (no dialogue) | words output: Overtone / Azure alone | 0 / 0 | 16 / 433 |
| `music-then-speech` | words placed in the music: Overtone / Azure / Scribe | 1 / 1 / 1 | 9 / 4 / 12 |
| Tears of Steel | WER against the official subtitles: Overtone | 17.5% | 128.5% |
| | output words (the subtitles have 334) | 355 | 709 |
| `libri-672-122797` (clean read speech) | WER: Overtone | 0.5% | 0.7% |

- The isolator turns music and effects into speech-like sound. On Tears of Steel the extra words are invented
  dialogue over the action scenes and the credits.
- It does not fix the first word timed into the music, and it costs $0.12 per audio minute (ElevenLabs' API price
  list, 2026-10-24), 3 to 6 times the whole pipeline.

## Word timing

Every engine starts words 40–100 ms later than the forced-alignment references on average. With Scribe, Overtone
takes Scribe's word times, which agree less with these references than Azure's.

The references are forced alignments, not hand-checked times: Mila's Montreal Forced Aligner for LibriSpeech, Rev's
alignment for Earnings-22, automatic alignment of the manual transcript for AMI. FLEURS has no word times. So these
metrics measure agreement with another aligner. [TIMIT](#against-human-checked-times-timit) repeats the measurement
against human-checked times, with close results. Run 1 of each setup of the release version (2026-10-23). Mean signed offsets in ms (positive: later than the
reference); definitions under [Metrics](#metrics).

| Clip | System | Within 100 ms | Mean signed start | Mean signed end | Start F1 at 100 ms |
|---|---|---:|---:|---:|---:|
| `libri-672-122797` (test-clean) | Overtone, no Scribe | 93% | +37 | +40 | 93% |
| | Azure Speech | 93% | +37 | +39 | 93% |
| `libri-other-7018-75788` | Overtone, with Scribe | 84% | +68 | +6 | 83% |
| | Azure Speech | 94% | +57 | +58 | 91% |
| | Scribe | 84% | +68 | +5 | 82% |
| `earnings22-4423872` | Overtone, no Scribe | 84% | +48 | +51 | 79% |
| | Overtone, with Scribe | 71% | +83 | −6 | 67% |
| | Azure Speech | 84% | +48 | +50 | 80% |
| | Scribe | 70% | +103 | +3 | 64% |
| `earnings22-4351517` | Overtone, no Scribe | 86% | +62 | +54 | 69% |
| | Overtone, with Scribe | 88% | +77 | +15 | 69% |
| | Azure Speech | 88% | +61 | +56 | 68% |
| | Scribe | 85% | +79 | +18 | 68% |

- Against TIMIT's human-checked times Azure is 31–43 ms late too, so the offset is not only an aligner bias.
- With Scribe, fewer starts are within 100 ms on `libri-other` (84% against 94%) and the Chilean call (71% against
  84%). Scribe ends words
  earlier (mean signed end close to 0). Its timing pays off on films with music
  ([Hearings](../docs/cli/pipeline.md#hearings)); these clips have none.
- AMI meetings (run 1): Overtone and Azure are level, about 70% start F1 at 100 ms on `ami-es2004a`, 54–56% on
  `ami-en2002a`.

### Against human-checked times (TIMIT)

91–94% of word starts are within 100 ms of human-checked times, 99–100% within 250 ms (LibriSpeech test-clean
against forced alignment: 93%). The forced-alignment results hold up, at least for clean read speech.

The [TIMIT sample](DATASETS.md#timit-sample-human-checked-word-times): 4 clips, 9.0 minutes, 16 speakers reading 10
sentences each, 1,388 words with LDC hand-verified times. One run on 2026-10-26, no Scribe, so Overtone's times are
Azure's. Correctly recognized words only; signed offsets in ms.

| Clip | System | Words | Median abs start error | Within 50 ms | Within 100 ms | Mean signed start | Mean signed end | Start F1 at 100 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `timit-dr1-dr2` | Overtone | 343 | 46 ms | 57% | 94% | +34 | +52 | 92% |
| | Azure Speech | 343 | 46 ms | 57% | 94% | +35 | +53 | 92% |
| `timit-dr3-dr4` | Overtone | 330 | 46 ms | 54% | 91% | +43 | +50 | 88% |
| | Azure Speech | 338 | 46 ms | 54% | 91% | +43 | +50 | 90% |
| `timit-dr5-dr6` | Overtone | 338 | 44 ms | 56% | 91% | +31 | +49 | 88% |
| | Azure Speech | 348 | 44 ms | 57% | 91% | +31 | +49 | 90% |
| `timit-dr7-dr8` | Overtone | 341 | 40 ms | 60% | 93% | +33 | +50 | 92% |
| | Azure Speech | 339 | 40 ms | 60% | 93% | +32 | +49 | 92% |

- Words start 31–43 ms and end about 50 ms later than TIMIT marks them. TIMIT starts a word at its first phone,
  including a stop closure ("dark" starts at the silence before the "d"), which explains part of the start offset.
- Overtone's non-exact words (an LLM edit, a merged or interpolated word) are timed no worse than the rest, except
  one interpolated word (258 ms off).
- WER (pooled): Overtone 3.0%, gpt-transcribe alone 3.7%, Azure Speech alone 1.9%. TIMIT is very likely in the
  engines' training data, so this says little. Speakers: all 4 found on every clip, 100% word speaker accuracy.
- Cost: $0.021 per audio minute, $0.19 for the 9 minutes.

## t-WER and AS-WER

Few of Overtone's words land in the wrong reference segment. Its captions lose up to 8 points, mostly where cues
cross sentence and speaker turns.

`bench/suber.mjs` scores text and timing together with AppTek's SubER tool (`subtitle-edit-rate`, Apache-2.0).
**t-WER** puts each system word in the reference cue (segment) its time falls in and counts errors per cue, so a
right word at a wrong time is an error. **AS-WER** re-segments by text and ignores time; it equals our WER within
0.1 points on every clip (a cross-check of `score.mjs`). The SubER score itself is not used: it compares line breaks
with a reference subtitle file, and human subtitles are not our reference ([captions/README.md](captions/README.md)).

In %, means of 3 release runs; the AMI, test-clean and Dutch rows are run 1 without Scribe.

| Clip | Reference cues | Overtone words | Overtone captions | Azure Speech | Scribe | AS-WER of Overtone |
|---|---:|---:|---:|---:|---:|---:|
| `ami-es2004a` | 11 | 13.7 | 15.1 | 15.6 | | 13.5 |
| `ami-en2002a` | 25 | 36.3 | 38.2 | 43.7 | | 32.3 |
| `libri-672-122797` | 23 | 0.5 | 1.4 | 0.7 | | 0.5 |
| `fleurs-nl` | 18 | 4.7 | 7.5 | 11.7 | | 2.2 |
| `libri-other-7018-75788` (with Scribe) | 18 | 1.0 | 1.7 | 2.9 | 1.8 | 1.0 |
| `earnings22-4423872`, no Scribe / with Scribe | 26 | 8.7 / 8.0 | 13.6 / 12.3 | 8.3 | 7.2 | 6.9 / 7.1 |
| `earnings22-4351517`, no Scribe / with Scribe | 35 | 27.6 / 26.9 | 34.7 / 33.8 | 28.6 | 24.1 | 26.9 / 27.3 |

- Overtone's words lose 0–2 points from WER to t-WER on most clips (Dutch 2.5, the natural meeting 4.0).
- Overtone's captions are horizontal cues, each word placed by the tool inside its cue. A cue of up to 7 s that
  crosses a sentence or speaker change puts its edge words in the wrong reference segment, so this column mostly
  measures how well cues follow sentence and speaker turns.
- AMI speakers overlap, so overlapping segments are merged into one reference cue (11 and 25 cues for 220 s). On
  AMI, t-WER is a coarse timing check.

## MAI-Transcribe-2 (2026-10-26)

Pooled over all 9 clips, MAI-Transcribe-2 alone (13.1% WER) is level with Overtone with Scribe (13.2%) and behind
Scribe alone (12.6%). Its word starts are the least exact of the three timing engines.

MAI-Transcribe-2 alone, through the `azure-mai` provider (word timestamps, diarization, verbatim style), on all 15
bench clips and the 3 videos of the caption benchmark: 67.9 audio minutes, one run. Same 16 kHz WAV and options as
the other engines in the release runs (no language, no glossary). The other columns are not new runs: Overtone is
the mean of the 3 release runs, each engine alone its answer in run 1. Azure AI Foundry resource in Sweden Central.
The scripts are not in the repository.

### WER (plain, %, lower is better)

| Clip | Ref words | Overtone, no Scribe | Overtone, with Scribe | gpt-transcribe alone | Azure Speech alone | Scribe alone | MAI-Transcribe-2 alone |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ami-es2004a`: meeting, scenario, 4 speakers | 738 | **13.0** | 14.2 | 14.4 | 15.4 | 14.7 | 16.2 |
| `ami-en2002a`: meeting, natural, 4 speakers | 939 | 32.8 | 33.3 | 100 (empty) | 42.9 | **29.8** | 30.9 |
| `libri-672-122797`: audiobook, test-clean | 427 | **0.5** | **0.5** | 0.7 | 0.7 | 0.7 | **0.5** |
| `fleurs-nl`: Dutch read speech | 399 | 2.6 | **1.8** | 5.5 | 9.7 | 3.7 | 2.7 |
| `fleurs-de`: German read speech | 292 | 2.2 | 1.9 | 1.7 | 2.4 | 2.7 | **1.0** |
| `fleurs-es`: Spanish read speech | 373 | **1.1** | 1.3 | 1.9 | 2.7 | 2.7 | 1.3 |
| `libri-other-7018-75788`: audiobook, test-other | 527 | failed | **1.0** | 1.5 | 2.9 | 1.7 | 2.7 |
| `earnings22-4423872`: earnings call, Chile, 2 speakers | 567 | 6.9 | 7.1 | 7.4 | **6.5** | **6.5** | 6.7 |
| `earnings22-4351517`: earnings call, Indonesia, 5 speakers | 539 | 26.9 | 27.3 | 27.2 | 28.0 | **24.4** | 26.5 |
| **Pooled, all 9 clips** | 4790 | 14.3 | 13.2 | 27.0 | 16.3 | **12.6** | 13.1 |
| **Pooled, without `ami-en2002a`** | 3833 | 9.0 | **8.1** | 8.7 | 9.7 | 8.3 | 8.6 |

The pooled "Overtone, no Scribe" cells leave out `libri-other-7018-75788`. "Ref words" counts the reference's raw
words, so some rows differ slightly from the tables above; the pooled rows and every WER use the normalized words,
the same counts as the tables above (4790 = 3189 + 1601).

Formatted WER (case and `.` `,` `?` kept): MAI-Transcribe-2 is best on 5 of 9 clips (`ami-en2002a` 40.0%,
`libri-672-122797` 13.2%, `fleurs-de` 3.0%, `fleurs-es` 5.8%, `earnings22-4423872` 12.7%). On `ami-es2004a` it
scores 27.3%, against 20.9% for Overtone without Scribe.

### Word timing and speakers

Start F1 at 100 ms against the forced-alignment references (missed and inserted words count against it) and word
speaker accuracy:

| Clip | Azure Speech | Scribe | MAI-Transcribe-2 | Overtone, with Scribe |
|---|---:|---:|---:|---:|
| `libri-672-122797`: start F1 | **92.7%** | 66.8% | 56.1% | 67.4% |
| `libri-other-7018-75788`: start F1 | **90.8%** | 82.2% | 70.9% | 82.8% |
| `earnings22-4423872`: start F1 | **79.5%** | 64.2% | 52.5% | 66.8% |
| `earnings22-4351517`: start F1 | 68.3% | 67.9% | 57.3% | **68.9%** |
| `ami-es2004a`: start F1 | 70.4% | 76.9% | 68.9% | **78.8%** |
| `ami-en2002a`: start F1 | 56.0% | **65.8%** | 62.3% | 65.2% |
| `ami-es2004a`: speakers found (4) / word speaker accuracy | 4 / 98.5% | 4 / 98.4% | 3 / 94.5% | 4 / **98.7%** |
| `ami-en2002a`: speakers found (4) / word speaker accuracy | 4 / 92.3% | 4 / 92.6% | 4 / **97.2%** | 4 / 90.7% |
| `earnings22-4351517`: speakers found (5) / word speaker accuracy | 4 / **100%** | 4 / 99.5% | 5 / 98.8% | 4 / 99.5% |

- MAI-Transcribe-2's word starts: 56–79% within 100 ms, against 79–94% for Azure Speech. As a timing provider it would place words later than Azure on read speech.
- It was the only engine to find all 5 speakers of the Indonesian call, and the best at attributing words in the
  natural meeting. It merged two of the four speakers of the scenario meeting.

### Non-speech and videos

| Clip | Overtone | Azure Speech | Scribe | MAI-Transcribe-2 |
|---|---:|---:|---:|---:|
| silence, white noise, pink noise, hum (1 min each): words output | 0 | 0 | 0 | 0 |
| `spring` (7.7 min, no dialogue): words output | 0 | 0 | 0 | 1 |
| `music-then-speech`: WER of the speech / start of the first word (speech at 60 s) | 1.7% / 0.62 s | 8.7% / 41.51 s | 3.2% / 0.62 s | 3.7% / 54.16 s |
| Tears of Steel: WER against the official subtitles | 17.5% | 31.4% | **15.5%** | 18.1% |
| `nasa-ayers`: WER against the published captions | 5.7% | | **0.9%** | 2.1% |
| `nasa-oravec`: WER against the published captions | **1.6%** | | 2.4% | 1.8% |

Every engine placed one word in the music of `music-then-speech`. The subtitles and captions are not verbatim, so
the video rows show differences, not true error rates. gpt-transcribe returned an empty answer on Tears of Steel in
its run; Azure Speech and gpt-transcribe alone were not stored for the NASA videos.

### Speed and price

68 audio minutes took 46 s of requests (0.7 s per audio minute, upload included, 3 requests at a time). List price
$0.54 per audio hour (Azure Retail Prices API, meter "MAI-Transcribe-2 AzSp Audio", Sweden Central and North Europe,
retrieved 2026-10-26), against $0.36 for Azure Speech fast transcription, $0.27 for gpt-transcribe and $0.22 for
Scribe.

## Cost breakdown (2026-10-19)

Over 37.8 audio minutes, Overtone cost $0.021 per audio minute by default and $0.025 with the ElevenLabs key. The
LLM cost follows the words, so dense speech costs more.

Measured on the live runs of [examples/output](../examples/output/README.md): the NASA interview and the three
Blender films, 37.8 audio minutes, each without and with `ELEVENLABS_API_KEY` (`azure-openai:gpt-transcribe`,
`azure-speech`, `azure-openai:gpt-6.1-sol`, ElevenLabs `scribe_v2` with the glossary as keyterms; rules-only line
cutting), at the list prices of [PRICES.md](PRICES.md). A preload like [lib/meter.mjs](lib/meter.mjs) recorded each
request's billed audio seconds, token usage and LLM schema name. Requests the second run answered from the request
cache are counted once, as one run of each setup would send them. A retry the current code no longer sends is left
out.

| Per audio minute | Interview, default | Interview, with ElevenLabs | Films, default | Films, with ElevenLabs |
|---|---:|---:|---:|---:|
| gpt-transcribe | $0.0045 | $0.0045 | $0.0045 | $0.0045 |
| gpt-transcribe again, for an empty answer | none | none | $0.0050 | $0.0050 |
| Azure AI Speech | $0.0060 | $0.0060 | $0.0060 | $0.0060 |
| ElevenLabs Scribe (keyterms included) | none | $0.0045 | none | $0.0045 |
| Snippets (timing re-listens by the engines, vote re-listens by gpt-transcribe) | $0.0013 | $0.0034 | $0.0018 | $0.0009 |
| LLM editor: corrections and speakers (effort medium), styling (low) | $0.0105 | $0.0100 | $0.0019 | $0.0019 |
| LLM chooser of the text vote (low) | $0.0034 | $0.0101 | $0.0011 | $0.0018 |
| **Total** | **$0.026** | **$0.039** | **$0.020** | **$0.025** |

The interview is 2.4 minutes with 467–469 words; the films 35.4 minutes with 1,018–1,043 words.

- Words per minute: 193 in the interview, 29 in the films. By default the LLM is 54%
  of the interview's cost and 15% of the films'. No LLM request read from the prompt cache.
- The key adds $0.004–0.013 per audio minute: Scribe's $0.0045, plus a bigger vote on dense speech. With three
  hearings the interview had 19 disagreement regions instead of 7, and 3 chooser requests instead of 1. On the
  films Scribe heard what Azure missed, so fewer timing snippets were needed.
- Every film's first answer was empty (no language sent, a music or effects intro), so the film was billed again:
  Tears of Steel and Elephants Dream once, Cosmos Laundromat about 1.3 times more (the whole film, then the part
  with speech). Without that, the films cost $0.015 (default) and $0.020 (with the key) per audio minute.
- Context inference (no `--context`) adds one request: $0.003 on the interview (810 input, 144 output tokens).
- Short clips cost more per minute, because every LLM request carries the same instructions. The 18-second sample
  came to $0.041 per minute by default and $0.037 with the key.
- ElevenLabs' `fiat-cost-before-overages` header said $0.0070 per audio minute for these requests with keyterms,
  above the list price ([PRICES.md](PRICES.md)).

## Quick tests (one run each)

Three tests on 2026-10-24, release version (commit `36f8b79`, default setup with `ELEVENLABS_API_KEY`). The scripts
are not in the repository. The fourth test that day, the Voice Isolator, is under
[Non-speech set](#removing-the-music-first-does-not-help).

### The engines' confidence does not find the wrong words

Scribe's word confidence (`exp(logprob)`) on the 13 clips where it is recorded, and on clips with a reference, the
share of right and wrong words (substitutions and insertions) below 0.9:

| | Clips | Median confidence | Right words below 0.9 | Wrong words below 0.9 |
|---|---:|---:|---:|---:|
| Scribe | 13 (10 with a reference) | 1.000 on every clip | about 2% | about 20% |

- A wrong word is about 10 times as likely as a right one to score below 0.9, but about 4 in 5 wrong words still
  score 0.9 or higher. The Blender films (likely in the training data) look like the meetings and the read speech.
- Azure Speech gives one confidence per phrase (9 distinct values over 625 words of `ami-es2004a`). gpt-transcribe,
  as Overtone calls it, returns text only.
- For NASA and Tears of Steel the reference is the published captions, which are not verbatim, so some "wrong" words
  are different wording.

### Read speech and conversation have different winners

WER of one run per clip, each engine alone from the same run:

| Kind of speech | Clips | Best |
|---|---|---|
| Read or scripted | the 3 FLEURS clips, both LibriSpeech clips, `nasa-oravec`, `music-then-speech` | Overtone, on all 7 |
| Conversation | both AMI meetings, both Earnings-22 windows | Scribe alone on 3; on the Chilean call Azure and Scribe tie (6.5%). Overtone is 0.4 to 4 points behind the best engine |

- Bandwidth (energy above 4 kHz), speaking rate and number of speakers do not separate the groups.
- The difference is mostly style. gpt-transcribe, Overtone's text base, leaves out repeated words and false starts
  ("on the… on the", "I, we were") that the verbatim references and Scribe write down; actual mishearings are about
  equal. On the Chilean call gpt-transcribe left out 23 words (13 of them a repeated word), Scribe 4.
- With repetitions removed from the reference and every output, the gap disappears on `ami-es2004a` (both 14.1%)
  and reverses on the Chilean call (Overtone 3.9%, Scribe 5.6%). It stays, smaller, on the Indonesian call (26.3%
  against 23.9%) and on `ami-en2002a` (29.4% against 26.7%). The references do not mark other false starts, so this
  is a lower bound for the effect of style.
- A prompt does not change it: with "Transcribe verbatim: … including repeated words, false starts and restarts"
  (and language `en`), gpt-transcribe left out the same repeated words on all 4 conversational clips (tried 4 times
  on `ami-en2002a`).

### The engines vary from run to run

- Tears of Steel, 3:30, "Go! Move your asses!": gpt-transcribe heard "Go, you bastards". On 2026-10-19 Azure also
  heard "Move your asses" and the vote changed the text. On 2026-10-24 Azure heard nothing there, only Scribe
  disagreed, and the vote kept the text.
- Cosmos Laundromat: on 2026-10-19 a retry of the empty first answer brought gpt-transcribe's text back. On
  2026-10-24 every retry stayed empty, and the text came from Scribe's words (`meta.fallbacks`).
- `ami-en2002a`: with language `en`, 4 of 5 requests answered; without a language, none.

## Loudness normalization (2026-10-26)

Normalization helps Azure Speech alone (the same answer in both runs, so not noise). It does not change Overtone's
WER, so it stays off by default.

`--normalize-loudness` runs ffmpeg's `loudnorm` (EBU R128, single pass) before any engine hears the audio. Tested
because quiet, uneven recordings such as `ami-en2002a` are hard to hear. Setup: no Scribe
(`--timing-second-opinion none`), 2 runs with and 2 without, on the 9 speech clips (main, Open ASR Leaderboard and
extra sets, 31.2 minutes) and the non-speech set. CLI build: working tree of 2026-10-26.

WER in %, pooled over the 9 speech clips (run 1 / run 2):

| System | With normalization | Without |
|---|---:|---:|
| Overtone | 13.1 / 12.7 | 12.9 / 12.8 |
| gpt-transcribe alone | 27.0 / 26.8 | 26.9 / 27.0 |
| Azure Speech alone | 15.7 / 15.7 | 16.3 / 16.3 |

Per clip, where the engines moved:

| Clip | System | With | Without |
|---|---|---:|---:|
| `fleurs-nl` | Azure Speech alone | 6.0 / 6.5 | 10.0 / 10.0 |
| `fleurs-nl` | gpt-transcribe alone | 4.0 / 3.5 | 5.0 / 6.2 |
| `ami-en2002a` | Azure Speech alone | 41.9 / 41.9 | 42.9 / 42.9 |
| `ami-en2002a` | Overtone | 32.7 / 32.0 | 32.1 / 32.7 |
| `ami-es2004a` | Overtone | 14.3 / 13.0 | 13.7 / 12.4 |

Overtone's word starts within 100 ms of the reference, in % (run 1 / run 2):

| Clip | With | Without |
|---|---:|---:|
| `ami-es2004a` | 84.2 / 84.0 | 78.0 / 78.2 |
| `ami-en2002a` | 65.6 / 66.1 | 69.4 / 69.2 |
| `libri-672-122797` | 91.1 / 90.8 | 92.9 / 92.9 |
| `libri-other-7018-75788` | 93.4 / 93.6 | 93.4 / 93.4 |
| `earnings22-4423872` | 87.3 / 87.5 | 84.0 / 84.0 |
| `earnings22-4351517` | 86.5 / 86.4 | 86.8 / 86.7 |

- gpt-transcribe still returns nothing for `ami-en2002a`: that clip fails on language detection, not loudness
  ([Release version](#release-version-2026-10-23)).
- Word timing moves both ways: better on one AMI meeting and one Earnings-22 call, worse on the other meeting and
  the test-clean chapter.
- No engine wrote words on silence, noise or hum, and music before speech still gave no words.

## Caption layout

Line and cue breaks have their own benchmark: [captions/RESULTS.md](captions/RESULTS.md). With the default line
cutting (rules alone, rule set 1, horizontal), 0.3% of Overtone's breaks end on a word a line should not end on,
against 16.1% for ElevenLabs' SRT export and 28.8% for greedy line filling (breaks at a pause of 0.5 s or more are
not counted: they show a hesitation). Overtone shows 100% of the 0.5–1.5 s hesitations as a line or caption break
(vertical 98%), ElevenLabs 72%, greedy filling 28%. The optional LLM line cutting (`--llm-linebreaks`) showed 77–83%
in two runs.

## Methodology

### Systems

All systems in a table come from the same run per clip, so they share the audio and the language choice (except
the MAI-Transcribe-2 section). Each run is scored the same way; 3-run tables give the mean of those scores.

- **Overtone:** the words of the final `.overtone.json` (text after the editor, aligned times, turn speaker).
- **gpt-transcribe alone:** the raw transcribe answers from the CLI's request cache
  (`<cache>/<hash>/requests/text-*.json`, chunks joined), with the same context prompt as Overtone. No times or speakers. On `ami-en2002a`: the empty first
  answer, before the retry.
- **Azure Speech alone:** the words of the timing request (`requests/timing-*.json`): display text with punctuation, times and
  diarized speakers. Its locale came from the language detected in the gpt-transcribe text (`en-US`, `nl-NL`,
  `de-DE`, `es-ES`; the Spanish clip is Latin American Spanish, and Azure scored 2.7% in every run). On
  `ami-en2002a` there was no text to detect from, so Azure detected the language itself.
- **Scribe alone:** Scribe's words in the same run, from the request cache (`requests/speech-*.json`). Its cost is the rate in each
  response's `fiat-cost-before-overages` header.

### Metrics

**Plain WER.** Word-level Levenshtein distance ÷ reference words, after a normalizer
([lib/normalize.mjs](lib/normalize.mjs)) on both sides. English uses a subset of Whisper's `EnglishTextNormalizer`:

- Unicode NFKC, lowercase.
- Markup in `[…]` and `<…>` removed. Unlike Whisper, text in `(…)` is kept: FLEURS has spoken content in
  parentheses.
- Fillers removed: hmm, mm, mhm, mmm, uh, um.
- Contractions expanded as Whisper does: n't → not, 're → are, 'll → will, 've → have, 'm → am, 'd → would,
  won't → will not, can't → can not.
- About 65 British spellings mapped to American (Whisper's map has about 1,700). "okay" → "ok".
- Spelled-out numbers → digits, including "and" inside a number and decimals ("one hundred and five" → 105, "two
  point five" → 2.5). Ordinals and paired years ("nineteen ninety") are not converted.
- `1,000` → `1000`, `$5` → `5 dollars`, `%` → `percent`.
- Hyphens and slashes split words; apostrophes removed (`it's` → `its`); diacritics folded.

Dutch, German and Spanish use a basic normalizer: the same casing, markup, symbol, apostrophe and diacritic rules;
fillers eh, ehm, uh, uhm, hm, hmm, mm, mmm (Dutch only); `10.000` → `10000` and `2,5` → `2.5`; no number-word
conversion ("tienduizend" against "10.000" is an error).

**Formatted WER.** The same, but casing is kept and `. , ?` are separate tokens (`!` counts as `.`; `;` and `:` as
`,`; quotes, brackets and dashes dropped). The difference from plain WER is casing and punctuation only.

**References.**

- AMI: the manual words of the window, ordered by utterance (segment start). Punctuation attaches to the word
  before it; truncated words and non-word events are dropped.
- LibriSpeech-PC: field `text`.
- FLEURS: field `raw_transcription`.
- Earnings-22: Rev's force-aligned reference of the window ([DATASETS.md](DATASETS.md)).

**Confidence intervals.** Bootstrap over reference segments (AMI utterances, LibriSpeech utterances, FLEURS
sentences), 2000 resamples. Each edit is charged to the segment of its reference word, an insertion to the segment
of the reference word before it. Paired differences resample the same segments for both systems. Segments within a
clip are not independent, so the intervals are optimistic.

**Timing.** Hypothesis and reference are aligned on plain-normalized tokens. For exact token matches the error is
|hyp start − ref start| (likewise for end). Reference words without a time are skipped. The references are forced
alignments ([Word timing](#word-timing)), except TIMIT.

- Within 50 / 100 / 250 ms: share of matched words whose start error is at most that.
- Mean signed start and end: hyp − ref, averaged; positive is later.
- Start F1 at 50 and 100 ms (as in FA-Bench, 2026): a hit is a matched word whose start is within the tolerance;
  precision is hits over the system's timed words, recall hits over the reference's timed words, so missed and
  inserted words count against it.

**Speakers.**

- Word speaker accuracy: over correctly recognized words, the share with the right speaker under the best
  one-to-one mapping of hypothesis to reference speakers.
- cpWER: each speaker's words concatenated, the speaker mapping with the lowest total edit distance chosen, that
  distance ÷ reference words. An unmatched speaker counts fully as deletions or insertions.

**Cost.** List prices × audio minutes, plus the LLM tokens [lib/meter.mjs](lib/meter.mjs) recorded from each
response's `usage` ([how](PRICES.md#how-the-cost-is-computed)).

## Caveats

- Small sample: the main set is 20.1 minutes, 6 clips, 3,189 reference words, with only 2 meetings, both English.
  Most per-clip differences are within run-to-run variation.
- Three runs show the noise but do not remove it. gpt-transcribe moved by up to 1.8 points between runs on the same
  audio; Azure Speech by at most 0.3.
- The clips are public, so the models may have trained on them; LibriSpeech's 0.5% WER may reflect that. A held-out
  evaluation on unseen material: [heldout/PROTOCOL.md](heldout/PROTOCOL.md).
- Domain: the meetings are British English (AMI, 2005) in the headset mix. The read speech is clean. FLEURS clips
  are unrelated sentences, which give the editor little context.
- AMI transcribes backchannels ("yeah", "mm-hmm") in overlapping speech. Both default engines drop many of them,
  which raises meeting WER for every system alike. Punctuation conventions differ by dataset, which affects
  formatted WER.
- The normalizer is a subset of Whisper's. Leftovers such as "wood cutters" against "woodcutters", or Dutch number
  words, still count as errors.
- Prices are Global Standard list prices. Data Zone deployments cost 10–20% more; Azure Speech's promo meter
  ($0.10/h) is 72% less for the Speech part.

## Regression gate

An offline check on every `npm test` and in CI: no API calls, no audio, about 3 s. It runs the current align,
re-listening and rule-based line cutting on frozen hearings of 18 public or generated clips (the text provider's
text, Azure Speech's words, the re-listening answers and Scribe's words), scores the output against the references,
and fails when a metric gets worse than its stored baseline plus a tolerance.

- WER: plain and formatted, with the normalizer above.
- Word timing: start error of matched words against reference word times (AMI's, the forced-aligned LibriSpeech
  test-clean chapter's, or ElevenLabs' machine times on the Blender films).
- Speakers: word speaker accuracy on the two AMI meetings.
- Cue timing: against the NASA captions and, when present locally, the official Tears of Steel subtitles. For each
  reference cue, the start of its first matched word against the cue start.
- Output cues faster than the profile's reading speed.
- Output words on audio without speech (silence, noise, hum, *Spring*): must stay 0.
- Output words before the speech starts on `music-then-speech`, with and without the second hearing: must stay 0.

Words are matched in order within 30 s; a repeated word goes to its nearest occurrence.

```bash
npx vitest run packages/cli/test/bench-gate.test.ts --silent=false     # the gate, with its table
npm run bench:gate                                                    # per clip: every engine and the output
BENCH_GATE_WRITE=1 npx vitest run packages/cli/test/bench-gate.test.ts # write the baseline after a reviewed change
```

Fixtures, licenses, what could not be frozen and private clip sets:
[packages/cli/test/fixtures/bench/README.md](../packages/cli/test/fixtures/bench/README.md). The Blender films are
very likely in the engines' training data, so they only check our own pipeline and its timing; the engine summary
of `bench:gate` leaves them out.

## Reproduce

From the repository root, with the Azure keys in `.env` and `npm run build` done:

```bash
node bench/fetch.mjs          # download and verify the 4 official clips (about 55 MB, about 26 MB kept in bench/data/)
node bench/run.mjs --fresh    # live, billable: about 14 audio minutes, about $0.42 at list price, about 7 minutes wall time
node bench/score.mjs          # writes bench/runs/scores.json and bench/runs/results.md (the run 1 tables)
npm run bench                 # fetch + run (reusing cached requests, no new API calls) + score
node bench/diff.mjs fleurs-nl overtone plain   # list the aligned errors of one system on one clip
```

Without `--fresh`, `run.mjs` reuses the CLI's request cache in `bench/runs/cache/` and makes no API calls for clips
already run. Each clip's `bench/runs/<clip>/hyp.json` keeps the runtimes and token counts of the last fresh run and
the exact CLI command (`command`):

```bash
node packages/cli/dist/cli.js transcribe bench/data/<clip>/audio.wav \
  --text azure-openai:gpt-transcribe --timing azure-speech --llm azure-openai:gpt-6.1-sol \
  --context "<context from clips.json>" --export json,txt --out bench/runs/<clip> \
  --config bench/overtone.bench.json --no-cache
```

**Run one setup at a time.** Parallel runs share Azure OpenAI's rate limit. The two release setups ran at the same
time: every run got HTTP 429 and retries, one clip failed and was rerun alone, and their 52–73 s per audio minute is
slower than a single run. On the Open ASR Leaderboard and non-speech sets three runs went at once and 7 clip runs
failed after the retries; each passed when rerun alone. So this file gives no runtimes for those runs.

**Other sets and settings.** A run with its own `--runs` folder gets its own cache, so it is live and billable:

```bash
node bench/fetch.mjs --clips bench/clips.extra.json                  # fleurs-de, fleurs-es (checksums.extra.json)
node bench/run.mjs --runs bench/experiments/r2                       # a repeat of the official set
node bench/score.mjs --runs bench/experiments/r2
node bench/run.mjs --clips bench/clips.extra.json --runs bench/experiments/x1
node bench/score.mjs --clips bench/clips.extra.json --runs bench/experiments/x1
node bench/run.mjs --runs bench/experiments/noctx --no-context --cli-arg --no-infer-context
```

| Script | Flags |
|---|---|
| `run.mjs` | `--clips <file>` (clip selection), `--runs <dir>` (output folder), `--cache <dir>` (CLI cache; default `<runs>/cache`; concurrent runs need their own), `--cli <path>` (e.g. a snapshot of `dist/cli.js`), `--no-context` (do not pass the clip's context), `--cli-arg <arg>` (repeatable, passed to the CLI), `--keep-meter` (keep the HTTP usage log when some requests came from the cache) |
| `score.mjs` | `--clips <file>`, `--runs <dir>`; `scores.json` and `results.md` go to that folder |
| `fetch.mjs` | `--clips <file>`, `--checksums <file>` (for `clips.X.json` the default is `checksums.X.json`, so `checksums.json` is never rewritten) |

`bench/experiments/` is git-ignored, like `bench/runs/`.

**Open ASR Leaderboard and non-speech sets** (audio stored as FLAC):

```bash
node bench/fetch.mjs --clips bench/clips.standard.json    # LibriSpeech test-other, Earnings-22 (about 56 MB downloaded, 10 MB kept)
node bench/fetch.mjs --clips bench/clips.nonspeech.json   # after the official set (reuses fleurs-nl); about 82 MB downloaded, 14 MB kept
node bench/run.mjs --fresh --clips bench/clips.standard.json --runs bench/experiments/s1
node bench/run.mjs --fresh --clips bench/clips.nonspeech.json --runs bench/experiments/s1
node bench/score.mjs --clips bench/clips.standard.json --runs bench/experiments/s1
node bench/score-nonspeech.mjs --runs bench/experiments/s1 --speech bench/runs   # fleurs-nl alone from the official runs
python3 -m venv bench/data/.venv && bench/data/.venv/bin/pip install subtitle-edit-rate   # once, about 80 MB
node bench/suber.mjs --clips bench/clips.standard.json --runs bench/experiments/s1        # t-WER and AS-WER
```
