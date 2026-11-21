import { describe, expect, it } from 'vitest';
import { decideLanguage, pickSamples, type SampleHeard } from '../src/pipeline/audio-language.js';

describe('pickSamples', () => {
  it('takes the whole file up to 45 s', () => {
    expect(pickSamples(20, [])).toEqual([{ start: 0, end: 20 }]);
    expect(pickSamples(45, [])).toEqual([{ start: 0, end: 45 }]);
  });

  it('takes the start and the end up to 90 s', () => {
    expect(pickSamples(80, [])).toEqual([{ start: 0, end: 30 }, { start: 50, end: 80 }]);
  });

  it('takes three 30 s samples at 15, 50 and 85 % of a longer file', () => {
    expect(pickSamples(600, [])).toEqual([{ start: 75, end: 105 }, { start: 285, end: 315 }, { start: 495, end: 525 }]);
  });

  it('moves a sample centered in a silence to the nearest speech', () => {
    // 600 s with silence from 250 to 340: the middle center (300) moves to 340 (40 s away; 250 is 50 s away)
    expect(pickSamples(600, [{ start: 250, end: 340 }])[1]).toEqual({ start: 325, end: 355 });
  });

  it('keeps samples inside the file and apart', () => {
    // a music intro of 0-100 s on a 120 s file: the first sample moves to 100 and is cut at 115 by the file end,
    // the second follows it, and the third has no speech left
    expect(pickSamples(120, [{ start: 0, end: 100 }])).toEqual([{ start: 85, end: 115 }, { start: 115, end: 120 }]);
  });

  it('never pushes a sample into a silence when it moves apart from the previous one', () => {
    // 600 s, silence 100-500: sample 1 is 75-105; the middle center (300) snaps to 500 -> 485-515;
    // the last center (510) snaps to 515 (after the previous end) -> 515-545
    expect(pickSamples(600, [{ start: 100, end: 500 }])).toEqual([
      { start: 75, end: 105 }, { start: 485, end: 515 }, { start: 515, end: 545 },
    ]);
  });
});

const sample = (start: number, words: Record<string, number>): SampleHeard => ({ start, end: start + 30, words });

describe('decideLanguage', () => {
  it('is sure when every sample with speech agrees', () => {
    const d = decideLanguage([sample(0, { nl: 70 }), sample(100, { nl: 60, en: 2 }), sample(200, { nl: 80 })], 'google-chirp:chirp_3');
    expect(d).toEqual({
      verdict: 'sure', language: 'nl', provider: 'google-chirp:chirp_3',
      samples: [{ start: 0, end: 30, language: 'nl', words: 70 }, { start: 100, end: 130, language: 'nl', words: 62 }, { start: 200, end: 230, language: 'nl', words: 80 }],
    });
  });

  it('is unsure when samples disagree, and picks the most words', () => {
    const d = decideLanguage([sample(0, { en: 40 }), sample(100, { nl: 70 }), sample(200, { nl: 60 })], 'p');
    expect(d).toMatchObject({ verdict: 'unsure', language: 'nl' });
  });

  it('breaks a tie by the earliest sample', () => {
    expect(decideLanguage([sample(0, { en: 50 }), sample(100, { nl: 50 })], 'p')).toMatchObject({ verdict: 'unsure', language: 'en' });
  });

  it('is unsure when only one of several samples has speech', () => {
    expect(decideLanguage([sample(0, { nl: 40 }), sample(100, {}), sample(200, { nl: 3 })], 'p')).toMatchObject({ verdict: 'unsure', language: 'nl' });
  });

  it('is sure for a short file with one sample', () => {
    expect(decideLanguage([sample(0, { de: 12 })], 'p')).toMatchObject({ verdict: 'sure', language: 'de' });
  });

  it('is none below 5 words in every sample, and leaves the language out', () => {
    const d = decideLanguage([sample(0, { en: 4 }), sample(100, {})], 'p');
    expect(d.verdict).toBe('none');
    expect(d).not.toHaveProperty('language');
    expect(d.samples).toEqual([{ start: 0, end: 30, words: 4 }, { start: 100, end: 130, words: 0 }]);
  });
});
