# The Overtone caption format

`.overtone.json` is an open JSON format for word-timed, speaker-aware captions. Each spoken word is stored once,
with its text, times, speaker and semantic style classes (`emphasis`, `key`, `brand`, `number`, `soft`).
Profiles cut those words into cues and lines, one picture shape each, such as `16:9` for TV and `9:16` for a phone.
Accepted corrections are recorded next to the words. Readers ignore members they do not know.

- [Specification, version 1](spec.md): data model, validation rules, player and exporter behavior, producer
  guidance.
- [Changelog](changelog.md)
- [JSON Schema](../../packages/format/overtone.schema.json) (published as `overtone-format/schema.json`): checks
  structure. The validator also checks time precision, order, unique ids and references
  ([Appendix A](spec.md#appendix-a-json-schema-coverage)).
- [Reference implementation](../../packages/format): `overtone-format` (types, validator, WebVTT, SRT and
  transcript exporters) and its [tests](../../packages/format/test).
- Examples: a [sample document](../../examples/fixtures/sample.overtone.json) and
  [pipeline output](../../examples/output).
