# Regression gate fixtures

Frozen hearings of 18 public or generated clips (83 audio minutes) for the regression gate
(`packages/cli/test/bench-gate.test.ts`, `node bench/gate.mjs`). Each `<clip>.fixture.json.gz` is gzipped JSON in
the format of `packages/cli/test/bench/fixture.ts`: text only, never audio, 220 KB in total. `baseline.json` holds
the gated metrics of the current code. The files live next to the tests because CI needs them; `bench/data/` and
`bench/runs/` hold audio and are git-ignored.

A fixture holds:

- **the text hearing:** the text provider's chunks as first answered, the answer of the one retry of a chunk that
  came back empty, and the prompt the saved run sent (for the prompt echo guard);
- **the timing hearing:** the timing provider's words for the whole file;
- **the second hearing:** ElevenLabs Scribe's words for the whole file;
- **the snippet answers:** per engine, the words it heard in each snippet re-listened for timing, and the text the
  text provider heard in each text-vote snippet (by window and prompt);
- **the chooser's answers** of the text vote (by request), and the context and names the chooser gets;
- **the human reference,** where there is one and its license allows it.

## Clips, sources and licenses

| Clip | Source and attribution | License | Reference in the fixture | Training data |
|---|---|---|---|---|
| `tears-of-steel` | *Tears of Steel*, (CC) Blender Foundation \| mango.blender.org | CC BY 3.0 | none committed; word timing against ElevenLabs (machine) | very likely |
| `elephants-dream` | *Elephants Dream*, (c) 2006 Blender Foundation / Netherlands Media Art Institute / elephantsdream.org | CC BY 2.5 | none; word timing against ElevenLabs (machine) | very likely |
| `cosmos-laundromat` | *Cosmos Laundromat*, (CC) Blender Foundation \| gooseberry.blender.org | CC BY 4.0 | none; word timing against ElevenLabs (machine) | very likely |
| `nasa-oravec` | NASA, *Surprisingly STEM: Space Tire Engineer* (2023) | US public domain | NASA's published captions (`…jsc2023m000129.srt` on images-assets.nasa.gov) | possible |
| `nasa-ayers` | NASA, *Connecting Classrooms to Space: Ham Radio Explainer* (2025) | US public domain | NASA's published captions (`…Nichole_Ayers.srt` on images-assets.nasa.gov) | possible |
| `ami-es2004a` | AMI Meeting Corpus, University of Edinburgh; ES2004a 630–850 s | CC BY 4.0 | words with times and speakers (forced alignment of the manual transcript) | possible |
| `ami-en2002a` | AMI Meeting Corpus, University of Edinburgh; EN2002a 558–783 s | CC BY 4.0 | words with times and speakers | possible |
| `libri-672-122797` | LibriSpeech test-clean (Panayotov et al. 2015) + LibriSpeech-PC text (Meister et al. 2023); word times by Mila (Montreal Forced Aligner, Zenodo 2619474) | CC BY 4.0 | text with word times | possible |
| `fleurs-nl`, `fleurs-de`, `fleurs-es` | FLEURS (Conneau et al. 2022), Google | CC BY 4.0 | text | possible |
| `libri-other-7018-75788` | LibriSpeech test-other + LibriSpeech-PC text; word times by Mila (Montreal Forced Aligner, Zenodo 2619474) | CC BY 4.0 | text with word times (525 of 527 words) | possible |
| `silence-60`, `noise-white-60`, `noise-pink-60`, `hum-60` | generated with ffmpeg (`bench/clips.nonspeech.json`) | none needed | none: no speech | none |
| `spring` | *Spring* (Blender Studio, 2019), Andy Goralczyk / Blender Foundation; an animated film without dialogue | CC BY 4.0 | none: no speech | very likely |
| `music-then-speech` | the first 60 s of *Spring*, then the `fleurs-nl` clip | CC BY 4.0 | text (FLEURS) | possible |

