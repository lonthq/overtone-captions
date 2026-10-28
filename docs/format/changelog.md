# Changelog

Versions of the Overtone caption format. A version is the integer in a document's `version` member.
[§15 of the specification](spec.md#15-versioning-and-extensibility) says which changes need a new version.

## Version 1 (2026-10-17)

Initial version, implemented by `overtone-format` 0.1.0.

- Document members `format`, `version`, `language`, `duration`, `speakers`, `turns`, `profiles`, and optional
  `edits` and `meta`.
- Words stored once, in turns, with `text`, `start`, `end` and optional `classes`, `match` and `confidence`.
  Global word numbering in turn order, then word order, from 0.
- Profiles with a required `aspect` (such as `"16:9"`) and `rules`, an optional `description` and `window`, and
  cues whose lines refer to inclusive word ranges and carry the derived line text. Profile ids are free names.
- Profile selection by the aspect closest to the visible picture (ties go to the wider profile). Text scaled
  inversely to `rules.maxCharsPerLine`.
- Closed vocabularies: style classes `emphasis`, `key`, `brand`, `number`, `soft`; match kinds `exact`, `fuzzy`,
  `split`, `merge`, `interpolated`, `edited`; edit reasons `correction`, `brand`, `style`, `punctuation`,
  `split-word`; number styles `digits`, `words`, `auto`; currency styles `symbol`, `code`, `words`, `auto`.
- Times in seconds with at most 3 decimals. Cues and windows include their start and exclude their end.
- Unknown members allowed everywhere and ignored by consumers. Member names with a colon are left to extensions.
- A JSON Schema (draft 2020-12) for the structure. The validator also checks what the schema cannot express (time
  precision, order, unique ids, references), listed in Appendix A of the specification and in the schema's
  descriptions.
