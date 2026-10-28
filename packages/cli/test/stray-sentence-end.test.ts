// A sentence that ends in a single capital ("plan B.", "vitamin C.") is not a stray fragment (hearings.ts placeStrays).
import { describe, expect, it } from 'vitest';
import { hear, placeStrays, type EngineHearing } from '../src/hearings.js';
import type { AlignedWord, TimedWord } from '../src/types.js';

const said = (text: string, start: number, step = 0.3): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker: 'S1' }));
const engine = (id: string, words: TimedWord[]): EngineHearing => ({ id, label: id, words });
const timesOf = async (text: string, engines: EngineHearing[]) =>
  (await hear({ text: text.split(' '), engines, timeBy: 0, speakersBy: 0, language: 'en', duration: 120 })).words;

describe('a sentence ending in a single capital, then a long pause', () => {
  it('keeps its exact times ("Use plan B." at 1.0 s, the next sentence at 8.0 s)', async () => {
    const words = await timesOf('Use plan B. Then we go home.', [engine('azure', [...said('Use plan B.', 1.0), ...said('Then we go home.', 8.0)])]);
    expect(words.slice(0, 3).map((w) => [w.start, w.match])).toEqual([[1, 'exact'], [1.3, 'exact'], [1.6, 'exact']]);
    expect(words[3]!.start).toBe(8);
  });

  it('also for "vitamin C."', async () => {
    const words = await timesOf('Take vitamin C. It helps.', [engine('azure', [...said('Take vitamin C.', 1.0), ...said('It helps.', 9.0)])]);
    expect(words[0]!.start).toBe(1);
    expect(words[2]!.match).toBe('exact');
  });

  it('still moves a real stray fragment, as an unknown time', async () => {
    const words = await timesOf('Use plan B. You are a jerk.', [engine('azure', [...said('Use plan B.', 1.0), ...said('You are', 3.0), ...said('a jerk.', 20.0)])]);
    expect(words[0]!.start).toBe(1);
    expect(words[3]!.start).toBeGreaterThan(18);
    expect(words[3]!.match).toBe('interpolated');
    expect(words[4]!.end).toBeLessThanOrEqual(20);
  });
});

describe('placeStrays', () => {
  const aligned = (text: string, start: number, step = 0.3): AlignedWord[] =>
    said(text, start, step).map((w, i) => ({ ...w, speaker: 'S1', match: 'exact', confidence: 1, heard: { text: w.text, first: Math.round(start * 10) + i, last: Math.round(start * 10) + i } }));

  it('drops the witness of the words it moves: it was heard at the old time', () => {
    const { words, moves } = placeStrays([...aligned('You are', 3.0), ...aligned('a jerk.', 20.0)], [], 'en');
    expect(moves).toHaveLength(1);
    expect(words.slice(0, 2).every((w) => w.heard === undefined && w.match === 'interpolated')).toBe(true);
    expect(words.slice(2).map((w) => w.heard?.text)).toEqual(['a', 'jerk.']);
  });
});
