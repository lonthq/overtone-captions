import { describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { captionEvents } from '../src/burn/events.js';

const doc: OvertoneDocument = {
  format: 'overtone', version: 1, language: 'en', duration: 6,
  speakers: [{ id: 'S1' }],
  turns: [{ speaker: 'S1', start: 0.5, end: 2.0, words: [
    { text: 'Hello', start: 0.5, end: 0.9 },
    { text: 'big', start: 0.9, end: 1.3, classes: ['key'] },
    { text: 'world.', start: 1.35, end: 2.0 },
  ] }],
  profiles: [{
    id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 },
    window: { start: 0.25, end: 5 },
    cues: [
      { start: 0.5, end: 1.3, speaker: 'S1', lines: [{ words: [0, 1], text: 'Hello big' }] },
      { start: 1.35, end: 2.2, speaker: 'S1', lines: [{ words: [2, 2], text: 'world.' }] },
    ],
  }],
};

describe('captionEvents', () => {
  it('lists every time the state can change, sorted and unique', () => {
    expect(captionEvents(doc, doc.profiles[0], 6)).toEqual([0, 0.25, 0.5, 0.9, 1.3, 1.35, 2, 2.2, 5]);
  });

  it('drops times at or after the video end', () => {
    expect(captionEvents(doc, doc.profiles[0], 1.35)).toEqual([0, 0.25, 0.5, 0.9, 1.3]);
  });

  it('rounds before it drops, so a time that rounds up to the end is gone', () => {
    expect(captionEvents(doc, doc.profiles[0], 1.3 - 0.0004)).toEqual([0, 0.25, 0.5, 0.9]);
    expect(captionEvents(doc, doc.profiles[0], 1.3 + 0.0004)).toEqual([0, 0.25, 0.5, 0.9, 1.3]);
  });

  it('is empty for a zero duration', () => {
    expect(captionEvents(doc, doc.profiles[0], 0)).toEqual([]);
  });
});
