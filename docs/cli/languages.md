# Language

How `overtone` picks the spoken language, handles mixed-language media, and what it knows about each language.
Options: [CLI reference](reference.md).

## Language codes and detection

`--language` (or `language` in the config file) takes:

- a code of 2–3 letters, optionally with region or script: `en`, `nl`, `nl-BE`, `pt_BR` (`nl_be` becomes `nl-BE`);
- a name: `english`, `dutch`, `flemish`, `german`, `french`, `spanish`, `italian`, `portuguese`;
- `auto` (the default).

Anything else is rejected before the run starts. A valid code is passed on as given: the text model gets the
primary code (`nl`), Azure Speech a full locale (`nl` → `nl-NL`, `en` → `en-US`; `nl-BE` stays).

Give `--language` when you know it: gpt-transcribe can return no text at all, and still bill it, when it has to
detect the language itself. Without it, Overtone can [detect the language from audio samples](#detection-from-audio-samples)
first. Without a language from the samples, a second hearing (ElevenLabs Scribe) is sent first, without a language,
and the language it detects goes with every text request:
`language: en (heard by elevenlabs:scribe_v2), sent with the text`.

For the timing provider and the document, the first source with an answer wins:

1. the language the text provider reported (most frequent over the chunks);
2. a conservative stopword guess on the transcript (English, Dutch, German, French, Spanish, Italian, Portuguese).
   It gives up when unsure or when a related language such as Danish or Afrikaans scores close;
3. none: Azure detects the language itself. Its automatic identification covers few locales, and not Dutch.

The log shows the choice and its source (`language: nl (detected from the text)`), and the document's `language`
stores it. With no answer from any source, it stores the locale Azure reported (`nl-NL`), or `und`.

### Detection from audio samples

Without `--language`, a language detector can hear a few samples of the audio before any other provider. The
language it finds goes to every engine as if you had given it with `--language`: the text model, the timing
provider, the second hearing, the language pack and `languages.<code>.llm` and `effort`.

`--detect` (or `detect` in the [config file](config.md#keys)) selects the detector:

| Value | Detector |
|---|---|
| `auto` (default) | [`google-chirp`](providers.md#google-chirp-3) when `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT` are set, else none. None with `--local` or `"local": true` |
| `google-chirp` | Google Chirp 3. Its variables must be set |
| `none` (also `off`, `false`) | None: the language is detected as described above |

Detection does not run with `--language` (one code or candidates such as `en,es`) or with `--text-file`.

The samples:

- Up to 45 s: the whole file is one sample. Up to 90 s: two 30 s samples, at the start and at the end. Longer:
  three 30 s samples, centered at 15%, 50% and 85% of the duration.
- A sample that falls in a silence moves to the nearest speech. Samples stay inside the file and never overlap.
- A sample's language is the language with the most words in it. A sample with fewer than 5 words has no speech.

| Case | What Overtone does | `verdict` |
|---|---|---|
| No audio track, or a peak below −50 dB (checked in both modes, also without a detector) | No paid calls. Writes a document with no turns and `language: "und"` | `silent` |
| Every sample with speech names the same language, and at least two samples have speech (or the file is one sample) | Transcribes in that language | `sure` |
| The samples disagree, or only one of several samples has speech | Transcribes in the language with the most words over all samples; a tie goes to the earliest sample | `unsure` |
| Sound but no speech in any sample (music, noise) | No language from the samples; the engines detect it as described above | `none` |

The log shows the result: `language: nl (detected from the audio by google-chirp:chirp_3, sure)`. For `unsure`
it also lists each sample's language and word count.

- `languages.<code>.text` does not follow a detected language: the text provider is chosen before the audio is
  heard. `languages.<code>.llm` and `effort` do ([Per-language defaults](#per-language-defaults)).
- A detector error stops the run with `error: …`, after the usual [retries](pipeline.md#retries-and-timeouts).
  There is no silent fallback.
- The samples are cached with the extract stage, so `--from-stage transcribe` does not send them again.

The document stores the result in `meta.languageDetection`:

```json
"languageDetection": {
  "verdict": "unsure",
  "language": "nl",
  "provider": "google-chirp:chirp_3",
  "samples": [
    { "start": 12.0, "end": 42.0, "language": "nl", "words": 71 },
    { "start": 300.5, "end": 330.5, "language": "en", "words": 64 }
  ]
}
```

- `language` is left out for `none`, and a sample's `language` is left out when it had no speech.
- For silent media the field is `{ "verdict": "silent" }`, in both modes. Otherwise it is only written when the
  detector ran.
- The document's `language` is the detected code for `sure` and `unsure`, `und` for `silent`, and the choice above
  for `none`.

## Mixed-language media

`--language en,es` (or `"language": ["en", "es"]` or `"en,es"`) names candidate languages. The first is the main
one: the document's `language`, the language pack, and the language for text models that take only one. Each
code is checked like a single `--language`; `auto` cannot be in a list.

| Provider | With candidates |
|---|---|
| gpt-transcribe on `openai` (and on `azure-openai` with `AZURE_OPENAI_TRANSCRIBE_KEYWORDS=1`) | Gets every candidate as `languages` |
| Other text models | Get the main language only; may render other speech in the main language |
| Azure Speech | When its multi-lingual model covers every candidate (German, English, Spanish, French, Italian, Japanese, Korean, Portuguese, Chinese): no locale, and it switches language per phrase. Otherwise all candidates as `locales`, and Azure picks one main language for the file, with a warning |
| ElevenLabs Scribe, MAI-Transcribe | No language; they detect it. Scribe reports one language for the file |

- The log shows the share per language Azure reported (`languages heard: en 82%, es 18%`); the document stores it in
  `meta.languagesHeard` (`{ "en": 0.82, "es": 0.18 }`).
- One language pack applies per file: line cutting and numbers use the main language for all words. The format has
  no language per turn or word.

## Per-language defaults

`languages` in the [config file](config.md#config-file) sets providers and effort per language:

```json
{
  "languages": {
    "nl": { "text": "azure-openai:gpt-transcribe", "llm": "anthropic", "effort": { "corrections": "high" } }
  }
}
```

- `llm` and `effort` apply once the language is known: given, detected from audio samples, or detected after the
  transcribe stage (the log shows `editor for nl: anthropic (languages.nl.llm)`).
- `text` applies only when the language is given up front, since the text model is chosen before detection. A
  language detected from audio samples does not change it either.
- An `nl-BE` entry wins over `nl`; `nl` also covers `nl-BE`.
- `--text`, `--llm` and `--local` win over these entries. The entry's `effort` wins over the top-level `effort`.

## Language packs

A language pack ([`src/lang/`](../../packages/cli/src/lang)) holds what the CLI knows about a language: words a
caption line should not end on, and how numbers are said.

| Coverage | Languages |
|---|---|
| Full (detection, line cutting, numbers) | English, Dutch |
| Detection only | German, French, Spanish, Italian, Portuguese |
| Neutral rules | Every other language: lines break at punctuation and sentence ends; names and digits stay together |

`overtone languages` prints the current list; `overtone languages <code>` every field of one pack. To add or improve
a pack: [Add your language](../contributing/languages.md).

Scripts without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese) get captions, but a "word" is the whole phrase
between two spaces: no word times inside a phrase, line breaks only between phrases, and line length counted in
characters without East Asian width. The [editor's checks](pipeline.md#the-editor) count changed characters there.

## CMU Pronouncing Dictionary

The [text vote](pipeline.md#the-text-vote) compares how words sound, as phonemes. English spelling does not predict
pronunciation ("though", "tough", "through"), so English words come from the
[CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (about 135,000 words). Without it, English uses
a small set of letter-to-sound rules and the vote's sound check is less precise. Dutch, German and Spanish use
hand-written letter-to-sound rules; other Latin-script languages use the Dutch rules; other scripts compare
spellings.

The dictionary is not in the npm package (4.7 MB unpacked). The CLI downloads it once:

| Item | Details |
|---|---|
| What | The npm tarball of `cmu-pronouncing-dictionary` 3.0.0 (0.95 MB) from `https://registry.npmjs.org/cmu-pronouncing-dictionary/-/cmu-pronouncing-dictionary-3.0.0.tgz`, checked against a pinned SHA-256 (`ca16ac15…68ce`, in `src/reconcile/cmudict.ts`) on download and on every load. A copy with another hash is downloaded again |
| When | The first English run that reaches the text vote (any run without `--text-file`). Other languages never download it |
| Where | `OVERTONE_CACHE_HOME`, else `$XDG_CACHE_HOME/overtone`, else `~/.cache/overtone` (macOS, Linux) or `%LOCALAPPDATA%\overtone` (Windows). Written under a temporary name, then renamed. Separate from the per-project `.overtone/` cache |
| Offline | A failed download (no network, firewall, 60 s timeout) prints one warning; the run uses the letter-to-sound rules |
| License | Copyright (C) 1993-2015 Carnegie Mellon University, BSD-style license ([cmudict](https://github.com/cmusphinx/cmudict/blob/master/LICENSE)); the `cmu-pronouncing-dictionary` package is ISC-licensed |

Ahead of time (no internet access, or a proxy Node's `fetch` does not use), download it into the cache folder:

```bash
mkdir -p ~/.cache/overtone
curl -L --fail -o ~/.cache/overtone/cmu-pronouncing-dictionary-3.0.0.tgz \
  https://registry.npmjs.org/cmu-pronouncing-dictionary/-/cmu-pronouncing-dictionary-3.0.0.tgz
```

Or set `OVERTONE_CMUDICT` to a local copy: the tarball, the package's `index.js`, or a `cmudict.dict` text file from
the upstream repository. A copy named this way skips the hash check.
