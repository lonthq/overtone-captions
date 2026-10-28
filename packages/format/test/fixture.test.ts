import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenWords, STYLE_CLASSES, validate, type OvertoneDocument } from 'overtone-format';

const fixturePath = join(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');
const doc = JSON.parse(readFileSync(fixturePath, 'utf8')) as OvertoneDocument;

describe('examples/fixtures/sample.overtone.json', () => {
  it('is a valid Overtone document', () => {
    expect(validate(doc).errors).toEqual([]);
  });

  it('contains the sample script, spoken by Maya and Tom', () => {
    expect(doc.speakers.map((s) => s.label)).toEqual(['Maya', 'Tom']);
    const text = doc.turns.map((turn) => `${turn.speaker}: ${turn.words.map((w) => w.text).join(' ')}`);
    expect(text).toEqual([
      "S1: Every year, one in five drivers has some kind of car damage. With DriveCover from Lumora, you're insured from day one, for just $12 a month.",
      'S2: And the best part? You can claim directly in the app.',
      'S1: So remember: DriveCover. Drive worry-free.',
    ]);
  });

  it('uses every style class at least once', () => {
    const used = new Set(flattenWords(doc).flatMap((w) => w.classes ?? []));
    expect([...used].sort()).toEqual([...STYLE_CLASSES].sort());
  });

  it('has horizontal and vertical profiles whose lines respect their rules', () => {
    expect(doc.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
    for (const profile of doc.profiles) {
      for (const cue of profile.cues) {
        expect(cue.lines.length).toBeLessThanOrEqual(profile.rules!.maxLines);
        for (const line of cue.lines) expect(line.text.length).toBeLessThanOrEqual(profile.rules!.maxCharsPerLine);
      }
    }
  });

  it('never splits "one in five" or "$12 a month" across lines', () => {
    for (const profile of doc.profiles) {
      const lines = profile.cues.flatMap((cue) => cue.lines.map((line) => line.text));
      expect(lines.some((line) => line.includes('one in five'))).toBe(true);
      expect(lines.some((line) => line.includes('$12 a month.'))).toBe(true);
    }
  });
});
