# How the pipeline works

What `overtone transcribe` does with your media, step by step. Options: [CLI reference](reference.md). Benchmark
numbers: [bench/RESULTS.md](../../bench/RESULTS.md).

A run has six stages. They are also the values of `--from-stage`, which resends the requests of that stage and every
later one ([Cache](config.md#cache)).

| Stage | What it does | Provider requests |
|---|---|---|
| `extract` | Audio from the media: a 16 kHz mono WAV and MP3 chunks | none |
| `transcribe` | The text hearing | text model |
| `timing` | Timing hearing, second hearing, [text base](#the-text-base), [context](#context), `--two-pass`, timing snippets | timing engines, text model, LLM |
| `align` | Word times, speakers, the [text vote](#the-text-vote) | snippet re-listens, chooser |
| `refine` | The [editor](#the-editor), speaker labels, [styling](#styling), [LLM line cutting](#llm-line-cutting) | LLM |
| `export` | [Line cutting](#line-cutting) and the output files | none |

## Hearings

Every engine mishears something, so several engines hear the same audio independently and Overtone reconciles them
([`src/hearings.ts`](../../packages/cli/src/hearings.ts)). The LLM never sets a timestamp.

| Hearing | Default engine | Gives |
|---|---|---|
| Text hearing | gpt-transcribe (`--text`) | The words, punctuation and casing |
| Timing hearing | Azure AI Speech (`--timing`) | Word times and speakers |
| Second hearing | ElevenLabs Scribe, when `ELEVENLABS_API_KEY` is set (`--timing-second-opinion`) | More precise word times and speakers, and a vote on the words |
| Snippets | The engines again, on a few seconds of audio | A re-listen where an engine heard nothing, or where the engines disagree |

| | Without `ELEVENLABS_API_KEY` | With it |
|---|---|---|
| Times from | Azure Speech | ElevenLabs Scribe |
| Speakers from | Azure Speech | The engine that told more voices apart (Scribe on a tie) |
| Text vote | Text against Azure (class c only) | Text against Azure and Scribe (classes a, b, c) |

- Without `--language`, the second hearing goes first, and the language it detects goes with every text request
  ([Language](languages.md#language-codes-and-detection)).
- With `--timing same`, the text model's own word times are the timing hearing.
- With `--text-file`, your text is kept as given and there is no text vote.
- A failed second-hearing request is a warning: the run goes on with times and speakers from the timing hearing. An
  implausible Scribe answer counts as no words heard.

The log names every snippet, region and decision. The document records them in `meta.textRetries`,
`meta.fallbacks`, `meta.timingRetries` and `meta.textVotes` ([`meta` fields](reference.md#meta-fields)).

### The text base

The text hearing's words are the starting point. Two problems are fixed before the vote
([`src/pipeline/text-base.ts`](../../packages/cli/src/pipeline/text-base.ts)).

Empty chunks. gpt-transcribe can answer `{"text":""}` and still bill it, mostly when it had to detect the language
itself. A chunk that comes back empty where the engines heard words is sent again, loudness-normalized and with the
language the engines heard, in up to three tries. The first answer with words wins:

1. the whole chunk, with the original prompt (context, glossary, style, the text before it);
2. only the stretch where the engines heard speech (0.5 s before their first word to 0.5 s after their last), with
   the glossary and the text before it as prompt. Skipped when it would cut less than 1 s;
3. that stretch again, without a prompt.

A try with the same audio and prompt as an earlier one is skipped. There is no retry when an engine independent of
the text provider heard words elsewhere in the file but none in that chunk. When every try is empty, the chunk takes
the second hearing's words, else Azure's (`meta.fallbacks`).

Prompt echo. A text model can copy its prompt into the text. A run of at least 5 words that matches the prompt in
order and that the timing engine did not hear is removed ([`src/echo.ts`](../../packages/cli/src/echo.ts)), and the
vote restores what the engines heard there.

With `--two-pass`, the first pass stays when the second request fails, is refused, comes back empty or echoes its
prompt.

### Timing

Each word takes its time from the most precise engine: Scribe when present, else Azure Speech. Code matches the text
to that engine's words.

- A word that engine missed is looked up in the other engine's words (no request).
- A stretch still unheard (words in a gap of at least 2 s, or at least 4 words in a row) is sent again as a snippet:
  the gap with up to 3 words on each side and 0.5 s of audio around it, first to the engine that gives the times,
  then to the other ([`src/align/relisten.ts`](../../packages/cli/src/align/relisten.ts)). A window (gap, context
  words and padding) over 120 s is not sent. A failed snippet request is a warning; the words keep what they had.
- A word timed longer than 3 s and longer than 0.4 s per spoken character was stretched over what followed (music,
  a pause). It keeps its start and ends after its natural length.
- The first 1 to 3 words of a sentence that sit more than 5 s before the rest of it were heard in the noise before
  the speech, unless another engine heard them within 1 s of the same time. They get an unknown time just before
  the rest of the sentence.

Snippet audio is aligned to a 0.25 s grid, so a window a few milliseconds off reuses its cached answer.

#### Unknown times

A word no engine heard gets an estimated time: its natural length (speaking rate × spoken length), centered in the
gap between its neighbors. It is marked `"match": "interpolated"` with confidence 0, and line cutting reads no pause
next to it. Between two speakers, punctuation decides which side its phrase belongs to: in
"I'm sorry. | Do | the ad lib.", "Do" belongs to the speaker of "the ad lib.".

### Speakers

Speakers come from the engine that told more voices apart; on a tie, from the engine that gives the times. A speaker
counts when it has at least 5 words or 2% of the words. The other engine's speakers are mapped onto the words by
time; a word that engine did not hear keeps its own engine's speaker, translated to the chosen labels.

### The text vote

Where the hearings disagree about the words, an LLM chooser decides
([`src/reconcile/`](../../packages/cli/src/reconcile)).

1. Regions. The text and each engine's words are aligned in time. A region is a stretch where the text has words no
   engine confirms, or an engine heard words the text lacks. Words that sound the same agree ("Thom"/"Tom",
   "10"/"ten"); fillers and cut-off words do not vote.

   | Class | When |
   |---|---|
   | a | The text has no words; two engines heard words that sound alike |
   | b | The text differs from two engines that sound alike |
   | c | Anything else: one engine, engines that differ, one engine silent. Every region without a second hearing |

2. Re-listen. The text engine hears each region's snippet again (the region plus 2.5 s on each side), with only
   the caption text before it as prompt.
3. Choose. The chooser (the `--llm` model, effort `low`, 8 regions per request) sees each region with what every
   hearing heard, their sound spellings and syllable counts, the text around it, and the context and names. It sees
   the re-listen only for class c; for a and b, the re-listen serves the `relisten` check below. It keeps the
   caption or writes new words: usually a hearing's words, or words the context makes clear (a name, a number, a
   homophone that does not fit). An empty re-listen is no evidence against a line.
4. Check. The chooser judges the words; code checks only the structure. A change is rejected when it:
   - is empty (`empty`);
   - inserts words the caption already has next to it, unless an engine heard them more often there (`repeat`);
   - for class a or b, sounds less like the re-listen than the caption does (`relisten`). Sounds are compared as
     phonemes ([CMU Pronouncing Dictionary](languages.md#cmu-pronouncing-dictionary));
   - overlaps a change accepted before it (`overlap`).
5. Apply. Changed words are timed like the rest, from the hearings already made. A change the chooser wrote itself,
   which no engine and no re-listen heard, goes on the [review list](#the-review-list).

`meta.textVotes` records every region where the text changed or a change was rejected.

## Context

The context (what the media is about) guides the text model, the chooser and the editor. Give it with `--context`
or `--context-file`. Without one, a short LLM call (effort `low`) reads the transcript and returns a 1–2 sentence
topic plus the names and terms in it. A long transcript is sent as its first 4000 words plus four 250-word samples
of the rest.

```
  context (inferred): A collaborative software-design discussion about handling single-channel audio files …
  names and terms (inferred): Java, Photoshop, Windows, Linux, …
```

The editor gets the topic as context and the names and terms as hints marked unverified. `--two-pass` puts them in
the text model's prompt. A failed call is a warning; the run goes on without a context. `--no-infer-context` (or
`"inferContext": false`) skips the call. The document records `meta.context` and `meta.contextSource` (`user` or
`inferred`).

## The editor

The LLM editor reads the transcript sentence by sentence with the context, the glossary and its own world knowledge
(a company or product name no engine spelled right, for example). It corrects what speech recognition got wrong:
misheard words, homophones, names, terms, and a number or negation when the sentence, the context or another engine
makes clear what was said. It also fixes spelling, casing, punctuation, glossary spellings, split or merged words,
and the number and currency style. It does not paraphrase, reorder or drop content; the speaker's own words and
hesitations stay.

Besides the text, it sees:

- words marked `*`: hard to align and the most likely misheard;
- where the timing engine heard something else, both readings ("8: kind → kite");
- the context and glossary, or the inferred topic and names (marked unverified).

The editor judges the words; code checks only the structure of each edit
([`src/refine/edits.ts`](../../packages/cli/src/refine/edits.ts)). An edit is rejected when it:

- spans more than `edits.maxSpan` words (default 6);
- crosses a speaker change;
- overlaps or duplicates another edit, or is out of range or empty;
- leaves less than 1 ms per new word;
- repeats a word next to it ("theclass" → "the the class");
- in a script without spaces, changes more than 3 characters per word of `edits.maxSpan`.

New words take the time of the words they replace, the match kind `edited` and the lowest confidence of those words.
The document's `edits` lists each applied edit with the old and new text and a reason (`correction`, `brand`,
`style`, `punctuation`, `split-word`). A rejected edit is a warning
(`warning: rejected edit [12, 13] "…" → "…" (reason): why`) and counts in the summary.

A small local editor (`--local`, Ollama) proposes many wrong corrections, so a run with one prints a warning. For
captions you publish, use a cloud editor and check the review list.

### The review list

The editor marks each edit sure or not. Unsure edits are applied and listed with their note, as are vote changes
the chooser wrote itself. The CLI prints the list before the summary line:

```
review: 2 changes to check by ear (also in meta.review of the .overtone.json file):
  - 0:52 edit "Telecom Cell," → "Telkomsel,": the editor was not sure: a telecom brand from the context
  - 2:41 vote "Halo Click." → "Halo Kick.": the chooser wrote "Halo Kick."; no engine heard it so there
… · 6 edits · 2 to review · 2 speakers · 48/71 cues
```

The same items are in `meta.review` ([`meta` fields](reference.md#meta-fields)). Check them by ear.

### Speaker labels

The LLM labels a speaker with a name or role only when the transcript or context makes it clear. Code keeps a name
only when the transcript, `--context` or the glossary contains it (also as "Maya's" or behind a title such as
"Dr."). It keeps a role only when its capitalized words are common role words ("Host", "Guest") or appear there
too. A dropped label is a warning. `--speakers` wins.

### Uncertain words

A word stays uncertain when the timing engine heard something clearly different (`match` is `fuzzy`, `confidence`
below 0.5) and no edit changed it. The document keeps the text model's word; `match` and `confidence` show the
doubt.

`--mark-uncertain` also shows it in VTT, SRT and TXT: `(??)` after each run of such words, once per caption line and
before closing punctuation ("Oliver Sacks (??) described …"). The `.overtone.json` never changes, and words with an
unknown time are not marked. It is off by default: the text model is usually right, most errors are unmarked, and
captions full of `(??)` are hard to read. Use it for drafts you review.

## Styling

The LLM marks the semantic classes `emphasis`, `key`, `brand`, `number` and `soft`. Code enforces the budget: at
most 15% of the words (`styling.maxStyledRatio`) and one `key` phrase per cue (`styling.maxKeyPerCue`).

## Line cutting

Rules in code cut captions and lines: the versioned [rule set](config.md#stable-output-rule-sets). Captions show how
the speaker talks. A break at a real pause is good, even mid-sentence, so viewers who cannot hear can still read the
hesitation. A pause is the silence between two words of one speaker. In rule set 1:

| Pause | Effect |
|---|---|
| 1.5 s or more | Always starts a new caption |
| 1 s or more | Starts a new caption, unless it falls inside a name, number group or glossary term, or a piece of speech would show for less than 0.7 s |
| 0.4 s or more | A hesitation: may become a line break, even in a caption that fits on one line. Its weight grows from 0.5 at 0.4 s to 1 at 0.6 s. At full weight a line may end on an article, preposition or pronoun |
| under 0.4 s | Breath or timing noise: ignored |

- Names, number groups and glossary terms are never split.
- A caption under 0.7 s on screen (a flash) is avoided where possible.
- Without a pause, a line avoids ending on an article, preposition, possessive, auxiliary or subject pronoun.
  Exceptions: a main-verb "have", "do" or "be" ("You have / your robotics,") and the subject of a question head
  ("Why don't you / just admit").

### How long a caption stays on screen

A caption runs from its first word to its last. When that is shorter than the profile's minimum duration
(horizontal 1 s, vertical 0.8 s) or its reading time at the profile's `maxCps` (17 and 15), it stays into the
silence after it:

- at most 1.5 s past its last word;
- never into the next caption, past the media's end or past the profile's maximum duration;
- after a pause of 1 s or more, at least 0.4 s stays blank, so the pause still shows.

Start times and words never move, so fast speech can exceed the reading speed. A gap under 0.1 s between two
captions of one speaker is closed.

### LLM line cutting

`--llm-linebreaks` (or `"llmLinebreaks": true`) also asks the LLM where captions and lines break, per speaker block
and profile (effort `effort.linebreaks`, default `low`). It is off by default: in the
[caption benchmark](../../bench/captions/RESULTS.md) the rules alone did better, and they give the same output on
every run. `meta.linebreaks` records `llm` or `rules`.

- The prompt marks pauses of 1.5 s or more with `‖` and shorter ones from 0.4 s with their length (`·0.7s`).
- A proposed caption is kept only when it breaks no hard rule and no reading rule. Hard rules: characters per line,
  lines, speaker changes, a pause of 1.5 s or more inside the caption, a pause of 1 s or more inside a line, maximum
  duration. Reading rules: no break inside a number, name or glossary group; no line ending on an article,
  preposition, possessive, auxiliary, coordinating conjunction, subject pronoun or relative word; no single word
  before or after a sentence end on the same line; no caption break inside a sentence that fits one caption. The
  exceptions above apply, and before a pause of 0.4 s or more only the first reading rule does. Reading speed and
  minimum duration are not enforced.
- The rules cut the stretches between kept captions. When that mix has more reading-speed or minimum-duration
  violations than the rules' own layout of the block, the block uses the rules' layout.
- The log shows `<profile>: X/Y speaker blocks cut as proposed by the LLM`, or
  `<profile>: lines cut by rules only (LLM line cutting off)`.
- It is the slowest step: 66–75 s per profile on a 2.4-minute interview. Once the first profile's request is sent,
  later profiles start 1.5 s (Anthropic: 3 s) after it, so they hit the prompt cache. With a custom
  `OPENAI_BASE_URL` they start at once.

## Speed and cost

Measured cost per audio minute, with and without ElevenLabs: [bench/RESULTS.md](../../bench/RESULTS.md). List
prices: [bench/PRICES.md](../../bench/PRICES.md). `--dry-run` estimates the cost for your media. The LLM part grows
with the number of words, not minutes, and is most of the runtime on dense speech. Short clips cost more per minute,
because every LLM request carries the same instructions.

- Reasoning effort per step: corrections `medium`, styling `low`, line cutting `low`. Set `effort` in the
  [config file](config.md#config-file), or per language with `languages.<code>.effort`. Values: `low`, `medium`,
  `high`. Each provider maps the hint to its own parameter ([Provider details](providers.md)).
- Concurrency: after the corrections, styling and every profile's line cutting run together, at most 3 requests in
  flight. The one-key-phrase-per-cue limit is applied after both.
- Prompt caching: each request starts with the same block per window (instructions, context, glossary, style, the
  numbered transcript) and ends with its own task. OpenAI and Azure OpenAI cache such a prefix automatically (from
  1024 tokens); Anthropic gets a `cache_control` mark.

## Retries and timeouts

Network calls retry up to 4 times with exponential backoff (about 1 s, 2 s, 4 s, …) on HTTP 408, 409, 429, 5xx and
network errors. Not retried: 501, 505, and a 429 for a used-up quota (`insufficient_quota`). The wait is at least
what `Retry-After` asks or, without it, what a 429 message says ("retry after N seconds"), and at most 60 s.
`x-should-retry: true` from the server overrides these rules. A failed connection names its cause and host. For a
host that does not resolve or refuses, it also names the variable to check (such as `AZURE_SPEECH_REGION`).

| Request | Timeout |
|---|---|
| LLM | 5 minutes (Anthropic: until the answer starts; Ollama: without any data) |
| OpenAI and Azure OpenAI transcription | 0.5 s per audio second plus 2 minutes, at least 5 minutes |
| Azure Speech | 0.5 s per audio second plus 2 minutes, at least 10 minutes |
| ElevenLabs | 1 s per audio second, at least 10 minutes (`ELEVENLABS_TIMEOUT_SECONDS` replaces it) |

A timed-out request is retried at most once, since the service may have processed and billed it. A timed-out
ElevenLabs request is never retried ([ElevenLabs Scribe](providers.md#elevenlabs-scribe)). The
[usage line](reference.md#usage-line) counts timed-out requests.

LLM answers are validated against their JSON schema. A bad answer is retried once with the issues appended; a second
bad answer stops the run.

## Refusals

A provider can refuse a request: Azure OpenAI's content filter (HTTP 400 "The response was filtered due to the
prompt triggering Azure OpenAI's content management policy", or `finish_reason: content_filter`), or the model
itself (OpenAI's `refusal`, Anthropic's `stop_reason: refusal`). A refused request is not retried and not cached.
The step goes on without it:

| Refused request | What the CLI does instead |
|---|---|
| The second hearing | Goes on without the second hearing |
| The text vote's chooser | Keeps the text base for that request's regions |
| A snippet re-listen (vote or timing) | Takes it as no words heard |
| Corrections or styling | That window gets no corrections, speaker names or styling |
| Line cutting | That profile is cut by the rules alone |
| A transcription | Takes it as no text: the text base retries the chunk, then uses the engines' words (`meta.fallbacks`); `--two-pass` keeps the first pass |
| Context inference | Goes on without an inferred context |

Each refusal prints a warning when it happens:

```
warning: REFUSED: 2.4–2.9 s: azure-openai:gpt-6.1-sol refused the text vote's chooser request (1 region) (content filter); kept the text base there
```

After the summary, a block between `=====` lines lists every refusal again; the same list is in `meta.refusals`.
Check those stretches of the captions. A refusal the run cannot do without (the whole-file timing request) fails the
stage with an error that says so. An AI agent running the CLI for a person passes the `REFUSED` block and every
`error: …` on to that person.
