# Live output

Real Overtone pipeline output, made on 2026-10-28 with the live APIs. Nothing was written or corrected by hand
(hand-made files are in [examples/fixtures](../fixtures)). The rules alone cut lines and captions (rule set 1, the
default), so each `meta` records `"linebreaks": "rules"` and `"rules": "1"`.

The setup is the one recommended for films ([Models](#models)).

| Folder | Input | What it shows |
|---|---|---|
| [sample/](sample) | `examples/media/sample-16x9.mp4`, the generated Lumora clip (synthetic voices) | The README's short sample, captioned end to end with a brand glossary |
| [nasa/](nasa) | A 2008 NASA interview ([SOURCE.md](nasa/SOURCE.md)) | Real speech: two speakers, 473 words, names and mission terms |
| [tears-of-steel/](tears-of-steel) | Tears of Steel (2012), a Blender open movie ([SOURCE.md](tears-of-steel/SOURCE.md)) | A 12-minute live-action film: music and effects under the dialogue, many voices |
| [elephants-dream/](elephants-dream) | Elephants Dream (2006), a Blender open movie ([SOURCE.md](elephants-dream/SOURCE.md)) | An 11-minute animated film: two main characters with accents over a busy soundtrack |
| [cosmos-laundromat/](cosmos-laundromat) | Cosmos Laundromat (2015), a Blender open movie ([SOURCE.md](cosmos-laundromat/SOURCE.md)) | A 12-minute animated film: a dialogue between two characters after 2:20 of music |

Each folder holds the six files `--export json,vtt,srt,txt` writes: `*.overtone.json`, `*.horizontal.vtt`,
`*.vertical.vtt`, `*.horizontal.srt`, `*.vertical.srt`, `*.txt`. Videos are not committed. In the demo
(`npm run demo`), `/examples/demo/` plays Tears of Steel by default; `?clip=elephants-dream`,
`?clip=cosmos-laundromat` and `?clip=nasa` play the others, streamed from download.blender.org and NASA.

## Models

- Text: Azure OpenAI deployment `gpt-transcribe` (`azure-openai:gpt-transcribe`)
- Timing and speakers: Azure AI Speech fast transcription (`azure-speech:fast`)
- Second hearing: ElevenLabs Scribe (`elevenlabs:scribe_v2`, `meta.models.second`), chosen by
  `--timing-second-opinion auto` because `ELEVENLABS_API_KEY` was set; it gives the word times and speakers
- Editor and the text vote's chooser: Azure OpenAI deployment `gpt-6.1-sol` (`azure-openai:gpt-6.1-sol`)

Each file's `meta` also stores the models, the rule set (`meta.rules`), the language data fingerprint
(`meta.languageData`) and the creation time.

## Commands

From the repository root, after `npm run build`, with the Azure keys and `ELEVENLABS_API_KEY` in `.env` (without it
there is no second hearing, and the films' timing is less accurate):

```bash
# sample/
node packages/cli/dist/cli.js transcribe examples/media/sample-16x9.mp4 \
  --text azure-openai:gpt-transcribe --llm azure-openai:gpt-6.1-sol \
  --context "Promotional video for DriveCover, a car insurance product from Lumora Insurance" \
  --glossary examples/fixtures/sample-glossary.txt --export json,vtt,srt,txt --out examples/output/sample

# nasa/  (glossary: nasa/glossary.txt; the video is downloaded separately, see nasa/SOURCE.md)
node packages/cli/dist/cli.js transcribe examples/media/nasa-dutton.mp4 \
  --text azure-openai:gpt-transcribe --llm azure-openai:gpt-6.1-sol \
  --context "NASA Kennedy Space Center interview (2008): NASA public affairs officer Allard Beutel interviews astronaut Jim Dutton about the STS-124 Space Shuttle Discovery mission." \
  --glossary examples/output/nasa/glossary.txt --export json,vtt,srt,txt --out examples/output/nasa

# Blender films (each glossary is in its folder; the videos are downloaded separately, see each SOURCE.md)
node packages/cli/dist/cli.js transcribe examples/media/tears-of-steel.mov \
  --text azure-openai:gpt-transcribe --llm azure-openai:gpt-6.1-sol \
  --context "Tears of Steel (2012), a Blender Foundation live-action science-fiction short film: in a future Amsterdam, scientists try to stop an army of robots by recreating the moment Thom broke up with Celia, the robotics student with a robot hand who built them." \
  --glossary examples/output/tears-of-steel/glossary.txt --export json,vtt,srt,txt --out examples/output/tears-of-steel

node packages/cli/dist/cli.js transcribe examples/media/elephants-dream.mov \
  --text azure-openai:gpt-transcribe --llm azure-openai:gpt-6.1-sol \
  --context "Elephants Dream (2006), a Blender Foundation animated short film: the old Proog guides the young Emo through a strange, seemingly endless machine, and Emo grows more and more skeptical of him." \
  --glossary examples/output/elephants-dream/glossary.txt --export json,vtt,srt,txt --out examples/output/elephants-dream

node packages/cli/dist/cli.js transcribe examples/media/cosmos-laundromat.mp4 \
  --text azure-openai:gpt-transcribe --llm azure-openai:gpt-6.1-sol \
  --context "Cosmos Laundromat: First Cycle (2015), a Blender Institute animated short film: on a desolate island, Franck, a suicidal sheep, meets Victor, a mysterious salesman who offers him the gift of a lifetime." \
  --glossary examples/output/cosmos-laundromat/glossary.txt --export json,vtt,srt,txt --out examples/output/cosmos-laundromat
```

Each film was captioned from the file the demo streams, so its timing needs no offset. The models are not
deterministic; a rerun gives other output. Check a file without API calls:
`node packages/cli/dist/cli.js validate examples/output/nasa/nasa-dutton.overtone.json`.

## Results

| | Summary line from the CLI | Cost at list price |
|---|---|---:|
| sample | `42 words: 39 exact, 1 merge, 2 edited · 2 edits · 2 speakers · 5/9 cues` | $0.011 |
| nasa | `473 words: 451 exact, 6 fuzzy, 10 split, 4 merge, 2 edited · 2 edits · 2 speakers · 51/82 cues` | $0.094 |
| tears-of-steel | `351 words: 330 exact, 4 split, 1 interpolated, 16 edited · 15 edits · 10 speakers · 74/85 cues` | $0.305 |
| elephants-dream | `369 words: 363 exact, 1 fuzzy, 1 interpolated, 4 edited · 4 edits, 1 rejected · 2 to review · 3 speakers · 86/97 cues` | $0.282 |
| cosmos-laundromat | `320 words: 311 exact, 3 fuzzy, 2 interpolated, 4 edited · 4 edits · 2 speakers · 67/79 cues` | $0.283 |

Cues are horizontal/vertical. Cost is what a fresh run of the same clip with the same models sent on 2026-10-19, at
the list prices in [bench/PRICES.md](../../bench/PRICES.md): $0.039 per audio minute for the interview, $0.025 for the
films. These files were made from cached hearings, so their own run cost less. Breakdown, and the same clips without
the second hearing: [bench/RESULTS.md](../../bench/RESULTS.md#cost-breakdown-2026-10-19).

## Notes

- **The language goes with the first text request.** Without `--language`, Scribe hears the file first, and the
  language it detects (`en`) goes with every gpt-transcribe request. Tears of Steel, Elephants Dream and the NASA
  interview got their text on the first try. Cosmos Laundromat came back empty; the empty-chunk retry
  ([Hearings](../../docs/cli/pipeline.md#hearings)) recovered it on the second try, loudness-normalized, sending only
  0:38.7–5:50.9, where the engines heard speech (320 words). `meta.textRetries` records each try. No text came from an
  engine (`meta.fallbacks` is absent).
- **The text vote** re-listened with gpt-transcribe wherever the text disagreed with Azure's and Scribe's words. It
  changed 12 regions in Tears of Steel, 6 in Elephants Dream, 4 in the NASA interview and none in Cosmos Laundromat
  (`meta.textVotes`). In Tears of Steel, 10 of the 12 changes match the official subtitles ("You jerked up." →
  "You're a jerk, Thom.", "Go, you assholes," → "Move your asses.", "We can see you!" → "Vivacissimo!", "Come on!
  Tom!" → "Abort! Cut! Whoa!", "Wire" → "Quiet" and others). The subtitles have no line for the other 2: "Roger,
  Roger." at 0:02, and "Now." at 0:10, which only Scribe heard (word confidence 0.75) and which is not in the film.
  In the NASA interview, "motor" became "mode" and "in" became "on", as Azure, Scribe and the re-listen heard.
- **The editor fixes what was misheard.** It sees the words that were hard to align and what the timing engine
  heard, and fixes names and words in context: "Tom" → "Thom" (6 times) and "lip" → "lib" in Tears of Steel, "Frank"
  → "Franck" (4 times) in Cosmos Laundromat, "hat" → "head" and "But" → "Well," in Elephants Dream. Its two unsure
  Elephants Dream edits are on the review list (`meta.review`) to check by ear; the other files have none. Every
  applied edit is in `edits`, with the old text.
- **Speaker names come from the context.** The engines only separate voices (`S1`, `S2`). The editor named the people
  that `--context` and the glossary name: Allard Beutel and Jim Dutton (NASA, with their roles), Celia, Thom and Barley
  (Tears of Steel; the other 7 voices stay `S1`–`S10`), Proog and Emo (Elephants Dream; a third voice stays `S3`),
  Franck and Victor (Cosmos Laundromat). The sample's two speakers stay unnamed: its context names none.
- **Times come from Scribe, as heard.** No timing rules: a word takes Scribe's time, else Azure's, and a stretch
  neither heard goes to both again as a snippet (`meta.timingRetries`: 2 in Cosmos Laundromat). A word nobody heard
  keeps an unknown time (`interpolated`): 1 word each in Tears of Steel and Elephants Dream, 2 in Cosmos Laundromat,
  none in the others.
- **Tears of Steel against the official English subtitles**
  ([TOS-en.srt](https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt), 76 cues, a word and timing
  reference only): 71 cues matched, median offset 0.30 s; 2 subtitles start more than 2 s from the first caption word
  matched to them, 6 more than 1 s. WER 12.7% (gpt-transcribe alone 20.1%, Azure 20.9%, Scribe 15.5%); the subtitles
  are not verbatim (they leave out the radio chatter at the start, for one). Passages, human → ours (horizontal):
  - 0:23.0 "You're a jerk, Thom." → 0:23.2 "You're a jerk, Thom!" (gpt-transcribe heard "You jerked up.")
  - 0:42.2 "Whatever, Thom. We're done." → 0:42.9 "Oh, whatever, Thom! / We're done."
  - 3:11.0 "Are you ready?" and 3:13.0 "Of course you're ready, you're a rockstar." → 3:11.4 "Are you ready? Of course
    you're ready, / you're a rock star." (one caption)
  - 3:28.0 "Go! Move your asses! Go go go!" → 3:26.6 "Yeah, you, go! Go!", 3:30.2 "Move your asses.", 3:31.2 "Go, go,
    go! / I love it!"
  - 4:59.0 "You're a jerk, Thom!" → 4:59.3 "You're a jerk, Thom."
  - 6:50.0 "Good ad-lib." → 6:50.4 "Good ad lib." (gpt-transcribe heard "No dead lip", Azure "Who'd that", Scribe
    "Good ad")
  - 7:08.0 "Quiet on set!" → 7:08.6 "Quiet on set. / We're out of time.", then 7:10.8 "We're out of time!"
- **Cosmos Laundromat at 3:04.** Victor: "You are so much more than just a sheep, aren't you?" Franck: "Oh yeah? How
  would you know?" Ours: 3:00.5 Victor's line, then 3:04.7 "Oh yeah?" and 3:06.8 "How would you know?", both Franck's,
  at Scribe's times. Victor's correction "Victor, Victor." (3:38.9) is a caption of his own.
- **Swear words are verbatim.** Azure AI Speech masks profanity by default; Overtone asks for it unmasked
  (`AZURE_SPEECH_PROFANITY`, default `none`), so Tears of Steel has "I was young and a dick".
- **Not a benchmark.** Each run is one sample of a non-deterministic pipeline; the subtitle comparison is the only
  reference check. The benchmark is in [bench/RESULTS.md](../../bench/RESULTS.md).
- **Fixtures vs. output.** Tests and the style gallery use the hand-made `examples/fixtures/sample.overtone.json`,
  which has every style class. These files show what the pipeline really produces: the NASA run uses `key`,
  `brand`, `number` and `soft` (19, 15, 9 and 3 words), the sample `brand`, `key` and `number` (3, 2 and 1 words).
