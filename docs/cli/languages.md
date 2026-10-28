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
detect the language itself. Without it, a second hearing (ElevenLabs Scribe) is sent first, without a language,
and the language it detects goes with every text request:
`language: en (heard by elevenlabs:scribe_v2), sent with the text`.

For the timing provider and the document, the first source with an answer wins:

1. the language the text provider reported (most frequent over the chunks);
2. a conservative stopword guess on the transcript (English, Dutch, German, French, Spanish, Italian, Portuguese).
   It gives up when unsure or when a related language such as Danish or Afrikaans scores close;
3. none: Azure detects the language itself. Its automatic identification covers few locales, and not Dutch.

The log shows the choice and its source (`language: nl (detected from the text)`), and the document's `language`
stores it. With no answer from any source, it stores the locale Azure reported (`nl-NL`), or `und`.

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

- `llm` and `effort` apply once the language is known: given, or detected after the transcribe stage (the log
  shows `editor for nl: anthropic (languages.nl.llm)`).
- `text` applies only when the language is given up front, since the text model runs before detection.
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
