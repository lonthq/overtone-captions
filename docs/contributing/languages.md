# Add your language

Overtone captions any language the speech models understand. Cutting the words into captions that read well takes
knowledge of the language: which words belong together, where a line may end, how numbers are said. A **language
pack** holds that knowledge as word lists, written by people who speak the language. No pipeline knowledge needed:
copy a template, fill in lists, and write caption examples that a test checks
([step by step](#add-your-language-step-by-step)).

AI agents: follow [languages.agents.md](languages.agents.md).

## Why it matters

The same Dutch sentence cut for a phone (22 characters per line). Each box is one caption.

<table>
<tr><th>Neutral rules only</th><th>With the Dutch pack</th></tr>
<tr><td>

```
Gisteren zei de
monteur dat hij
```
```
morgen komt, maar ik
weet dat niet zeker.
```

</td><td>

```
Gisteren zei
de monteur
```
```
dat hij morgen komt,
```
```
maar ik weet
dat niet zeker.
```

</td></tr>
</table>

Without the pack, lines end on the article *de* ("the") and the subject *hij* ("he"), and *ik* ("I") is split from
*weet* ("know"). The pack tells the line cutter that a Dutch line should not end on an article or a subject pronoun.
It also keeps "twaalf euro per maand" ("twelve euros a month") on one line, and matches "twaalf" with "12" when
aligning word times.

## Language support

| Language | Code | Detection | Line cutting | Numbers | Status |
|---|---|---|---|---|---|
| English | `en` | ✅ | ✅ | ✅ | ✅ Full |
| Dutch | `nl` | ✅ | ✅ | ✅ | ✅ Full |
| German | `de` | ✅ | ⬜ | ⬜ | 🟡 Detection only |
| French | `fr` | ✅ | ⬜ | ⬜ | 🟡 Detection only |
| Spanish | `es` | ✅ | ⬜ | ⬜ | 🟡 Detection only |
| Italian | `it` | ✅ | ⬜ | ⬜ | 🟡 Detection only |
| Portuguese | `pt` | ✅ | ⬜ | ⬜ | 🟡 Detection only |
| All other languages | | ⬜ | ⬜ | ⬜ | ⬜ Neutral rules |

A pack with some levels shows 🟡 Partial. A test keeps this table in sync with the packs. To see which fields of a
pack are still empty:

```bash
npm run build
node packages/cli/dist/cli.js languages        # all packs
node packages/cli/dist/cli.js languages de     # every field of one pack, filled or not
```

Neutral rules still give usable captions: lines break at punctuation and sentence ends, and names and numbers in
digits stay together. A pack makes them good. Scripts without spaces have their own limits: see
[Language packs](../cli/languages.md#language-packs) in the CLI reference.

## What a language pack is

| File | What it holds |
|---|---|
| `packages/cli/src/lang/<code>.ts` | The pack: word lists, grouped by what they do |
| `packages/cli/src/lang/examples/<code>.txt` | Caption examples: good and bad line breaks, checked by a test |
| `packages/cli/src/lang/number-words/<code>.ts` | Optional: code that reads number words ("twenty-one" → 21) |
| `packages/cli/src/lang/index.ts` | The registry: add your pack to `PACKS` |

You do not need to know TypeScript: the pack is lists of words in quotes. The
[template](../../packages/cli/src/lang/_template.ts) shows every field with an example;
[`types.ts`](../../packages/cli/src/lang/types.ts) documents each one.

```ts
export const nl: LanguagePack = {
  code: 'nl',
  name: 'Dutch',
  nativeName: 'Nederlands',
  defaultLocale: 'nl-NL',
  detection: { stopwords: ['de', 'het', 'een', 'en', 'is', /* … */] },
  lineCutting: {
    articles: ['de', 'het', 'een', "'t", "'n"],
    subjectPronouns: ['ik', 'wij', 'we', 'jij', 'hij', 'zij', 'wie', 'welke'],
    // …
  },
  // …
};
```

Only `code` (ISO 639-1, or 639-3 when there is no two-letter code) and `name` (the English name) are required. A field
you leave out falls back to neutral behavior, so a pack can start small. The other identity fields are `nativeName`,
`aliases` (English names users may pass to `--language`) and `defaultLocale` (sent to speech services, such as
`nl-NL`).

Some lists are **shared** across all languages, because names, prices and abbreviations cross languages ("Maya van
der Berg" in an English sentence): `sentences.*`, `names.*`, and `numbers.scaleWords`, `currencyWords` and
`percentWords`.

How to write entries (the pack test checks it):

- Detection stopwords: lowercase, as written, accents kept (`très`).
- Line-cutting lists and names: lowercase, accents and apostrophes kept (`m'n`, `'t`).
- Fillers: lowercase ASCII letters (`ehm`).

## Coverage levels

A pack grows in three levels. Each is useful on its own; do them in order.

| Level | Fields | What it improves | Effort |
|---|---|---|---|
| 1. Detection | `detection.stopwords` | The CLI recognizes the language when nobody names it, so the speech service gets the right locale | 15 minutes |
| 2. Line cutting | `lineCutting`, `names`, `sentences` | Where lines and captions break: the biggest visible difference | 1–2 hours |
| 3. Numbers | `numbers`, `text` | Word times for spoken numbers, contractions and fillers; number phrases stay on one line | 1–3 hours; `parseWords` is code |

**Detection.** List 40 to 60 of the most common words: articles, pronouns, common verbs, prepositions. Prefer words
that close neighbors do not share. When two languages score close, detection returns nothing, which is safe. If your
language is in [`decoys.ts`](../../packages/cli/src/lang/decoys.ts) (Danish, Norwegian, Swedish, Afrikaans, Romanian,
Catalan), move its list from there into your pack.

**Line cutting.** These lists change costs; they set no hard limits. The cutter still respects line length and
reading speed and picks the best break it can.

| Field | Effect | Example |
|---|---|---|
| `articles`, `prepositions`, `possessives`, `auxiliaries` | A line should not end on these | "the \| crew", "with \| a class", "our \| arrival", "will \| fly" |
| `subjectPronouns` | A pronoun that is always a subject stays with its verb | "a class we \| affectionately call" |
| `clauseWords` | A question or relative word stays with its clause | "walk through what \| they're doing" |
| `questionWords` | Allows a break after the auxiliary in a direct question | "How did \| the project start?" |
| `ambiguousPronouns` | A pronoun that may be an object costs less | "thank you \| so much" |
| `demonstratives` | Closes a phrase after a preposition | "and before that \| I flew" |
| `contractedPronouns` | A pronoun with a contracted verb costs half | "we're \| joined" |
| `lineStartConjunctions` | "and", "but" start the next line | "a test pilot, \| and before that" |
| `conjunctions` | A break before one reads well | "the launch slipped \| because" |
| `adjectives`, `adjectiveSuffixes`, `notAdjectives` | An adjective stays with its noun (mild) | "an operational \| pilot" |

In LLM line cutting (`--llm-linebreaks`) these lists are hard rules: a proposed line that ends on an article,
preposition, possessive, auxiliary, coordinating conjunction or subject pronoun is rejected and cut by the rules.

**Numbers.** `numbers.parseWords` is a small function, because number words follow grammar ("drieëntwintig" is 23).
Start from [`number-words/en.ts`](../../packages/cli/src/lang/number-words/en.ts) or
[`number-words/nl.ts`](../../packages/cli/src/lang/number-words/nl.ts), or leave it out: digits work in every
language. The other number and text fields are lists: decimal separator, ordinal suffixes, rate words ("per month"),
contractions, fillers.

The LLM editor needs nothing from a pack. It judges the words itself ([The editor](../cli/pipeline.md#the-editor)).

### Packs and rule sets

Line cutting is a versioned [rule set](../cli/config.md#stable-output-rule-sets): the same words, rule set and
language data give the same captions. A pack is language data, so changing its line-cutting lists (or the shared
`names` and `sentences` lists) changes the captions of that rule set. That is intended: documents record the data's
fingerprint in `meta.languageData`, and the golden tests (`packages/cli/test/rulesets-golden.test.ts`, English and
Dutch inputs) fail when the layout changes. When one fails:

1. Read the diff it prints. Is every changed caption better? If not, fix your lists.
2. If it is, rewrite the snapshot with `OVERTONE_GOLDEN_WRITE=1 npm test -- rulesets-golden` and include the diff of
   `packages/cli/test/fixtures/golden/` in your pull request.
3. Add a line under "Unreleased" in `CHANGELOG.md`: which language's captions change and why.

Never change `packages/cli/src/segment/rulesets/` for a language. A new rule set is a separate change.

## Add your language, step by step

The example is Swedish (`sv`). You need Node.js 22.12 or later.

1. Fork, clone and install:

   ```bash
   git clone https://github.com/<you>/overtone-captions.git
   cd overtone-captions
   npm install
   ```

2. Create the pack and rename `xx` to `sv` inside it:

   ```bash
   cp packages/cli/src/lang/_template.ts packages/cli/src/lang/sv.ts
   ```

3. Register it in [`index.ts`](../../packages/cli/src/lang/index.ts): import it and add it to `PACKS`. Delete its
   entry from `decoys.ts` if there is one.

4. Fill in detection and run the pack tests:

   ```bash
   npm run test:lang
   ```

5. Write examples before rules: five to ten real captions in `packages/cli/src/lang/examples/sv.txt`
   ([Write caption examples](#write-caption-examples)). They fail until the pack has rules.

6. Fill in line cutting until your examples pass. Then numbers, if you can.

7. Run everything:

   ```bash
   npm run test:lang     # pack and example tests, fast
   npm test
   npm run typecheck
   ```

   A failing example shows both costs:

   ```
   AssertionError: break cost: good "Ik weet dat / niet zeker" = 8, bad "Ik weet / dat niet zeker" = 2
   ```

   Here the cutter prefers the break before the conjunction "dat", so the pair needs another `bad` line, or a rule your
   lists do not express yet.

8. Update your language's row in the [support table](#language-support) (the test tells you when it is wrong).

9. Open a pull request. Say where your lists come from (your own knowledge, a style guide, a dictionary) and paste
   the output of `node packages/cli/dist/cli.js languages sv`.

Change one language per pull request. If shared code seems wrong for your language, say so in the pull request or an
issue.

## Write caption examples

Examples show what a good caption looks like in your language; the test proves the line cutter agrees. Anyone who
reads the language can write them.

```
# A subject pronoun stays with its verb: "dat hij | morgen komt"
good: Gisteren zei de monteur / dat hij morgen komt.
bad:  Gisteren zei de monteur dat hij / morgen komt.

# A price stays with its period
keep: Je betaalt [twaalf euro per maand], zonder eigen risico.
```

| Line | Meaning |
|---|---|
| `# text` | A comment. The comment right before an example names it in the test output. |
| `good: …` | A caption cut well. `/` marks a line break. |
| `bad: …` | The same words, cut worse. One or more follow each `good:`. |
| `keep: … [phrase] …` | The cutter never breaks inside the bracketed phrase (at least two words): names, numbers with their unit or rate, glossary terms. |
| `profile: vertical` | From here on, also check line length and balance: `vertical` (22 characters, 2 lines), `horizontal` (42, 2) or `<chars>x<lines>` such as `32x2`. `profile: none` turns it off. |
| `glossary: A, B` | Glossary terms for the examples below, as with `--glossary`. `glossary:` alone clears them. |

For each pair, the test sums the cutter's cost at every `/` and requires `good` to cost less than `bad`. Line length
and balance count only after a `profile:` line; then every `good` line must also fit the profile. Examples are read as
fluent speech without pauses, so write them without hesitations.

**Known issues.** When the word lists cannot fix an example, start its title with `known issue:`. The test then
expects it to fail and tells you once a later change fixes it.

```
# known issue: a number and the noun it counts: "about four | years ago"
good: I joined the astronaut corps / about four years ago,
bad:  I joined the astronaut corps about four / years ago,
```

Good examples are real (from a caption you saw go wrong, a transcript or a style guide), make one point (`good` and
`bad` differ in one break), and use common sentence patterns. Cover the rules your language needs: articles,
prepositions, subject pronouns, conjunctions, names, prices and ratios, and anything special such as separable verbs or
clitics. Ten good examples beat fifty similar ones.

## Test with your own video

The examples test the rules offline. To see the whole pipeline, caption a one- to three-minute clip with the language
set. This makes billable API calls; providers and keys: [CLI README](../../packages/cli/README.md).

```bash
npm run build
node packages/cli/dist/cli.js transcribe clip.mp4 --language sv --export json,vtt,srt
```

Read `clip.vertical.srt` as a viewer would; each bad break is a new example. After you change the pack, rebuild and
run the same command. Alignment and refine rerun with the new lists; speech and LLM answers come from the cache,
except LLM requests your change alters.

## Review checklist

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] The pack is in `PACKS` and not in `decoys.ts`.
- [ ] Every list holds words of your language only, in the form its field asks for.
- [ ] No filler is a real word of your language.
- [ ] `examples/<code>.txt` has at least five real examples with clear titles.
- [ ] The support table shows the new levels.
- [ ] The pull request names your sources and the levels covered.
- [ ] Other packs and shared code are unchanged.

## Getting help

Open an issue on [GitHub](https://github.com/lonthq/overtone-captions/issues) titled `Language: <your language>`, even
before you start: someone may already be on it, and a maintainer can help with a number-word parser or a rule your
language needs. A partial pack is welcome; detection alone helps.
