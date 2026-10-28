# Language packs: instructions for AI agents

Background for humans: [languages.md](languages.md).

## Goal

Add or improve the pack of one language (`<code>`, ISO 639-1, such as `sv`) so its captions break at natural places
and its numbers align. Change only that language's files.

## Files to read

1. `packages/cli/src/lang/types.ts`: the `LanguagePack` interface. Each field's comment says what it does and how
   entries are written. This is the specification.
2. `packages/cli/src/lang/nl.ts` and `en.ts`: two complete packs.
3. `packages/cli/src/lang/_template.ts`: every field, commented.
4. `packages/cli/src/lang/examples/nl.txt`: the example format (also in
   [languages.md](languages.md#write-caption-examples)).
5. `packages/cli/src/lang/index.ts` (`PACKS`, shared lists) and `decoys.ts` (detection decoys).
6. `packages/cli/test/lang-packs.test.ts` and `lang-examples.test.ts`: the checks.

## Files you may change

| File | Action |
|---|---|
| `packages/cli/src/lang/<code>.ts` | Create from `_template.ts`, or edit |
| `packages/cli/src/lang/examples/<code>.txt` | Create or extend |
| `packages/cli/src/lang/index.ts` | Import the pack and add it to `PACKS` (new packs only) |
| `packages/cli/src/lang/decoys.ts` | Delete the language's entry, if any |
| `packages/cli/src/lang/number-words/<code>.ts` | Optional: the parser for `numbers.parseWords` |
| `packages/cli/test/number-words-<code>.test.ts` | Optional: unit tests for that parser |
| `docs/contributing/languages.md` | The language's row in the support table |
| `packages/cli/test/fixtures/golden/` | Only through `OVERTONE_GOLDEN_WRITE=1`, see Invariants |
| `CHANGELOG.md` | A line under "Unreleased" for a user-visible change |

## Invariants

- Do not edit another pack, `neutral.ts`, the rule sets (`packages/cli/src/segment/rulesets/`), pipeline code or
  existing tests. If the pipeline needs a change for the language, stop and report it.
- Entry forms (the test checks them):
  - `detection.stopwords`: lowercase letters, accents kept. Split at apostrophes (`aujourd'hui` → `aujourd`, `hui`).
  - `lineCutting.*`, `names.*`: lowercase display words, accents and apostrophes kept.
  - `numbers.rates.*`: lowercase, no accents, no apostrophes.
  - `text.fillers`: lowercase ASCII letters.
  - `sentences.*`: lowercase, ending in `.` (`bijv.`).
- No duplicates within a list. A word is in at most one of `subjectPronouns`, `clauseWords`, `ambiguousPronouns`, and
  in at most one of `articles`, `prepositions`, `possessives`, `auxiliaries`. `demonstratives` are also pronouns;
  `lineStartConjunctions` are also `conjunctions`; no word is in both `adjectives` and `notAdjectives`.
- No filler is a stopword or a real word of the language.
- At least 30 stopwords (aim for 40–60). Detection must return `<code>` for its own stopword list.
- `name` is the standard English name (`Intl.DisplayNames`); `defaultLocale` is `<code>-XX`.
- A pack with `lineCutting` has `examples/<code>.txt` with at least 5 `bad:` or `keep:` lines.
- Shared fields (`sentences.*`, `names.*`, `numbers.scaleWords`, `currencyWords`, `percentWords`) apply to every
  language. Add only entries that cannot be mistaken for a common word in another registered language.
- Use only words you are sure of. A missing field falls back to neutral behavior; a wrong entry makes captions worse.
- The editor needs nothing from a pack. Do not add lists for it.
- If `rulesets-golden.test.ts` fails after a line-cutting change: check that every changed caption in the diff is
  better. If so, run `OVERTONE_GOLDEN_WRITE=1 npm test -- rulesets-golden`, add a `CHANGELOG.md` line naming the
  language, and list the changed snapshot files in your report. If not, fix the lists.

## Steps

1. Check the current state:

   ```bash
   npm install && npm run build
   node packages/cli/dist/cli.js languages <code>
   ```

   "No language pack" means a new pack; otherwise the output lists the empty fields.

2. Research the language's caption conventions (sources below) and note each URL.
3. New pack: copy `_template.ts` to `<code>.ts`, rename the constant and `code`, set `name`, `nativeName`, `aliases`,
   `defaultLocale`. Add it to `PACKS` and remove it from `decoys.ts`.
4. Fill `detection.stopwords` with 40–60 function words that related languages (see `decoys.ts` and other packs) do
   not share. Run `npm run test:lang`.
5. Write `examples/<code>.txt` before the line-cutting lists: at least 8 examples, each with a `#` title naming the
   rule. Cover articles, prepositions, subject pronouns, clause words, conjunctions, adjective + noun, a name
   (`keep:`), a price with a period (`keep:`) and a ratio (`keep:`). Use realistic sentences of 6–15 words. Each `bad`
   line has the same words as its `good` line with one break moved, not next to punctuation.
6. Fill `lineCutting`, `names` and `sentences` until every example passes. An example that data cannot fix gets a
   `known issue:` title; mention it in your report.
7. Optional: fill `numbers` and `text`. For `parseWords`, write `number-words/<code>.ts` modeled on
   `number-words/en.ts`, with unit tests.
8. Update the language's row in the support table in `docs/contributing/languages.md`: `✅` per level (detection =
   `detection.stopwords`, line cutting = `lineCutting`, numbers = `numbers.parseWords`) and the status `✅ Full`,
   `🟡 Partial` or `🟡 Detection only`. Keep the row format exactly.
9. Run the commands under Definition of done.

Do not run `npm run test:live` or `transcribe`: they make paid calls.

**Sources.** Use published conventions: the Netflix Timed Text Style Guide for the language (line-break rules), the
BBC Subtitle Guidelines as a model, national broadcaster or accessibility guidelines, the ESIST Code of Good
Subtitling Practice, grammar references for closed word classes, and a corpus frequency list for stopwords. Cite only
pages you opened. Mark anything you inferred ("adjective suffixes: my own selection, please review").

## Definition of done

- [ ] `npm run test:lang` passes; "expected fail" counts only `known issue:` examples.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass (one skipped file, the live API test, is normal).
- [ ] `node packages/cli/dist/cli.js languages` shows the coverage you claim.
- [ ] The pack is in `PACKS` and not in `decoys.ts`; the support table row matches.
- [ ] `git status` shows only files from [Files you may change](#files-you-may-change).
- [ ] Your report lists the levels covered, every source with its URL and what you took from it, the `known issue:`
      examples, and every word you were unsure of.
