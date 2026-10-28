import { DEFAULT_PROFILES } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { isUntimed } from '../src/align/align.js';
import { applyEdits, type EditGuards } from '../src/refine/edits.js';
import { buildProfile } from '../src/segment/profile.js';
import { groupTurns, type SpeakerWord } from '../src/turns.js';

const GUARDS: EditGuards = { maxSpan: 6, language: 'en' };
const H = { id: 'horizontal', ...DEFAULT_PROFILES.horizontal };

// "Hello there." and "See you." heard; "Go now" no engine heard, placed in the middle of a 4 s gap
const WORDS: SpeakerWord[] = [
  { text: 'Hello', start: 1, end: 1.3, speaker: 'S1', match: 'exact' }, { text: 'there.', start: 1.3, end: 1.7, speaker: 'S1', match: 'exact' },
  { text: 'Go', start: 3.3, end: 3.5, speaker: 'S1', match: 'interpolated', confidence: 0 }, { text: 'now', start: 3.5, end: 3.8, speaker: 'S1', match: 'interpolated', confidence: 0 },
  { text: 'See', start: 5.6, end: 5.8, speaker: 'S1', match: 'exact' }, { text: 'you.', start: 5.8, end: 6.1, speaker: 'S1', match: 'exact' },
];
const cuesOf = (words: readonly SpeakerWord[]) =>
  buildProfile(words, H, { language: 'en', glossary: [], duration: 10, untimed: words.map(isUntimed) }).profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));

describe('edited words keep their unknown time', () => {
  it('marks a word that replaces an untimed word as untimed, and leaves the timed ones alone', () => {
    const res = applyEdits(WORDS, [{ first: 3, last: 3, to: 'now,', reason: 'punctuation' }, { first: 5, last: 5, to: 'you!', reason: 'punctuation' }], GUARDS);
    expect(res.words[3]).toMatchObject({ text: 'now,', match: 'edited', untimed: true });
    expect(isUntimed(res.words[3]!)).toBe(true);
    expect(isUntimed(res.words[5]!)).toBe(false);
    // with the same word count each new word keeps its own word's fact; with another count any untimed word counts
    const split = applyEdits(WORDS, [{ first: 1, last: 2, to: 'there. Go', reason: 'punctuation' }], GUARDS);
    expect(split.words.slice(1, 3).map(isUntimed)).toEqual([false, true]);
    const merged = applyEdits(WORDS, [{ first: 2, last: 3, to: 'Gonow', reason: 'correction' }], { ...GUARDS });
    expect(merged.words[2]).toMatchObject({ text: 'Gonow', untimed: true });
  });

  it('reads no pause next to an edited untimed word when cutting cues', () => {
    const res = applyEdits(WORDS, [{ first: 2, last: 3, to: 'Go now,', reason: 'punctuation' }], GUARDS);
    expect(res.words.slice(2, 4).every(isUntimed)).toBe(true);
    // the gaps around "Go now," (1.6 s and 1.8 s) are where it was placed, not pauses: no new cue
    expect(cuesOf(res.words)).toEqual(['Hello there. Go now, See you.']);
  });

  it('never writes the internal flag into the document', () => {
    const res = applyEdits(WORDS, [{ first: 3, last: 3, to: 'now,', reason: 'punctuation' }], GUARDS);
    expect(groupTurns(res.words)[0]!.words.some((w) => 'untimed' in w)).toBe(false);
  });
});