Clip selections: `bench/DATASETS.md` and `bench/captions/README.md`. The seven clips added on 2026-10-23 were frozen
from run 1 of the setup with the ElevenLabs second hearing (`bench/runs/2026-10-23-new/scribe/run1`). NASA does not
endorse this project.

- **Non-speech clips** (`nonSpeech`): the gate adds `output.words`, the number of output words, baseline 0, no
  tolerance. Any word on audio without speech fails.
- **Speech after a stretch without it** (`speechStart`, seconds; `music-then-speech`: 60): the gate adds
  `output.early`, the output words that start before the speech, and `output.earlyNoSecond`, the same without the
  second hearing (as without an ElevenLabs key), each baseline 0, no tolerance.
- **`libri-other-7018-75788` has no gated word timing:** the gate uses reference times only when every reference
  word has one, and the aligner left 2 of 527 without.
- **The Earnings-22 clips are not in the gate.** The calls' audio belongs to the companies and the references are
  CC BY-SA, so neither their transcripts nor the engines' hearings are committed.

**Tears of Steel's subtitles are not committed.** The official English subtitles
(`https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt`) come with the film, but state no license. The
gate reads them from `bench/captions/data/tears-of-steel/reference.srt` when present; without it, the clip's WER and
cue metrics print as "skipped (reference absent)". To get them:

```bash
curl -o bench/captions/data/tears-of-steel/reference.srt https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt
```

## Training data (contamination)

Every clip here is public, so any engine may have trained on it (AMI, LibriSpeech, FLEURS and the NASA videos
included).

- **The Blender films are ubiquitous test assets.** ElevenLabs writes Tears of Steel's script spellings ("Thom",
  "Vivacissimo") without any context, while Azure and gpt-transcribe write "Tom". The films stay in the gate to catch
  regressions in our pipeline and to check timing, never to compare engines: the tables label them, and the engine
  summary of `bench/gate.mjs` leaves them out.
- **For a fair engine comparison, add private clips** that were never published (below).

## What could not be frozen

- **`ami-en2002a`'s first gpt-transcribe answer was empty** in every saved run (context as prompt, no language). The
  retry of an empty chunk (loudness-normalized, language en, no prompt) was recorded live on 2026-10-18 and answered
  715 words; they are the text base.
- **`cosmos-laundromat`'s whole-film answer is empty,** also when retried, so its text base is the fallback, Scribe's
  words (as `meta.fallbacks` records). The engine summary leaves this clip out of the text row anyway (no reference).
- **The gate does not run context inference or the refine LLM steps.** The chooser gets the context and names stored
  in the fixture; corrections and styling are no-ops; line cutting is rule-based (rule set 1), as without
  `--llm-linebreaks`.
- **Word timing of the Blender films is measured against Scribe's times** (machine, not truth), and Scribe gives the
  times when present, so on those clips the timing columns mostly measure agreement with Scribe. Tears of Steel's cue
  timing against the subtitles and the AMI reference word times stay independent.

## Re-freezing and private clips

`node bench/gate-freeze.mjs [clip ...]` rebuilds the fixtures from the saved runs on the machine that made them (stage
caches of CLI versions before the request cache, or the request cache of the current CLI), the ElevenLabs answers and
the references; sources are listed in `bench/lib/gate-freeze.ts`. It makes no API calls, keeps the answers earlier
live recordings froze, and prints the requests the current code makes that no fixture answers (the gate answers
those with nothing, or "keep").

`node bench/gate-freeze.mjs --live [clip ...]` sends those requests once to the real providers (keys from `.env`; a
few cents per clip) and freezes the answers, for the gate's configuration and the one without the second hearing.
After re-freezing, check the gate table and write the baseline again.

A **private clip set** goes in the git-ignored `bench/private/`, in the same fixture format
(`<clip>.fixture.json[.gz]`) with its own `baseline.json`. The test and `bench/gate.mjs` run it when present. CI never
has it.
