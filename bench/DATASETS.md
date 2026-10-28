# Benchmark datasets

Public clips whose licenses allow research and benchmark use. No audio or transcripts are committed: `bench/data/`
and `bench/runs/` are git-ignored. [fetch.mjs](fetch.mjs) downloads only what a selection needs; each checksum file
holds the SHA-256 of every clip's audio (PCM samples) and reference file.

| Set | Clips | Minutes | Selection | Checksums |
|---|---:|---:|---|---|
| Official | 4 | 13.9 | [clips.json](clips.json) | [checksums.json](checksums.json) |
| German and Spanish | 2 | 6.2 | [clips.extra.json](clips.extra.json) | [checksums.extra.json](checksums.extra.json) |
| [Open ASR Leaderboard](#open-asr-leaderboard-sets-librispeech-test-other-earnings-22) | 3 | 11.2 | [clips.standard.json](clips.standard.json) | [checksums.standard.json](checksums.standard.json) |
| [TIMIT](#timit-sample-human-checked-word-times) | 4 | 9.0 | [clips.timit.json](clips.timit.json) | [checksums.timit.json](checksums.timit.json) |
| [Non-speech](#non-speech-set) | 6 | 15.9 | [clips.nonspeech.json](clips.nonspeech.json) | [checksums.nonspeech.json](checksums.nonspeech.json) |

The official and German/Spanish sets form the 20.1-minute main set. The caption benchmark uses other clips (a film
and two NASA videos): [captions/README.md](captions/README.md#datasets).

```bash
node bench/fetch.mjs                                # official set: about 55 MB downloaded, about 26 MB kept in bench/data/
node bench/fetch.mjs --clips bench/clips.extra.json # German and Spanish (about 10 MB streamed per clip)
node bench/fetch.mjs --update-checksums             # only if a source changed on purpose
```

`fetch.mjs` skips clips already present and verifies their checksums; a re-download that differs fails with
`CHECKSUM MISMATCH`. Two fetches on 2026-10-17 gave byte-identical audio, and a forced re-fetch of the German and
Spanish clips matched their checksums.

## Main set

| Clip | Dataset | License | Kind | Duration | Reference |
|---|---|---|---|---:|---|
| `ami-es2004a` | AMI Meeting Corpus | CC BY 4.0 | scenario meeting, 4 speakers | 220.0 s | words with casing, punctuation, start/end times, speaker |
| `ami-en2002a` | AMI Meeting Corpus | CC BY 4.0 | natural meeting, 4 speakers | 225.0 s | words with casing, punctuation, start/end times, speaker |
| `libri-672-122797` | LibriSpeech test-clean (audio) + LibriSpeech-PC (text) | CC BY 4.0 (both) | audiobook, 1 reader | 196.5 s | text with casing and punctuation, per utterance |
| `fleurs-nl` | FLEURS, Dutch (`nl_nl`) test | CC BY 4.0 | read sentences, Dutch | 190.1 s | text with casing and punctuation, per sentence |
| `fleurs-de` (extra) | FLEURS, German (`de_de`) test | CC BY 4.0 | read sentences, German | 187.1 s | text with casing and punctuation, per sentence |
| `fleurs-es` (extra) | FLEURS, Latin American Spanish (`es_419`) test | CC BY 4.0 | read sentences, Spanish | 184.7 s | text with casing and punctuation, per sentence |

## AMI Meeting Corpus

- **Source:** University of Edinburgh. Audio: the headset mix `Mix-Headset.wav` (16 kHz mono),
  `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/<meeting>/audio/<meeting>.Mix-Headset.wav`.
  Annotations: `ami_public_manual_1.6.2.zip` at `https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/`.
- **License:** CC BY 4.0 (`LICENCE.txt` in the annotation zip).
- **Selection:** two meetings from the AMI full-corpus test set, windows picked by script: after the first minute,
  at least 20 words from each of the 4 speakers, both edges in silence (no reference word within 0.3 s of the cut).
  - `ES2004a`, 630.0–850.0 s (scenario meeting: a design team's kick-off)
  - `EN2002a`, 558.0–783.0 s (natural meeting, more overlapping speech)
- **Fetch:** HTTP range requests for the window's bytes of the WAV. `words/<meeting>.<A-D>.words.xml` and
  `segments/<meeting>.<A-D>.segments.xml` are read from the 22.9 MB zip the same way, via its central directory
  ([lib/remote-zip.mjs](lib/remote-zip.mjs)).
- **Reference:** `<w>` elements inside the window, shifted to start at 0.
  - Punctuation tokens (`punc="true"`) attach to the word before them.
  - Truncated words (`trunc="true"`) and non-word elements (`vocalsound`, `disfmarker`, `gap` and similar) are
    dropped.
  - Words are ordered by utterance: segments sorted by start time, words in order within a segment.
  - Speaker letters (A–D) are the speaker reference. Each segment is one bootstrap unit (63 and 85 segments).
- **Caveats:** the word times come from automatic forced alignment of the manual transcript. Fillers ("um", "uh")
  are transcribed verbatim; the normalizer removes them from both sides.

## LibriSpeech test-clean + LibriSpeech-PC

- **Audio:** LibriSpeech (Panayotov et al. 2015, openslr.org/12), test-clean, utterances `672-122797-0000` to
  `672-122797-0022` (23 consecutive utterances of one chapter). Fetched per utterance from the Hugging Face
  datasets server: `openslr/librispeech_asr`, config `clean`, split `test`, rows 1529–1551, dataset revision
  `71cacbfb7e2354c4226d01e70d77d5fca3d04ba1` on 2026-10-17. The fetch checks the utterance ids, so a changed row
  order fails.
- **Text:** LibriSpeech-PC (Meister et al. 2023, openslr.org/145), `manifests.tar.gz`, `test-clean.json`, field
  `text`: LibriSpeech with punctuation and casing restored. The tarball's SHA-256 is checked; it is deleted after
  the manifest is extracted.
- **License:** CC BY 4.0 for both.
- **Clip:** the utterances joined in order with 0.3 s of silence. Each utterance is one bootstrap unit.
- **Caveats:**
  - Public and widely used, so the models may have trained on it.
  - LibriSpeech-PC punctuation was restored automatically and is sparse (some sentences run on without a full
    stop), so formatted WER here mostly measures agreement with that style.
  - Numbers in the reference are spelled out.

## FLEURS (Dutch, German, Spanish)

- **Source:** FLEURS (Conneau et al. 2022), Hugging Face `google/fleurs`, config `nl_nl`, split `test`, rows 0–17,
  dataset revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd` on 2026-10-17. Sentence ids 1927, 1762, 1823, 1671,
  1943, 1884, 1979, 1678, 1668, 1779, 1710, 1987, 1701, 1783, 1722, 1714, 1983 and 1680; each occurs once.
- **License:** CC BY 4.0.
- **Clip:** the 18 recordings joined in order with 0.5 s of silence.
- **Reference:** field `raw_transcription` (casing, punctuation and digits as in the source). Each sentence is one
  bootstrap unit.
- **Caveats:** unrelated Wikipedia-style sentences read aloud: not natural speech, and little context for the
  editor. The speaker metadata does not identify readers, so the clip is not used for speaker scoring.

**German and Spanish** (`fleurs-de`, `fleurs-es`, [clips.extra.json](clips.extra.json)):

- **Selection:** the Dutch rule: test split, rows from 0, the fewest rows that reach 180 s (which gives Dutch its 18
  rows), joined with 0.5 s of silence. Same revision (`70bb2e84…`), license (CC BY 4.0) and reference field.
  - `fleurs-de` (`de_de`): rows 0–11, 12 sentences, 292 reference words. Ids 2003, 1738, 1849, 1683, 1739, 1796,
    1990, 1721, 1884, 1852, 1797 and 1862.
  - `fleurs-es` (`es_419`, Latin American Spanish): rows 0–15, 16 sentences, 373 reference words. Ids 2001, 1852,
    1764, 1770, 1799, 1820, 1747, 1816, 1783, 1794, 1965, 1835, 1697, 1857, 1964 and 1844.
- **Fetch:** the datasets server does not serve these configs ("Scan size limit exceeded"), so these clips have
  `"archive": true`: `fetch.mjs` reads the same rows from the raw `audio/test.tar.gz` and `test.tsv`, streaming only
  the start of the archive (about 10 MB). On `nl_nl` this path gives byte-identical audio and the same reference as
  the datasets server.
- **Caveats:** as for Dutch. Overtone's German and Spanish language packs are detection only (see the README's
  language table), and the bench normalizer is the basic one (no number words, no German or Spanish filler list),
  enough for read speech.

## Open ASR Leaderboard sets (LibriSpeech test-other, Earnings-22)

Three clips, 11.2 minutes, from two test sets of the Hugging Face Open ASR Leaderboard, reported in their own
section of [RESULTS.md](RESULTS.md#open-asr-leaderboard-sets) so the main set stays comparable. Audio is stored as
FLAC (`"audioFormat": "flac"`): the same 16 kHz mono samples as a WAV at about half the size; the checksum is over
the samples.

```bash
node bench/fetch.mjs --clips bench/clips.standard.json   # about 56 MB downloaded, 10 MB kept
```

These are short slices, and our normalizer is a subset of Whisper's, so the WER compares engines within our runs;
it is not comparable with leaderboard tables.

| Clip | Dataset | License | Kind | Duration | Reference |
|---|---|---|---|---:|---|
| `libri-other-7018-75788` | LibriSpeech test-other + LibriSpeech-PC | CC BY 4.0 (both) | audiobook, 1 reader, the harder half of the test set | 191.1 s | text with casing and punctuation, per utterance |
| `earnings22-4423872` | Earnings-22 | CC BY-SA 4.0 | earnings call, Chile, 2 speakers | 240.0 s | words with casing, punctuation, start/end times, speaker |
| `earnings22-4351517` | Earnings-22 | CC BY-SA 4.0 | earnings call, Indonesia, 5 speakers | 240.0 s | words with casing, punctuation, start/end times, speaker |

**LibriSpeech test-other** (`libri-other-7018-75788`):

- **Source:** as test-clean, config `other` (revision `71cacbfb…`), rows 135–152; text from LibriSpeech-PC
  `test-other.json` (2856 of the 2939 test-other utterances have a LibriSpeech-PC text).
- **Selection:** the first chapter in `test-other.json` whose consecutive utterances from `-0000` reach 180 s:
  `7018-75788-0000` to `-0017`, 18 utterances joined with 0.3 s of silence, 527 reference words.
- **Caveats:** as test-clean.

**Earnings-22** (`earnings22-4423872`, `earnings22-4351517`):

- **Source:** Rev's `revdotcom/speech-datasets`, folder `earnings22`, pinned to commit
  `c05ab6fd8b4b627d123c922a22a39e993dd37635` (2026-05-29). Audio: `media/<id>.mp3` (Git LFS, 24 kHz mono).
  Reference: `transcripts/force_aligned_nlp_references/<id>.aligned.nlp`.
- **License:** CC BY-SA 4.0 (`earnings22/LICENSE.md`). Because of the share-alike terms, the reference text is not
  committed anywhere in this repository, including the regression gate's fixtures.
- **Selection** (`bench/lib/earnings22.mjs`, `pickWindow`): the two largest non-English accent groups in
  `metadata.csv` (Spanish/Portuguese, 31 calls; Asian, 28 calls). In each, the first call by file id that is not one
  of the held-out study's three Earnings-22 calls ([heldout/PROTOCOL.md](heldout/PROTOCOL.md)) and has a window:
  the first 240 s window from 10:00, in 5 s steps, with edges at least 0.3 s from every timed word, at most 5% of
  words without a time, and at least 2 speakers.
  - Spanish/Portuguese: `4372696` (Portugal) has no such window; `4423872` (Chile), 2405–2645 s: one manager's
    answer and the analyst's turn before it, 567 reference words.
  - Asian: `4351517` (Indonesia), 910–1150 s: the end of an answer, the operator, an analyst's three questions and
    the answer, 5 speakers, 539 reference words.
- **Fetch:** the whole MP3 (about 13 MB) is decoded to 16 kHz PCM and the window cut by sample, as for AMI.
- **Reference:** the tokens from the window's first to its last timed token that starts inside it, shifted to start
  at 0. Rev's speaker numbers (`S0`, `S1`, …) are the speaker reference. A new bootstrap unit starts at every speaker
  change and after every sentence end (27 and 35 units).
  - Tags (`<inaudible>`, `<crosstalk>`, `<laugh>`, `<unk>` …) and the bare placeholder word "inaudible" are dropped.
  - Tokens whose alignment failed have no time (5 per window); they count for WER and are skipped for timing.
- **Caveats:**
  - Word times come from forced alignment, as for AMI.
  - Numbers are spelled out ("eight percent", "two thousand and nineteen") and acronyms spelled as letters ("H S B
    C"). The normalizer turns number words into digits on both sides; letter-by-letter acronyms are not joined, so
    "HSBC" counts as errors for every system alike.
  - Fillers ("uh", "um") and repetitions ("to, to, to") are verbatim; the normalizer removes the fillers, not the
    repetitions.

## TIMIT sample (human-checked word times)

Every other set's word times come from forced alignment. TIMIT's were hand-verified by LDC, so this set measures
timing against people.

```bash
node bench/fetch.mjs --clips bench/clips.timit.json   # 22 MB downloaded, about 7 MB kept
```

| Clip | Speakers (dialect region, sex) | Duration | Reference words |
|---|---|---:|---:|
| `timit-dr1-dr2` | dr1 F, dr1 M, dr2 F, dr2 M | 123.4 s | 352 |
| `timit-dr3-dr4` | dr3 F, dr3 M, dr4 F, dr4 M | 133.4 s | 340 |
| `timit-dr5-dr6` | dr5 F, dr5 M, dr6 F, dr6 M | 146.8 s | 351 |
| `timit-dr7-dr8` | dr7 F, dr7 M, dr8 F, dr8 M | 133.4 s | 345 |

- **Source:** the TIMIT sample NLTK distributes (`timit.zip`, nltk_data commit
  `5f09e470fe339e1a119dd174ca284129a3c7a5bb`, SHA-256 `666c6650…`): 16 of TIMIT's 630 speakers, one woman and one man
  from each of the 8 dialect regions, 10 read sentences each, 16 kHz mono WAV.
- **License:** CC BY-NC-SA (non-commercial, share-alike), stated in the sample's README; TIMIT itself is Copyright
  1993 Linguistic Data Consortium. Stricter than the other sets: audio and reference are downloaded, never
  committed, including the regression gate's fixtures.
- **Selection:** all 16 speakers, two dialect regions per clip, in folder order; each speaker's 10 sentences in
  file-name order (`sa1`, `sa2`, `si…`, `sx…`), joined with 0.3 s of silence. Each sentence is a bootstrap unit and
  its speaker the speaker reference.
- **Reference:** words, casing and punctuation from the `.txt` files; times from the `.wrd` files (sample numbers at
  16 kHz). The `.wrd` files time the parts of a hyphenated word separately ("twenty-two"); the parts are joined, so
  all 1,388 words have a time.
- **Caveats:**
  - Read speech in a quiet room: easier than a meeting.
  - A classic test set, very likely in the engines' training data, and every speaker reads the same two `sa`
    sentences. Use it for word timing; its WER says little.
  - TIMIT starts a word at its first phone, including a stop closure, which an engine may place a few tens of
    milliseconds later.

## Non-speech set

Stored as FLAC. Five clips have no speech: no words should be captioned. The sixth puts 60 s of film music before
`fleurs-nl`. Scored by [score-nonspeech.mjs](score-nonspeech.mjs), not `score.mjs`.

```bash
node bench/fetch.mjs --clips bench/clips.nonspeech.json   # after the official set; about 82 MB downloaded, 14 MB kept
```

| Clip | Source | License | Duration |
|---|---|---|---:|
| `silence-60` | digital silence, generated (ffmpeg `anullsrc`) | none needed | 60.0 s |
| `noise-white-60`, `noise-pink-60` | white and pink noise at amplitude 0.03 (about -30 dBFS), generated (ffmpeg `anoisesrc`, seed 1) | none needed | 60.0 s each |
| `hum-60` | 50 Hz mains hum with harmonics at 100 and 150 Hz, generated (ffmpeg `aevalsrc`) | none needed | 60.0 s |
| `spring` | *Spring* (Blender Studio, 2019), an animated short film without dialogue: music and effects. Wikimedia Commons, `File:Spring - Blender Open Movie.webm` (sha1 `1019c657…`), the whole film | CC BY 4.0, Andy Goralczyk / Blender Foundation | 464.1 s |
| `music-then-speech` | the first 60 s of `spring`, then the `fleurs-nl` clip unchanged | CC BY 4.0 (both) | 250.1 s |

- **Why these:** ASR hallucination papers score the share of non-speech clips with any output text, on noise
  collections (MUSAN, UrbanSound8K, FSD50K) and white or pink noise; music is the known gap. MUSAN (CC BY 4.0) is an
  11 GB archive with no per-file copy, so the noise here is generated. *Singularity* (Blender, 2026, also without
  dialogue) is kept for the held-out study ([heldout/PROTOCOL.md](heldout/PROTOCOL.md)).
- **Metric:** words output per clip and per minute, counted after the WER normalizer (fillers and punctuation do not
  count), and the number of clips with any word. On `music-then-speech`: words that start more than 0.5 s before the
  speech, and the WER of the rest against `fleurs-nl`, next to `fleurs-nl` alone. gpt-transcribe alone has no word
  times, so all its words are scored for WER.
- **No words:** the CLI writes nothing and ends with "No words to caption". On a clip with `"nonSpeech": true`,
  `run.mjs` records that as an empty result (`"noWords": true` in `hyp.json`), not a failure.
- **Caveat:** *Spring*'s characters make sounds (calls, breathing); a system that writes them as words gets them
  counted.

## Not used

- **CGN (Spoken Dutch Corpus):** not freely licensed.
- **VoxConverse:** speaker labels but no reference transcripts.
- **Earnings-21:** Earnings-22 covers the same kind of audio with more accents.
