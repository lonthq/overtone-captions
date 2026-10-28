# The Overtone Caption Format, Version 1

| | |
|---|---|
| **Format version** | 1 |
| **Status** | Working Draft |
| **Date** | 2026-10-17 |
| **This document** | [docs/format/spec.md](spec.md) |
| **Changes** | [docs/format/changelog.md](changelog.md) |
| **JSON Schema** | [packages/format/overtone.schema.json](../../packages/format/overtone.schema.json) (published as `overtone-format/schema.json`) |
| **Reference implementation** | [`overtone-format`](../../packages/format) (types, validator, exporters) |
| **File extension** | `.overtone.json` |
| **Media type** | `application/vnd.overtone+json` (suggested, not registered) |

## Abstract

Overtone is a JSON format for word-timed, speaker-aware captions. A document stores every spoken word once, with
its text, start and end time, speaker and optional semantic style classes. **Profiles** cut those words into cues
and lines for one shape of picture each (a wide TV picture, a tall phone picture) by referring to the words, not
copying them. Accepted corrections are recorded next to the words. This document defines version 1: the data
model, the rules a valid document meets, how consumers process it, how producers should write it, and how it
converts to WebVTT, SubRip and plain text.

## Status of this document

Working Draft. Version 1 is complete and implemented by `overtone-format` 0.1.0. This document may still get
editorial clarifications. A change that would make a valid version 1 document invalid, or change its meaning,
defines a new format version instead ([§15](#15-versioning-and-extensibility)).

Where this document and the reference validator (`validate()` in
[packages/format/src/validate.ts](../../packages/format/src/validate.ts)) disagree, the validator is authoritative
and this document has a defect. Please report it. The JSON Schema checks structure only
([Appendix A](#appendix-a-json-schema-coverage)).

## Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [Terminology](#3-terminology)
4. [Data model overview](#4-data-model-overview)
5. [Common value types](#5-common-value-types)
6. [The document object](#6-the-document-object)
7. [Speakers](#7-speakers)
8. [Turns and words](#8-turns-and-words)
9. [Profiles, cues and lines](#9-profiles-cues-and-lines)
10. [Edits](#10-edits)
11. [Meta](#11-meta)
12. [Vocabularies](#12-vocabularies)
13. [Validation](#13-validation)
14. [Processing rules for consumers](#14-processing-rules-for-consumers)
15. [Versioning and extensibility](#15-versioning-and-extensibility)
16. [Guidance for producers](#16-guidance-for-producers)
17. [Conversion to WebVTT, SRT and plain text](#17-conversion-to-webvtt-srt-and-plain-text)
18. [Security and privacy considerations](#18-security-and-privacy-considerations)
19. [Examples](#19-examples)
20. [References](#20-references)
- [Appendix A. JSON Schema coverage](#appendix-a-json-schema-coverage)
- [Appendix B. Registry of reserved names](#appendix-b-registry-of-reserved-names)

## 1. Introduction

WebVTT and SubRip store finished cues: text cut into lines once, for one screen, timed per cue. Word timing,
speakers and the reason a word stands out are lost or baked into presentation. Overtone keeps them, so captions
can be cut again for another screen, styled by meaning, checked and corrected.

### 1.1 Design goals

1. **Words are the single source of truth.** Each word's text, timing, speaker and classes are stored once, in
   `turns`. Lines and edits refer to words by index. Line text is a derived copy that must match the words.
2. **Per-device profiles.** One document carries several line cuts. A wide screen gets longer lines than a phone;
   both show the same words at the same times.
3. **Semantic styling.** Classes say *why* a word matters (`key`, `brand`, `number`, ...), not how it looks.
   Players decide the look, and viewers can turn styling off.
4. **Edits are recorded.** Every accepted change lists the original text, the new text and a reason, so a reviewer
   can audit an automated editor.
5. **Forward compatibility.** Readers ignore members they do not know. Breaking changes increase `version`.

### 1.2 Out of scope

Version 1 does not define caption position, colors, fonts, karaoke effects, translations, or several languages in
one document. Players supply the look (for example with CSS themes).

## 2. Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",
"NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14
[[RFC 2119](#ref-rfc2119)] [[RFC 8174](#ref-rfc8174)] when, and only when, they appear in all capitals, as
shown here.

Sections marked *(informative)*, examples and notes are non-normative. Everything else is normative.

Conformance classes:

- **Document.** A JSON text [[RFC 8259](#ref-rfc8259)] in UTF-8 whose value meets every requirement of sections 5
  to 12. Such a document is *valid*.
- **Validator.** Accepts every valid document and reports at least one issue for every invalid one, for the
  conditions in [§13.2](#132-error-catalog). It MUST NOT reject a document because of unknown members.
- **Consumer.** Reads documents to present or convert captions (player, editor, exporter). It follows
  [§14](#14-processing-rules-for-consumers).
- **Producer.** Writes only valid documents, and SHOULD follow [§16](#16-guidance-for-producers).
- **Exporter.** A consumer that converts to another caption format. [§17](#17-conversion-to-webvtt-srt-and-plain-text)
  describes the reference exporters; others MAY differ in detail but MUST honor profile windows
  ([§14.5](#145-windows)).

## 3. Terminology

- **Member**: a name/value pair of a JSON object, named in `code` and referred to by path, such as
  `profiles[0].cues[2].lines`.
- **Time value**: seconds from the start of the media ([§5.1](#51-time-value)).
- **Word**: the smallest timed unit of display text, usually one written word with its punctuation.
- **Turn**: a run of words by one speaker.
- **Global word index**: a word's position when all words of all turns are listed in turn order, then word order,
  from 0 ([§8.3](#83-global-word-index)).
- **Word range**: an inclusive pair `[first, last]` of global word indices ([§5.2](#52-word-range)).
- **Profile**: one cut of the words into cues, for one shape of picture (its aspect).
- **Cue**: one to a few lines shown during one time interval.
- **Line**: one row of caption text in a cue, defined by a word range.

## 4. Data model overview

*(informative)*

```text
document
├── format: "overtone"
├── version: 1
├── language: BCP 47 tag
├── duration: time
├── speakers[]          { id, label?, role? }
├── turns[]             { speaker → speakers[].id, start, end,
│   └── words[]           { text, start, end, classes?, match?, confidence? } }
├── profiles[]          { id, aspect, description?, window?, rules,
│   └── cues[]            { start, end, speaker → speakers[].id,
│       └── lines[]         { words: [first, last] → global word index, text } } }
├── edits[]?            { words: [first, last], from, to, reason }
└── meta?               { title?, context?, style?, models?, generator?, createdAt? }
```

Arrows mark references: turns and cues refer to speaker ids; lines and edits refer to global word indices.

## 5. Common value types

### 5.1 Time value

A time value is a JSON number that is finite, ≥ 0, and has at most 3 decimals (a whole number of milliseconds).

The decimals test tolerates binary floating-point noise: `t` passes when
`|t × 1000 − round(t × 1000)| < 0.000001`. So `0.9000000000000001` (from `0.1 + 0.2 + 0.6`) passes as `0.9`, and
`0.91234` fails.

There is no upper bound. Times are measured from the start of the media, never from a profile window.

### 5.2 Word range

A JSON array of exactly two integers `[first, last]` with `0 ≤ first ≤ last`. It denotes global words `first`
through `last`, **both inclusive**: `[4, 4]` is word 4 alone, `[0, 3]` is four words. `last` MUST be less than the
number of words in the document.

### 5.3 Identifiers

- **Speaker id**: a non-empty string. Speaker ids MUST be unique within `speakers`. Producers SHOULD use short
  ids without whitespace, such as `S1`, `S2`.
- **Profile id**: a non-empty string matching `^[A-Za-z0-9_-]+$`. Profile ids MUST be unique within `profiles`.
  The pattern exists because consumers put profile ids in file names and CSS class names. No id has a special
  meaning; consumers choose a profile by its `aspect` ([§14.3](#143-profile-selection)).

Identifiers are compared as exact, case-sensitive strings.

### 5.4 Unknown members

Any object MAY contain members this specification does not define. Validators MUST accept them and consumers MUST
ignore them ([§14.2](#142-unknown-members)). For naming, see [§15.4](#154-extension-members).

## 6. The document object

The root value MUST be a JSON object with these members:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `format` | string | yes | MUST be exactly `"overtone"`. |
| `version` | integer | yes | MUST be exactly `1`. |
| `language` | string | yes | Non-empty. SHOULD be a BCP 47 tag [[BCP 47](#ref-bcp47)] for the spoken language (`en`, `nl`, `nl-BE`), or `und` when unknown. |
| `duration` | time | yes | Media length in seconds. |
| `speakers` | array of [Speaker](#7-speakers) | yes | May be empty. Ids unique. |
| `turns` | array of [Turn](#81-turn) | yes | May be empty. |
| `profiles` | array of [Profile](#91-profile) | yes | May be empty. Ids unique. |
| `edits` | array of [Edit](#10-edits) | no | |
| `meta` | [Meta](#11-meta) object | no | |

The validator checks only that `language` is a non-empty string, not that it is a BCP 47 tag.

`duration` SHOULD be ≥ every time value in the document. Validators do not check this.

## 7. Speakers

Each element of `speakers` is an object:

| Member | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Speaker id ([§5.3](#53-identifiers)), referenced by `turns[].speaker` and `cues[].speaker`. |
| `label` | string | no | Display name, such as `"Maya"` or `"Jim Dutton"`. |
| `role` | string | no | Free-text role, such as `"host"`. The reference player and exporters do not show it. |

Order carries no meaning. A speaker MAY be listed without being referenced. Display labels are defined in
[§14.7](#147-speaker-labels).

## 8. Turns and words

### 8.1 Turn

Each element of `turns` is an object:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `speaker` | string | yes | MUST be the `id` of an element of `speakers`. |
| `start` | time | yes | |
| `end` | time | yes | MUST be ≥ `start`. |
| `words` | array of [Word](#82-word) | yes | MUST contain at least one word. |

Within a turn, words MUST be ordered and MUST NOT overlap: each word's `start` MUST be ≥ the previous word's `end`
(touching is allowed).

The validator does not relate a turn's times to its words, and does not check turn order or overlap between turns.
Producers SHOULD do all three ([§16.2](#162-turns-and-words)).

### 8.2 Word

Each element of `turns[].words` is an object:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `text` | string | yes | Non-empty; MUST contain at least one non-whitespace character. Display text including punctuation. |
| `start` | time | yes | |
| `end` | time | yes | MUST be ≥ `start`. A zero-length word is allowed. |
| `classes` | array of string | no | Each element MUST be a [style class](#121-style-classes) and MUST NOT appear twice. Order carries no meaning. An empty array means the same as no `classes`. |
| `match` | string | no | A [match kind](#122-match-kinds). |
| `confidence` | number | no | From 0 to 1 inclusive. |

### 8.3 Global word index

Words are numbered across the document: all words of `turns[0]` in order, then those of `turns[1]`, and so on,
from 0. The index is implicit, never stored. Lines ([§9.5](#95-line)) and edits ([§10](#10-edits)) use it.

A producer that inserts, removes or reorders words or turns changes the numbering, and MUST update every word
range in the document.

### 8.4 Word text and whitespace

`text` is shown as written, with punctuation and capitals (`"Lumora,"`, `"$12"`, `"part?"`). It MAY contain an
inner space when a punctuation-only token is attached to a word, as in `"to —"`.

Producers SHOULD NOT put leading or trailing whitespace, line breaks, tabs or runs of spaces in word text.
Consumers that output text SHOULD collapse each whitespace run in a word to one space and trim it, as the reference
exporters do ([§17](#17-conversion-to-webvtt-srt-and-plain-text)).

## 9. Profiles, cues and lines

### 9.1 Profile

Each element of `profiles` is an object:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `id` | string | yes | Profile id ([§5.3](#53-identifiers)), unique. |
| `aspect` | string | yes | The picture shape the cues are cut for: `"W:H"`, two positive integers without leading zeros (pattern `^[1-9][0-9]*:[1-9][0-9]*$`), such as `"16:9"`, `"1:1"`, `"9:16"`. |
| `description` | string | no | Human-readable purpose, such as `"TV/desktop"`. |
| `window` | [Window](#93-window) | no | |
| `rules` | [Rules](#92-rules) | yes | |
| `cues` | array of [Cue](#94-cue) | yes | May be empty. |

A document MAY have any number of profiles with any ids and aspects. The reference producer names its defaults
`horizontal` (`16:9`) and `vertical` (`9:16`); consumers give these names no special treatment. The aspect is a
ratio, not a pixel size: `"16:9"` and `"32:18"` are equal and both valid. The order of `profiles` matters only to
break a tie ([§14.3](#143-profile-selection)).

### 9.2 Rules

`rules` records the limits the producer used to cut the profile:

| Member | Type | Required | Constraints | Meaning |
|---|---|---|---|---|
| `maxCharsPerLine` | integer | yes | ≥ 1 | Longest line, in characters. |
| `maxLines` | integer | yes | ≥ 1 | Most lines in one cue. |
| `maxCps` | number | no | > 0 | Highest reading speed, in characters per second. |
| `minDuration` | number | no | > 0 | Shortest cue, in seconds. |
| `maxDuration` | number | no | > 0 | Longest cue, in seconds. |

Rules are descriptive. Validators do not check cues against them, and consumers MUST NOT reject a document whose
cues break its own rules. [§16.4](#164-applying-rules) defines how producers measure them. `minDuration` and
`maxDuration` are positive numbers, not time values: they may have more than 3 decimals.

### 9.3 Window

`window` limits a profile to part of the media, such as a short social clip from a longer video:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `start` | time | yes | |
| `end` | time | yes | MUST be > `start`. |

The window is the half-open interval **[`start`, `end`)**. The profile's captions show only inside it, and cues
crossing an edge are cut at the edge ([§14.5](#145-windows)). Window times are media times. The validator does not
relate the window to `duration` or to the cues.

### 9.4 Cue

Each element of `profiles[].cues` is an object:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `start` | time | yes | |
| `end` | time | yes | MUST be > `start` (no zero-length cues). |
| `speaker` | string | yes | MUST be the `id` of an element of `speakers`. |
| `lines` | array of [Line](#95-line) | yes | MUST contain at least one line. |

Within a profile, cues MUST be ordered and MUST NOT overlap: each cue's `start` MUST be ≥ the previous cue's `end`
(touching is allowed). So at most one cue of a profile is active at any time ([§14.4](#144-time-lookup)).

A cue never spans two speakers: every word referenced by its lines MUST belong to a turn whose `speaker` equals the
cue's `speaker`.

The validator does not require a cue's times to match its words, or a profile's cues to cover every word.
Producers SHOULD do both ([§16.3](#163-building-cues)).

### 9.5 Line

Each element of `cues[].lines` is an object:

| Member | Type | Required | Constraints |
|---|---|---|---|
| `words` | word range | yes | [§5.2](#52-word-range); `last` less than the number of words. |
| `text` | string | yes | MUST equal the `text` of the referenced words joined by single spaces (U+0020). |

Lines run top to bottom. Within a cue, lines MUST be ordered and MUST NOT share words: each line's `first` MUST be
greater than the previous line's `last`. The validator does not require the lines of a cue to be contiguous;
producers SHOULD make them contiguous.

`text` is derived data, compared with the raw word texts without collapsing whitespace: the words `"Hello"` and
`"everyone,"` require exactly `"Hello everyone,"`. It lets simple tools read a cue without resolving ranges.
Consumers that render words SHOULD build the line from the words ([§14.6](#146-rendering-words-and-classes)).

## 10. Edits

`edits` lists accepted changes a producer (typically an automated editor) made to the transcript. Each element is
an object:

| Member | Type | Required | Constraints | Meaning |
|---|---|---|---|---|
| `words` | word range | yes | `last` less than the number of words. | The words *as they are now*, after the change. |
| `from` | string | yes | | The original text. |
| `to` | string | yes | | The new text. SHOULD equal the referenced words joined by single spaces. |
| `reason` | string | yes | An [edit reason](#123-edit-reasons). | Why the change was made. |

Edits are a record, not instructions: the words already hold the result. Consumers MUST NOT apply edits to the
words. A change may alter the word count, so `from` need not have as many words as the range:
`{ "words": [13, 13], "from": "Drive Cover", "to": "DriveCover" }` records two words that became one.

Rejected proposals are not part of the document. The validator checks each edit's shape and range bounds; it does
not check `to` against the words, overlap between edits, or speakers.

## 11. Meta

`meta` is an optional object about the document and how it was made. Every known member is an optional string or
an object of optional strings. Any other member is allowed.

| Member | Type | Meaning |
|---|---|---|
| `title` | string | Title of the media. |
| `context` | string | What the media is about, as given to the producer (it can steer transcription and editing). |
| `style` | object | The writing style the producer applied (below). |
| `models` | object | Models or services used, each an optional string such as `"azure-speech:fast"`: `text` (transcription), `timing` (word timing and speakers), `second` (a second speech engine whose hearing of the whole file was also used for timing or text), `llm` (editor). |
| `generator` | string | The producing program, RECOMMENDED as `name@version`, such as `"overtone-captions@0.1.0"`. |
| `createdAt` | string | Creation time. SHOULD be an RFC 3339 date-time in UTC, such as `"2026-10-17T09:00:00Z"`. The validator checks only that it is a string. |

`meta.style` members:

| Member | Type | Values |
|---|---|---|
| `numbers` | string | `digits`, `words` or `auto` ([§12.4](#124-number-and-currency-styles)). |
| `currency` | string | `symbol`, `code`, `words` or `auto`. |
| `guide` | string | Free-text style guide. |

`meta` is descriptive: it MUST NOT change which words, cues or times a consumer presents.

## 12. Vocabularies

The values in this section are closed sets in version 1. A validator MUST reject any other value. Only a new
format version can add values ([§15.3](#153-changes-that-require-a-new-version)).

### 12.1 Style classes

Classes describe a word's role in the message. They say nothing about color, weight or size. A word MAY carry
several classes. The reference producer asks for one class per word and combines only `key` with another.

| Class | Meaning | Example |
|---|---|---|
| `emphasis` | A word the speaker clearly stresses. | "you're **insured**" |
| `key` | Part of a short phrase the viewer should remember: the heart of the core message. | "for just **$12 a month.**" |
| `brand` | A brand, product, company or organization, including its programs, missions and vehicles. Not a person's name. | "**DriveCover** from **Lumora**" |
| `number` | Figures, prices, dates and percentages. | "**$12**", "**2008**" |
| `soft` | An aside or filler of lower importance. | "Sounds good, **actually.**" |

Classes SHOULD be used sparingly. The reference producer styles at most 15% of the words and keeps at most one
`key` phrase per cue.

Producers SHOULD write classes in table (registry) order: `emphasis`, `key`, `brand`, `number`, `soft`. Consumers
MUST NOT give meaning to the order.

### 12.2 Match kinds

`match` says how a word's timing was obtained when its text and timing came from different sources (in the
reference producer, the text hearing gives the words and the timing hearing gives word times and speakers). It is
OPTIONAL; absent means not recorded.

| Kind | Meaning |
|---|---|
| `exact` | Matched a timed word with the same normalized text. |
| `fuzzy` | Matched timed speech with a different spelling or lower similarity. |
| `split` | Several text words shared the time of fewer timed words; the time was divided among them. |
| `merge` | One text word spans several timed words, such as `DriveCover` for "drive cover". |
| `interpolated` | No timed speech matched; the time was estimated between the neighboring words. |
| `edited` | Created or replaced by an accepted [edit](#10-edits); its time was kept or redistributed from the words it replaced. |

`confidence` is the producer's confidence, from 0 to 1, that the word's text and timing match. It is not a speech
recognition probability. The reference producer stores the alignment similarity, 0 for `interpolated` words, and
for `edited` words the lowest confidence of the words they replaced. Tools MAY use `match` and `confidence` to flag
words for review; players SHOULD NOT change the presentation because of them.

### 12.3 Edit reasons

| Reason | Meaning |
|---|---|
| `correction` | A transcription error: the new word looks or sounds very similar to the old one. |
| `brand` | Spelling of a brand, product or person name (for example from a glossary). |
| `style` | Applying `meta.style`, such as number or currency notation. The numeric value is unchanged. |
| `punctuation` | Punctuation or capitalization only. |
| `split-word` | A word that was wrongly split or joined. |

### 12.4 Number and currency styles

| Member | Value | Meaning |
|---|---|---|
| `numbers` | `digits` | Digits ("5", "1,000", "3rd"). |
| | `words` | Words ("five", "one thousand", "third"). |
| | `auto` | No preference; numbers are kept as transcribed. |
| `currency` | `symbol` | Currency symbol ("€12"). |
| | `code` | ISO 4217 code ("EUR 12"). |
| | `words` | Words ("twelve euros"). |
| | `auto` | No preference. |

## 13. Validation

### 13.1 Procedure

The reference `validate(value)` never throws. It returns `{ valid, errors }`, each error `{ path, message }`, and
reports every issue it finds, not only the first. `assertValid(value)` returns the document when valid, and
otherwise throws an `Error` whose message is `Invalid Overtone document (N issues):` followed by one
`- path: message` line per issue.

Paths use dot and bracket notation from the root, such as `turns[0].words[3].end`. The root is `$`.

Checks run in this order: `format`, `version`, `language`, `duration`, `speakers`, `turns`, `profiles`, `edits`,
`meta`. Two rules limit follow-up noise:

1. **Cross-reference checks need valid turns.** Any issue inside `turns` (including an unknown turn speaker) makes
   the global word list unknown. The checks that need it are then skipped: word range bounds, cue speaker
   membership, line text and edit range bounds. The shape of every range is still checked.
2. **Checks continue from the last good value.** An invalid word or cue time is reported, and the next overlap
   check compares against the last valid `end`. A line whose range is malformed, out of bounds or not after the
   previous line is reported once, and its speaker and text checks are skipped. A cue with an unknown speaker is
   reported, and the speaker membership of its lines is not checked.

Other conforming validators MAY report issues in another order, with other messages or in another structure, but
MUST reject exactly the same documents.

### 13.2 Error catalog

Each condition below makes a document invalid. Messages are the reference validator's; `<x>` is a value from the
document. `T` is "must be a non-negative number of seconds with at most 3 decimals". `R` is "must be an inclusive
[first, last] range of word indices with first <= last".

| Path | Condition | Message |
|---|---|---|
| `$` | Root is not a JSON object (null, an array, a string, ...). No other check runs. | document must be a JSON object |
| `format` | Not exactly `"overtone"`. | must be "overtone" |
| `version` | Not exactly `1`. | must be 1 |
| `language` | Not a non-empty string. | must be a non-empty BCP-47 language code |
| `duration` | Not a [time value](#51-time-value). | `T` |
| `speakers` | Not an array. | must be an array |
| `speakers[i]` | Not an object. | must be an object |
| `speakers[i].id` | Not a non-empty string. | must be a non-empty string |
| `speakers[i].id` | Same as an earlier speaker's id. | duplicate speaker id "`<id>`" |
| `speakers[i].label`, `.role` | Present and not a string. | must be a string |
| `turns` | Not an array. | must be an array |
| `turns[i]` | Not an object. | must be an object |
| `turns[i].speaker` | Not the id of a valid speaker. | unknown speaker "`<speaker>`" |
| `turns[i].start`, `.end` | Not a time value. | `T` |
| `turns[i].end` | Less than `start`. | must be >= start |
| `turns[i].words` | Not an array, or empty. | must be a non-empty array |
| `turns[i].words[j]` | Not an object. | must be an object |
| `turns[i].words[j].text` | Not a non-empty string. | must be a non-empty string |
| `turns[i].words[j].text` | Only whitespace. | must contain non-whitespace text |
| `turns[i].words[j].start`, `.end` | Not a time value. | `T` |
| `turns[i].words[j].end` | Less than `start`. | must be >= start |
| `turns[i].words[j].start` | Less than the previous word's `end` in the same turn. | overlaps the previous word (words in a turn must be ordered and non-overlapping) |
| `turns[i].words[j].classes` | Present and not an array. | must be an array |
| `turns[i].words[j].classes[k]` | Not a style class. | unknown class "`<x>`" (allowed: emphasis, key, brand, number, soft) |
| `turns[i].words[j].classes[k]` | Same as an earlier element. | duplicate class "`<x>`" |
| `turns[i].words[j].match` | Present and not a match kind. | must be one of exact, fuzzy, split, merge, interpolated, edited |
| `turns[i].words[j].confidence` | Present and not a number from 0 to 1. | must be a number from 0 to 1 |
| `profiles` | Not an array. | must be an array |
| `profiles[i]` | Not an object. | must be an object |
| `profiles[i].id` | Not a non-empty string. | must be a non-empty string |
| `profiles[i].id` | Does not match `^[A-Za-z0-9_-]+$`. | must contain only letters, digits, '-' and '_' |
| `profiles[i].id` | Same as an earlier profile's id. | duplicate profile id "`<id>`" |
| `profiles[i].aspect` | Not a string `W:H` of two positive integers without leading zeros (also when missing). | must be a ratio "W:H" of two positive integers without leading zeros, such as "16:9" |
| `profiles[i].description` | Present and not a string. | must be a string |
| `profiles[i].window` | Present and not an object. | must be an object |
| `profiles[i].window.start`, `.end` | Not a time value. | `T` |
| `profiles[i].window` | `end` not greater than `start`. | start must be before end |
| `profiles[i].rules` | Not an object (also when missing). | must be an object |
| `profiles[i].rules.maxCharsPerLine`, `.maxLines` | Not a positive integer (also when missing). | must be a positive integer |
| `profiles[i].rules.maxCps`, `.minDuration`, `.maxDuration` | Present and not a finite number > 0. | must be a positive number |
| `profiles[i].cues` | Not an array. | must be an array |
| `…cues[k]` | Not an object. | must be an object |
| `…cues[k].start`, `.end` | Not a time value. | `T` |
| `…cues[k].end` | Not greater than `start`. | must be after start |
| `…cues[k].start` | Less than the previous cue's `end` in the same profile. | overlaps the previous cue (cues must be ordered and non-overlapping) |
| `…cues[k].speaker` | Not the id of a valid speaker. | unknown speaker "`<speaker>`" |
| `…cues[k].lines` | Not an array, or empty. | must be a non-empty array |
| `…lines[l]` | Not an object. | must be an object |
| `…lines[l].text` | Not a string. | must be a string |
| `…lines[l].words` | Not a word range of the right shape. | `R` |
| `…lines[l].words` | `last` not less than the number of words. | word index `<last>` is out of bounds (document has `<n>` words) |
| `…lines[l].words` | `first` not greater than the previous line's `last`. | must start after the previous line (lines are ordered and do not share words) |
| `…lines[l].words` | A referenced word belongs to another speaker than the cue (the first such word is reported). | word `<index>` belongs to speaker "`<a>`", not "`<b>`" (a cue never spans two speakers) |
| `…lines[l].text` | Not equal to the referenced word texts joined by single spaces. | must equal the referenced words joined by single spaces: "`<expected>`" |
| `edits` | Present and not an array. | must be an array |
| `edits[i]` | Not an object. | must be an object |
| `edits[i].words` | Not a word range of the right shape. | `R` |
| `edits[i].words` | `last` not less than the number of words. | word index `<last>` is out of bounds (document has `<n>` words) |
| `edits[i].from`, `.to` | Not a string. | must be a string |
| `edits[i].reason` | Not an edit reason. | must be one of correction, brand, style, punctuation, split-word |
| `meta` | Present and not an object. | must be an object |
| `meta.title`, `.context`, `.generator`, `.createdAt` | Present and not a string. | must be a string |
| `meta.style` | Present and not an object. | must be an object |
| `meta.style.numbers` | Present and not a number style. | must be one of digits, words, auto |
| `meta.style.currency` | Present and not a currency style. | must be one of symbol, code, words, auto |
| `meta.style.guide` | Present and not a string. | must be a string |
| `meta.models` | Present and not an object. | must be an object |
| `meta.models.text`, `.timing`, `.second`, `.llm` | Present and not a string. | must be a string |

"An integer" accepts any JSON number without a fractional part (`2` and `2.0` are the same number). "Present"
means the member exists with any value other than JavaScript `undefined`; JSON `null` is present and fails the
type check. An array hole is checked like an element that is not an object.

### 13.3 What validation does not check

*(informative)* A valid document can still be a poor one. The validator does not check that turns are
chronological or non-overlapping, that turn or cue times match their words, that times or windows lie within
`duration`, that a profile's cues cover every word once, that cues respect `rules`, that an edit's `to` matches its
words, or that `language` is a real BCP 47 tag. [§16](#16-guidance-for-producers) recommends all of these, and
consumers MUST NOT rely on them.

## 14. Processing rules for consumers

### 14.1 Validation before use

A consumer SHOULD validate a document before use, and SHOULD refuse to present an invalid one rather than guess.
The reference player validates with `assertValid`; on failure it logs the error, shows no captions, hides its
captions button and does not throw.

A consumer MUST NOT process a document whose `format` is not `"overtone"`, or whose `version` it does not support,
as if it were version 1.

### 14.2 Unknown members

Consumers MUST ignore unknown members at every level and MUST NOT fail because of them. A consumer that rewrites a
document (such as an editor saving it) SHOULD keep unknown members.

Unknown *values* of the closed vocabularies ([§12](#12-vocabularies)) differ: they make a version 1 document
invalid. A consumer that renders without validating, or validates leniently, MUST NOT fail on an unknown style
class, and SHOULD render the word as if that class were absent. The reference renderer turns only known classes
into CSS classes.

### 14.3 Profile selection

A consumer presents one profile at a time, chosen by the shape of the picture, not by id.

1. When the user or embedding page names a profile id that is in the document, the consumer SHOULD use that
   profile. When the named id is not in the document, it selects as in step 2.
2. Otherwise (the reference player's `profile: 'auto'`), the consumer measures the **visible picture**: the part
   of its display area where video is shown. That is the letterboxed video; when the video is cropped or stretched
   to fill the display area, it is the whole display area. When the video does not fill the display area in either
   direction (at its own size, CSS `object-fit: none` or `scale-down`), it is the video's rectangle, without the
   part outside the display area. The consumer SHOULD use the profile whose `aspect` is closest to that picture's
   aspect (width ÷ height): the smallest |ln(picture aspect) − ln(profile aspect)|. Distances within 1e-9 of each
   other tie (so 4:3, exactly halfway between 1:1 and 16:9, gets 16:9 over 1:1). A tie goes to the wider profile
   (larger aspect), and between equal aspects to the earlier profile in `profiles`.
3. Before the picture shape is known (such as before the video's metadata loads), the consumer SHOULD use the shape
   of its display area. An unknown or zero size counts as 16:9.
4. When `profiles` is empty, there is nothing to show.

A consumer whose picture changes shape (resize, rotation, fullscreen, a new video size mid-stream) SHOULD repeat
the selection and switch profiles while playing. All profiles share the same words, so switching never changes
what was said or when.

`overtone-format` implements step 2 as `closestProfile(profiles, pictureAspect)`, with `parseAspect(aspect)` to
turn an `aspect` into a number.

### 14.4 Time lookup

At media time `t`, a cue is **active** when `cue.start ≤ t < cue.end`. A cue ending at 2.0 is not shown at 2.0; a
cue starting at 2.0 is. Cues of a profile are ordered and do not overlap, so at most one is active, and consumers
MAY find it by binary search (the reference `findCueIndex`).

A word is **being spoken** when `word.start ≤ t < word.end`, so a zero-length word never is. Consumers MAY highlight
it; the reference player gives its element the class `ot-active`.

A consumer MAY keep a cue on screen during a short gap before the next cue to avoid flicker. The reference player
holds the previous cue when the next starts less than 100 ms after it ended (compared in whole milliseconds). A
hold MUST NOT extend a cue past the next cue's start and MUST respect the window ([§14.5](#145-windows)).

### 14.5 Windows

For a profile with a `window`:

- A consumer MUST NOT show any cue of the profile at a time `t` outside [`window.start`, `window.end`).
- A cue that ends at or before `window.start`, or starts at or after `window.end`, MUST be dropped. Other cues are
  clamped: start `max(cue.start, window.start)`, end `min(cue.end, window.end)`. This is the reference
  `clipCuesToWindow`.
- A cue that ends at or before `window.start` MUST NOT be held into the window ([§14.4](#144-time-lookup)).

Exporters MUST clip the same way, so exported files show what a player shows
([§17](#17-conversion-to-webvtt-srt-and-plain-text)). Words and turns are not clipped.

### 14.6 Rendering words and classes

Consumers SHOULD build each line from the words of its range, in order, joined by single spaces, so each word keeps
its timing and classes. A consumer that needs only text MAY use `line.text`, which is guaranteed to equal the
joined word texts. Word text MUST be rendered as text, never as markup
([§18](#18-security-and-privacy-considerations)).

Classes say what a word means; the consumer chooses the look. The reference player:

- has three modes, **off**, **styled** and **plain**, and applies class styling only in styled mode (plain shows
  the same words and lines in the theme's look, without emphasis);
- renders each word as an element with the classes `ot-word` and `ot-<class>` for each known class;
- keeps the space between two adjacent `key` words inside the first word's element, so a highlight behind a key
  phrase forms one continuous box.

Consumers SHOULD let viewers turn class styling off, and SHOULD keep captions readable when it is off.

### 14.7 Speaker labels

A speaker's display label is its `label` with every whitespace run collapsed to one space and trimmed. When there
is no label or the result is empty, it is the id, collapsed and trimmed the same way. An id not in `speakers` is
shown as itself.

Showing labels is the consumer's choice. The reference player has three settings: `never` (default), `always`
(every cue) and `change` (a cue gets its label when its speaker differs from the previous cue's; the first cue, and
the first cue after the window start, get a label only when the document lists more than one speaker). `role` is
not shown.

### 14.8 Text size

A profile with shorter lines is cut for a narrower picture. Consumers SHOULD scale text inversely to
`rules.maxCharsPerLine`, so a full line spans the same share of the picture width in every profile. The reference
player sets the font size to `--ot-font-size` × 42 ÷ `maxCharsPerLine`, where `--ot-font-size` is the size for a
42-character line.

## 15. Versioning and extensibility

### 15.1 The `version` member

`version` is an integer naming the version of this specification a document follows. This document defines
version 1. A version 1 validator rejects every other value, so a document for a later version is never silently
read with version 1 rules.

### 15.2 Changes that keep version 1

A future revision MAY, without changing `version`:

- add OPTIONAL members to any object, provided a consumer that ignores them still presents correct captions;
- add recommendations for producers or consumers;
- clarify text, examples and the error catalog without changing which documents are valid.

Validators accept unknown members, so documents that use such additions stay valid for older validators, and older
consumers keep working by ignoring them.

### 15.3 Changes that require a new version

These changes MUST increase `version`:

- adding a value to a closed vocabulary ([§12](#12-vocabularies)): style class, match kind, edit reason, number or
  currency style (version 1 validators reject unknown values);
- adding a required member, or making an optional member required;
- removing a member, or changing its type, unit or meaning (such as times in milliseconds);
- tightening or relaxing a constraint so that the set of valid documents changes in a way existing consumers could
  misread (such as allowing overlapping cues, or exclusive word ranges);
- changing the global word numbering.

A new version gets a new specification document and an entry in the [changelog](changelog.md). Producers SHOULD
write the lowest version whose features they use.

### 15.4 Extension members

Producers MAY add their own members to any object, provided every extension is safe to ignore. Extension member
names SHOULD contain a colon after a vendor or project prefix, such as `"acme:position"`. This specification
reserves every member name without a colon for itself, and will never define a name with a colon.

Data about the whole document MAY go in `meta` instead, which allows any member. Members of `meta` are exempt from
the reservation, so producers MAY name them without a colon; a later revision may define more `meta` members, so a
prefixed name still avoids collisions there.

Extensions MUST NOT change the meaning of members defined here. For example, an extension MUST NOT make words
invisible, because consumers that ignore it would still show them.

## 16. Guidance for producers

The reference producer is the `overtone-captions` command line ([packages/cli](../../packages/cli)). Its behavior is
noted where it makes a recommendation concrete.

### 16.1 Times and rounding

- Producers MUST round every time value to whole milliseconds before writing it. The reference function is
  `roundTime(s) = round(s × 1000) / 1000`. Working in integer milliseconds avoids drift.
- Producers SHOULD set `duration` to the media length, and at least to the latest time in the document. The
  reference producer uses the larger of the media length and the last turn's end.
- Producers SHOULD keep all times within `duration`.

### 16.2 Turns and words

- A turn SHOULD hold one uninterrupted run of a speaker's words; a speaker change starts a new turn. Consecutive
  turns MAY have the same speaker (such as after a long pause); consumers keep them apart.
- Turns SHOULD be chronological and SHOULD NOT overlap, so global word order is spoken order.
- A turn's `start` SHOULD equal its first word's `start`, and its `end` its last word's `end`.
- Each word SHOULD be one written word with its punctuation attached (`"part?"`, `"Lumora,"`). Punctuation-only
  tokens SHOULD be attached to a neighboring word.
- A speaker boundary SHOULD fall at a sentence end where possible, so a turn does not start mid-sentence.
- Producers that align text from one source with timing from another SHOULD record `match` and `confidence`.

### 16.3 Building cues

For each profile:

- Every word SHOULD appear in exactly one line of exactly one cue, in global order. Lines within a cue SHOULD be
  contiguous.
- A cue MUST hold the words of one speaker; a speaker change always starts a new cue.
- A cue SHOULD start at its first word's `start` (or the previous cue's `end`, if later) and end no earlier than
  its last word's `end`.
- A cue MAY be extended past its last word to reach `minDuration` or `maxCps`, but not into the next cue and not
  past `duration`. An extension SHOULD NOT hide a pause the producer shows as a cue break. The reference producer
  (rule set 1) extends by at most 1.5 s, never beyond `maxDuration`, and keeps at least 0.4 s blank before the next
  cue when 1 s or more of silence follows the cue's last word. It never moves a cue's start, and closes gaps under
  0.1 s between two cues of the same speaker (never across a speaker change).
- Lines and cues SHOULD NOT break inside a group that belongs together: a name, a number with its unit or currency
  ("$12 a month", "one in five"), a glossary term. A line SHOULD NOT end on an article, preposition or auxiliary
  verb when the sentence continues. A cue SHOULD NOT end inside a short sentence that fits one cue, unless a pause
  follows the break.
- Breaks SHOULD show the vocal situation: a long pause SHOULD start a new cue, and a shorter hesitation MAY show as
  a line break. The reference producer (rule set 1) always starts a cue at a pause of 1.5 s, starts one at 1 s
  unless a cue would then be on screen under 0.7 s, and treats pauses from 0.4 s as hesitations, weighted by
  length: a break before a pause of 0.6 s or more costs no more than a break after a comma.
- `line.text` MUST be computed from the words (joined by single spaces), never typed separately.
- Profiles with different aspects SHOULD be cut separately: a cut for a tall picture is not a re-wrapped cut for a
  wide one.

### 16.4 Applying rules

When a producer writes `rules`, its cues SHOULD respect them, measured as follows:

- **maxCharsPerLine**: the length of `line.text`. The reference producer counts extended grapheme clusters
  ([UAX #29](https://www.unicode.org/reports/tr29/)), as `Intl.Segmenter` with `granularity: 'grapheme'` does: a
  letter with a combining accent, an emoji with a skin tone, or a flag is one character. A line holding one word
  longer than the limit is tolerated.
- **maxLines**: the number of lines in the cue.
- **maxCps**: the cue's characters divided by `end − start`, where the characters are the lengths of all its lines
  plus one per line break.
- **minDuration** and **maxDuration**: `end − start` in seconds. A cue holding a single word is allowed to exceed
  `maxDuration`.

Speech can be faster than the reading rules allow. A producer MAY then break `maxCps` or `minDuration` rather than
drop words or move them away from when they are spoken.

The reference producer's rules for its two default profiles:

| Profile id | `aspect` | `description` | `maxCharsPerLine` | `maxLines` | `maxCps` | `minDuration` | `maxDuration` |
|---|---|---|---|---|---|---|---|
| `horizontal` | `16:9` | TV/desktop | 42 | 2 | 17 | 1.0 | 7.0 |
| `vertical` | `9:16` | Phone | 22 | 2 | 15 | 0.8 | 5.0 |

For any other aspect it interpolates each value linearly in ln(aspect) between these rows, and clamps outside them
(wider than 16:9 gets `horizontal`, taller than 9:16 gets `vertical`). `maxLines` is 2 throughout. Examples:

| `aspect` | `maxCharsPerLine` | `maxCps` | `minDuration` | `maxDuration` |
|---|---|---|---|---|
| `4:3` | 37 | 16.5 | 0.95 | 6.5 |
| `1:1` | 32 | 16 | 0.9 | 6 |
| `4:5` | 28 | 15.61 | 0.86 | 5.61 |

### 16.5 Styling

- Classes SHOULD mark what matters, not decorate. The reference producer enforces at most 15% styled words and at
  most one `key` phrase per cue, and asks its editor for `key` phrases of at most 4 words, never whole sentences.
- `brand` SHOULD NOT be used for people's names.
- Producers SHOULD omit `classes` rather than write an empty array, and SHOULD write classes in registry order.

### 16.6 Recording edits

- A producer that changes transcript text after transcription (spelling, brand names, punctuation, number style)
  SHOULD record each accepted change in `edits`: the original text in `from`, the new text in `to` and the
  resulting words in `words`.
- `words` MUST refer to the words of the final document. A producer that applies several edits MUST compute each
  range in the final numbering.
- `to` SHOULD equal the referenced words joined by single spaces.
- Words created or replaced by an edit SHOULD get `match: "edited"`. When an edit keeps the word count, each new
  word SHOULD keep the time of the word it replaces; otherwise the time of the replaced span SHOULD be divided among
  the new words, at least 1 ms each.
- Edits SHOULD NOT overlap and SHOULD NOT span a speaker change.
- An edit SHOULD say what was spoken, and SHOULD NOT paraphrase, reorder or drop content. The reference producer's
  editor corrects misheard words (names, numbers and negations included), puts the edits it was unsure about on the
  review list (`meta.review`, a producer member described in the [CLI reference](../cli/reference.md)), and does not
  store edits rejected for their structure.

### 16.7 Speakers and meta

- Speaker ids SHOULD be stable within a document and SHOULD NOT contain whitespace (a whitespace-only id gives an
  empty display label).
- A producer that knows a speaker's name SHOULD set `label`. A label that only repeats the id ("S1", "Speaker 2")
  SHOULD be omitted.
- Producers SHOULD set `meta.generator` and `meta.createdAt`, and MAY record `meta.context`, `meta.style` and
  `meta.models` to make the result reproducible (see [§18](#18-security-and-privacy-considerations) for what
  `context` may reveal).

## 17. Conversion to WebVTT, SRT and plain text

The reference exporters are in [packages/format/src/export](../../packages/format/src/export). They expect a valid
document, take one profile's cues after window clipping ([§14.5](#145-windows)), and build every line from its
words, not from `line.text`. Each word's text has its whitespace runs collapsed to one space and trimmed. A profile
id not in the document is an error ("Unknown profile").

Conversion keeps one profile's line cut and cue timing. It loses word timing (except WebVTT with `wordTimings`),
`match`, `confidence`, speaker roles, edits and meta. SRT and plain text also lose the classes.

### 17.1 Timestamps

`hh:mm:ss.mmm` (WebVTT) or `hh:mm:ss,mmm` (SRT), rounded to the nearest millisecond with carry (`59.9996` becomes
`00:01:00.000`). Hours have at least two digits.

### 17.2 WebVTT

`toWebVTT(doc, profileId, { styled, wordTimings })` writes:

1. the line `WEBVTT`;
2. for each cue, a blank line, the timing line `start --> end`, and the cue text;
3. a final line break. A profile without cues gives `WEBVTT` and a line break.

The cue text starts with a voice tag `<v Label>` holding the speaker's display label
([§14.7](#147-speaker-labels)), followed by the lines joined by line breaks. Each line is its words joined by single
spaces. In word text and labels, `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`. A label ending in `-` gets a
trailing space, so it cannot form `-->` with the closing `>`.

With `styled` (default), each word with classes is wrapped in a class span, `<c.class1.class2>word</c>`, classes in
stored order. With `styled: false` there are no class spans; voice tags remain. No cue identifiers, cue settings or
`STYLE` blocks are written. Players with WebVTT styling can target classes with `::cue(.key)`.

With `wordTimings` (default false), a word gets a timestamp tag before it (and before its class span):
`<00:00:01.200>word`, its start written as in [§17.1](#171-timestamps). WebVTT requires each tag to lie after the
cue start, before the cue end and after the previous tag, compared in whole milliseconds. A word whose start does
not is written without a tag (usually a cue's first word, which starts with the cue).

### 17.3 SubRip (SRT)

`toSRT(doc, profileId)` writes, per cue, its number (from 1, after window clipping), the timing line
`start --> end`, the lines, and a blank line between cues. The text is plain: no speaker labels, no styling.
SubRip has no escapes, and players read some text as markup, so three sequences become lookalikes: `-->` becomes
`→` (U+2192); `<` followed by a letter, or by `/` and a letter, becomes `‹` (U+2039); `{\` becomes `｛\` (U+FF5B,
then the backslash). So `<i>` is written `‹i>` and `{\an8}` is written `｛\an8}`. All other text is unchanged. A
profile without cues gives an empty string.

### 17.4 Plain-text transcript

`toTranscript(doc)` writes one paragraph per turn, `Label: words`, the turn's words joined by single spaces,
paragraphs separated by a blank line, ending with a line break. Consecutive turns of one speaker stay separate
paragraphs. A document without turns gives an empty string. The transcript ignores profiles and windows.

### 17.5 File names

*(informative)* The reference command line writes `<base>.overtone.json`, `<base>.player.overtone.json`
([§17.6](#176-player-document)), `<base>.<profileId>.vtt`, `<base>.<profileId>.words.vtt` (WebVTT with
`wordTimings`), `<base>.<profileId>.srt` and `<base>.txt`, and with burned-in captions `<base>.captioned.mp4`. The profile id restriction ([§5.3](#53-identifiers))
keeps these names safe.

### 17.6 Player document

`toPlayerDocument(doc, { profiles })` returns a valid document with what a player reads: `format`, `version`,
`language`, `duration`, the speakers, the turns with each word's `text`, `start`, `end` and `classes`, and the
chosen profiles (default: all). It leaves out `meta`, `edits`, and each word's `match` and `confidence`, which only
authoring tools read. Use it to publish captions without the authoring record.

## 18. Security and privacy considerations

- **Untrusted input.** Documents often come from the network. Consumers SHOULD validate them
  ([§14.1](#141-validation-before-use)). The reference validator never throws, even on values that are not
  JSON-shaped. Line checks resolve every referenced word, so a document with many cues over long ranges costs time
  in proportion to the referenced words; consumers that accept very large documents SHOULD limit their size.
- **Text is not markup.** Word text, speaker labels and descriptions MUST be rendered as text. The reference player
  sets text content and never parses HTML; the WebVTT exporter escapes `&`, `<` and `>`; the SubRip exporter
  replaces text players would read as a tag or timing line ([§17.3](#173-subrip-srt)).
- **Names in identifiers.** Profile ids are limited to `[A-Za-z0-9_-]` because they end up in file names and CSS
  class names. Speaker ids and labels are not limited; a consumer that puts them in markup, CSS or file names MUST
  sanitize them first (the reference player uses speaker ids only as data attribute values).
- **What a document reveals.** `meta.context`, `meta.style.guide`, `meta.models` and `edits` can reveal how the
  media was made, including prompts and the wording before corrections. Producers SHOULD review them before
  publishing a document next to public media.

## 19. Examples

### 19.1 Minimal document

One speaker, two words, one profile. Valid with both the reference validator and the JSON Schema.

```json
{
  "format": "overtone",
  "version": 1,
  "language": "en",
  "duration": 1.5,
  "speakers": [{ "id": "S1" }],
  "turns": [
    {
      "speaker": "S1", "start": 0.2, "end": 1.1,
      "words": [
        { "text": "Hello", "start": 0.2, "end": 0.6 },
        { "text": "world.", "start": 0.65, "end": 1.1 }
      ]
    }
  ],
  "profiles": [
    {
      "id": "horizontal",
      "aspect": "16:9",
      "rules": { "maxCharsPerLine": 42, "maxLines": 2 },
      "cues": [
        { "start": 0.2, "end": 1.2, "speaker": "S1", "lines": [{ "words": [0, 1], "text": "Hello world." }] }
      ]
    }
  ]
}
```

The empty document, with `"speakers": []`, `"turns": []` and `"profiles": []`, is also valid: media without
speech.

### 19.2 Full annotated example

This document uses every member defined here, plus two extension members. It is valid with both the reference
validator and the JSON Schema.

```json
{
  "format": "overtone",
  "version": 1,
  "language": "en",
  "duration": 7,
  "speakers": [
    { "id": "S1", "label": "Maya", "role": "host" },
    { "id": "S2", "label": "Tom" }
  ],
  "turns": [
    {
      "speaker": "S1",
      "start": 0.5,
      "end": 4.86,
      "words": [
        { "text": "With", "start": 0.5, "end": 0.76, "match": "exact", "confidence": 1 },
        { "text": "DriveCover", "start": 0.79, "end": 1.361, "classes": ["brand"], "match": "merge", "confidence": 0.91 },
        { "text": "from", "start": 1.391, "end": 1.651 },
        { "text": "Lumora,", "start": 1.681, "end": 2.045, "classes": ["brand"], "match": "edited", "confidence": 0.78 },
        { "text": "you're", "start": 2.249, "end": 2.53 },
        { "text": "insured", "start": 2.56, "end": 2.934, "classes": ["emphasis"] },
        { "text": "for", "start": 3.157, "end": 3.383 },
        { "text": "just", "start": 3.413, "end": 3.696 },
        { "text": "$12", "start": 3.726, "end": 4.348, "classes": ["key", "number"], "match": "edited", "confidence": 0.95 },
        { "text": "a", "start": 4.378, "end": 4.491, "classes": ["key"] },
        { "text": "month.", "start": 4.521, "end": 4.86, "classes": ["key"] }
      ]
    },
    {
      "speaker": "S2",
      "start": 5.5,
      "end": 6.62,
      "words": [
        { "text": "Sounds", "start": 5.5, "end": 5.82 },
        { "text": "good,", "start": 5.85, "end": 6.1 },
        { "text": "actually.", "start": 6.13, "end": 6.62, "classes": ["soft"], "match": "interpolated", "confidence": 0 }
      ]
    }
  ],
  "profiles": [
    {
      "id": "horizontal",
      "description": "TV/desktop",
      "aspect": "16:9",
      "rules": { "maxCharsPerLine": 42, "maxLines": 2, "maxCps": 17, "minDuration": 1, "maxDuration": 7 },
      "cues": [
        {
          "start": 0.5, "end": 3.03, "speaker": "S1",
          "lines": [
            { "words": [0, 3], "text": "With DriveCover from Lumora," },
            { "words": [4, 5], "text": "you're insured" }
          ]
        },
        {
          "start": 3.157, "end": 4.86, "speaker": "S1",
          "lines": [{ "words": [6, 10], "text": "for just $12 a month." }]
        },
        {
          "start": 5.5, "end": 6.794, "speaker": "S2",
          "lines": [{ "words": [11, 13], "text": "Sounds good, actually." }]
        }
      ]
    },
    {
      "id": "vertical",
      "description": "Phone, first five seconds only",
      "aspect": "9:16",
      "window": { "start": 0, "end": 5.2 },
      "rules": { "maxCharsPerLine": 22, "maxLines": 2, "maxCps": 15, "minDuration": 0.8, "maxDuration": 5 },
      "cues": [
        {
          "start": 0.5, "end": 2.249, "speaker": "S1",
          "lines": [
            { "words": [0, 1], "text": "With DriveCover" },
            { "words": [2, 3], "text": "from Lumora," }
          ]
        },
        {
          "start": 2.249, "end": 3.157, "speaker": "S1",
          "lines": [{ "words": [4, 5], "text": "you're insured" }]
        },
        {
          "start": 3.157, "end": 4.86, "speaker": "S1",
          "lines": [
            { "words": [6, 7], "text": "for just" },
            { "words": [8, 10], "text": "$12 a month." }
          ]
        },
        {
          "start": 5.5, "end": 6.967, "speaker": "S2",
          "lines": [
            { "words": [11, 12], "text": "Sounds good," },
            { "words": [13, 13], "text": "actually." }
          ]
        }
      ]
    }
  ],
  "edits": [
    { "words": [3, 3], "from": "Lumorra,", "to": "Lumora,", "reason": "brand" },
    { "words": [8, 8], "from": "twelve dollars", "to": "$12", "reason": "style" }
  ],
  "meta": {
    "title": "DriveCover spot (excerpt)",
    "context": "Fictional promotional clip for DriveCover, the car insurance product of Lumora Insurance",
    "style": { "numbers": "digits", "currency": "symbol", "guide": "Write product names as one word." },
    "models": { "text": "openai:gpt-transcribe", "timing": "azure-speech:fast", "llm": "anthropic:claude" },
    "generator": "overtone-captions@0.1.0",
    "createdAt": "2026-10-17T09:00:00Z",
    "acme:reviewedBy": "editorial desk"
  },
  "acme:campaign": "spring-2026"
}
```

Global word indices:

| Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Word | With | DriveCover | from | Lumora, | you're | insured | for | just | $12 | a | month. | Sounds | good, | actually. |
| Turn | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |

Notes:

1. **Words are numbered across turns.** Tom's first word, `Sounds`, is word 11, right after the last word of
   `turns[0]` (10).
2. **Ranges are inclusive.** `[0, 3]` is *With DriveCover from Lumora,* (four words); `[13, 13]` is *actually.*
   alone.
3. **Line text is derived.** Each `text` is exactly its words joined by single spaces. Changing `"you're insured"`
   to `"You're insured"` would make the document invalid; the fix belongs in the word.
4. **Two cuts of the same words.** `horizontal` puts words 0 to 5 in one two-line cue; `vertical` needs two cues
   for them and keeps *$12 a month.* together on one line.
5. **Cue timing.** Cues start at their first word and are extended for reading time. The first horizontal cue ends
   at 3.03 instead of 2.934, so its 43 characters stay under 17 per second, and still ends before the next cue
   (3.157). The first two vertical cues would need more time than the next cue leaves, so they end exactly where it
   starts (2.249 and 3.157): touching cues are allowed, and a cue may break `maxCps` when speech is that fast.
6. **One speaker per cue.** Words 11 to 13 are Tom's, so they start a new cue in both profiles.
7. **Window.** The vertical profile is limited to [0, 5.2). Its last cue (5.5 to 6.967) is outside: players never
   show it and exporters drop it. A cue crossing 5.2 would be cut at 5.2.
8. **Classes.** `$12 a month.` is the `key` phrase, and `$12` is also a `number`. `insured` is `emphasis`,
   `actually.` a `soft` aside, and the product and company names are `brand`.
9. **Match kinds.** `DriveCover` is one written word for two timed words (`merge`); `Lumora,` and `$12` come from
   edits (`edited`); `actually.` had no timed speech (`interpolated`, confidence 0). Words without `match` have none
   recorded.
10. **Edits.** Ranges use the final numbering: word 8 is now `$12`, replacing the two words *twelve dollars*.
    Consumers do not apply edits; they are a record.
11. **Extensions.** `acme:campaign` and `meta.acme:reviewedBy` are extension members
    ([§15.4](#154-extension-members)). Validators accept them; consumers ignore them.

The reference exporters produce the following. `toWebVTT(doc, "horizontal")`:

```text
WEBVTT

00:00:00.500 --> 00:00:03.030
<v Maya>With <c.brand>DriveCover</c> from <c.brand>Lumora,</c>
you're <c.emphasis>insured</c>

00:00:03.157 --> 00:00:04.860
<v Maya>for just <c.key.number>$12</c> <c.key>a</c> <c.key>month.</c>

00:00:05.500 --> 00:00:06.794
<v Tom>Sounds good, <c.soft>actually.</c>
```

`toSRT(doc, "vertical")` (Tom's cue is outside the window):

```text
1
00:00:00,500 --> 00:00:02,249
With DriveCover
from Lumora,

2
00:00:02,249 --> 00:00:03,157
you're insured

3
00:00:03,157 --> 00:00:04,860
for just
$12 a month.
```

`toTranscript(doc)`:

```text
Maya: With DriveCover from Lumora, you're insured for just $12 a month.

Tom: Sounds good, actually.
```

### 19.3 More examples

*(informative)*

- [examples/fixtures/sample.overtone.json](../../examples/fixtures/sample.overtone.json): a hand-made sample using
  every style class, used by the tests, the demo and the style gallery.
- [examples/output](../../examples/output): documents the reference producer wrote from real media, with their
  WebVTT, SRT and transcript exports.
- [packages/format/test](../../packages/format/test): tests of the validator, the JSON Schema and the exporters,
  including the invalid cases of [§13.2](#132-error-catalog).

## 20. References

### Normative

- <a id="ref-rfc2119"></a>**[RFC 2119]** Bradner, S., "Key words for use in RFCs to Indicate Requirement
  Levels", BCP 14, RFC 2119, March 1997. <https://www.rfc-editor.org/rfc/rfc2119>
- <a id="ref-rfc8174"></a>**[RFC 8174]** Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key
  Words", BCP 14, RFC 8174, May 2017. <https://www.rfc-editor.org/rfc/rfc8174>
- <a id="ref-rfc8259"></a>**[RFC 8259]** Bray, T., Ed., "The JavaScript Object Notation (JSON) Data
  Interchange Format", STD 90, RFC 8259, December 2017. <https://www.rfc-editor.org/rfc/rfc8259>
- <a id="ref-bcp47"></a>**[BCP 47]** Phillips, A., Ed., and M. Davis, Ed., "Tags for Identifying
  Languages", BCP 47, RFC 5646, September 2009. <https://www.rfc-editor.org/rfc/rfc5646>

### Informative

- **[JSON Schema]** "JSON Schema: A Media Type for Describing JSON Documents", draft 2020-12.
  <https://json-schema.org/draft/2020-12>
- **[RFC 3339]** Klyne, G. and C. Newman, "Date and Time on the Internet: Timestamps", RFC 3339, July 2002.
  <https://www.rfc-editor.org/rfc/rfc3339>
- **[WebVTT]** "WebVTT: The Web Video Text Tracks Format", W3C. <https://www.w3.org/TR/webvtt1/>
- **[SubRip]** The SubRip (`.srt`) subtitle format, as commonly implemented; it has no formal specification.
- **[overtone-format]** The reference implementation: [types](../../packages/format/src/types.ts),
  [validator](../../packages/format/src/validate.ts),
  [profile and cue checks](../../packages/format/src/validate-profiles.ts),
  [aspect parsing and profile selection](../../packages/format/src/aspect.ts),
  [cue lookup and window clipping](../../packages/format/src/cues.ts),
  [exporters](../../packages/format/src/export).

## Appendix A. JSON Schema coverage

*(informative)* [overtone.schema.json](../../packages/format/overtone.schema.json) (JSON Schema draft 2020-12)
checks the structure of a version 1 document: required members, types, the closed vocabularies, number ranges
(times ≥ 0, `confidence` from 0 to 1, positive `rules`), the profile id and aspect patterns, unique classes,
non-whitespace word text, non-empty `turns[].words` and `cues[].lines`, and the two-element shape of word ranges.
Like the validator, it allows unknown members everywhere.

The validator checks the same structure plus four kinds of semantic rules the schema leaves out:

1. **Time precision.** Times have at most 3 decimals ([§5.1](#51-time-value)).
2. **Order.** `first ≤ last` in word ranges; `end ≥ start` for turns and words, `end > start` for cues and windows;
   words within a turn and cues within a profile are ordered and do not overlap; lines within a cue are ordered and
   do not share words.
3. **Uniqueness.** Speaker ids and profile ids are unique.
4. **References.** Turn and cue speakers are declared in `speakers`; every word of a cue belongs to the cue's
   speaker; word ranges stay below the word count; line text equals the referenced word texts joined by single
   spaces.

Rules 2 to 4 relate one value to another (a sibling member, the previous array element, a list elsewhere in the
document), which standard JSON Schema cannot express; `uniqueItems` compares whole objects, not one member. Rule 1
could be written as `multipleOf: 0.001`, but implementations divide in binary floating point, so that rejects valid
times such as `0.823`, and it cannot apply the tolerance of [§5.1](#51-time-value). The schema states each rule in
the `description` of the definition it applies to.

So every document the validator accepts, the schema accepts too; a document the schema accepts is valid only if it
also meets these rules. Schema validation alone is not enough: conforming validators MUST check the full rules of
[§13.2](#132-error-catalog). The tests in [packages/format/test](../../packages/format/test) check that every
committed example passes both, that the validator rejects and the schema accepts a violation of each rule above,
and, by changing every value of a small document, that the two reject the same documents apart from these rules.

## Appendix B. Registry of reserved names

### B.1 Identification

| Item | Value |
|---|---|
| `format` value | `overtone` |
| `version` value | `1` |
| File extension | `.overtone.json` |
| Media type | `application/vnd.overtone+json` (suggested; not registered with IANA) |

### B.2 Member names

Every member name without a colon, except the members of `meta`, is reserved for this specification
([§15.4](#154-extension-members)). The names defined in version 1:

| Object | Members |
|---|---|
| Document | `format`, `version`, `language`, `duration`, `speakers`, `turns`, `profiles`, `edits`, `meta` |
| Speaker | `id`, `label`, `role` |
| Turn | `speaker`, `start`, `end`, `words` |
| Word | `text`, `start`, `end`, `classes`, `match`, `confidence` |
| Profile | `id`, `aspect`, `description`, `window`, `rules`, `cues` |
| Window | `start`, `end` |
| Rules | `maxCharsPerLine`, `maxLines`, `maxCps`, `minDuration`, `maxDuration` |
| Cue | `start`, `end`, `speaker`, `lines` |
| Line | `words`, `text` |
| Edit | `words`, `from`, `to`, `reason` |
| Meta | `title`, `context`, `style`, `models`, `generator`, `createdAt` |
| Meta style | `numbers`, `currency`, `guide` |
| Meta models | `text`, `timing`, `second`, `llm` |

### B.3 Vocabularies

| Vocabulary | Values (in registry order) |
|---|---|
| Style classes (`classes`) | `emphasis`, `key`, `brand`, `number`, `soft` |
| Match kinds (`match`) | `exact`, `fuzzy`, `split`, `merge`, `interpolated`, `edited` |
| Edit reasons (`reason`) | `correction`, `brand`, `style`, `punctuation`, `split-word` |
| Number styles (`meta.style.numbers`) | `digits`, `words`, `auto` |
| Currency styles (`meta.style.currency`) | `symbol`, `code`, `words`, `auto` |
