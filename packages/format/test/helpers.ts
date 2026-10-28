import type { OvertoneDocument } from 'overtone-format';

/**
 * A tiny valid document used by unit tests. Words (global index):
 * 0 Hello · 1 everyone, · 2 welcome · 3 back. (S1) · 4 Thanks! (S2)
 */
export function makeDoc(): OvertoneDocument {
  return {
    format: 'overtone',
    version: 1,
    language: 'en',
    duration: 5,
    speakers: [
      { id: 'S1', label: 'Sarah', role: 'host' },
      { id: 'S2' },
    ],
    turns: [
      {
        speaker: 'S1',
        start: 0.5,
        end: 2.2,
        words: [
          { text: 'Hello', start: 0.5, end: 0.9 },
          { text: 'everyone,', start: 0.95, end: 1.4, classes: ['soft'] },
          { text: 'welcome', start: 1.45, end: 1.8, classes: ['emphasis'], match: 'fuzzy', confidence: 0.82 },
          { text: 'back.', start: 1.85, end: 2.2 },
        ],
      },
      {
        speaker: 'S2',
        start: 2.5,
        end: 3.1,
        words: [{ text: 'Thanks!', start: 2.5, end: 3.1, classes: ['key'] }],
      },
    ],
    profiles: [
      {
        id: 'horizontal',
        description: 'TV/desktop',
        aspect: '16:9',
        window: { start: 0, end: 5 },
        rules: { maxCharsPerLine: 42, maxLines: 2 },
        cues: [
          {
            start: 0.5,
            end: 2.2,
            speaker: 'S1',
            lines: [
              { words: [0, 1], text: 'Hello everyone,' },
              { words: [2, 3], text: 'welcome back.' },
            ],
          },
          { start: 2.5, end: 3.5, speaker: 'S2', lines: [{ words: [4, 4], text: 'Thanks!' }] },
        ],
      },
      {
        id: 'vertical',
        aspect: '9:16',
        rules: { maxCharsPerLine: 22, maxLines: 2 },
        cues: [
          { start: 0.5, end: 1.4, speaker: 'S1', lines: [{ words: [0, 1], text: 'Hello everyone,' }] },
          { start: 1.45, end: 2.2, speaker: 'S1', lines: [{ words: [2, 3], text: 'welcome back.' }] },
          { start: 2.5, end: 3.5, speaker: 'S2', lines: [{ words: [4, 4], text: 'Thanks!' }] },
        ],
      },
    ],
    edits: [{ words: [2, 2], from: 'well come', to: 'welcome', reason: 'correction' }],
    meta: { title: 'Test', generator: 'test' },
  };
}
