// Word timing scores of the benchmark (bench/lib/timing.mjs) and the LibriSpeech word times (bench/lib/mfa.mjs).
import { describe, expect, it } from 'vitest';
import { attachTimes, textGridWords } from '../../../bench/lib/mfa.mjs';
import { startF1 } from '../../../bench/lib/timing.mjs';

describe('startF1', () => {
  it('counts missed and inserted words against the score', () => {
    const rows = [{ ds: 0.02 }, { ds: -0.04 }, { ds: 0.08 }, { ds: 0.3 }]; // 4 correctly recognized words
    // 50 ms: 2 hits; 4 reference and 4 system words -> P = R = 0.5
    expect(startF1(rows, 4, 4, 0.05)).toBeCloseTo(0.5);
    // the same hits with 2 missed reference words and 1 inserted system word: P = 2/5, R = 2/6
    expect(startF1(rows, 6, 5, 0.05)).toBeCloseTo((2 * 0.4 * (1 / 3)) / (0.4 + 1 / 3));
    // a constant offset larger than the tolerance gives no hits
    expect(startF1(rows.map((r) => ({ ds: r.ds + 0.5 })), 4, 4, 0.1)).toBe(0);
  });
});

const TEXTGRID = `File type = "ooTextFile"
Object class = "TextGrid"
item []:
	item [1]:
		class = "IntervalTier"
		name = "words"
		intervals: size = 4
			intervals [1]:
				xmin = 0.0
				xmax = 0.39
				text = ""
			intervals [2]:
				xmin = 0.39
				xmax = 0.56
				text = "don't"
			intervals [3]:
				xmin = 0.56
				xmax = 0.9
				text = "cry"
			intervals [4]:
				xmin = 0.9
				xmax = 1.2
				text = "he"
	item [2]:
		class = "IntervalTier"
		name = "phones"
		intervals: size = 1
			intervals [1]:
				xmin = 0.39
				xmax = 0.45
				text = "D"
`;

describe('LibriSpeech word times', () => {
  it('reads the words tier of a TextGrid, without silences or other tiers', () => {
    expect(textGridWords(TEXTGRID)).toEqual([
      { text: "don't", start: 0.39, end: 0.56 },
      { text: 'cry', start: 0.56, end: 0.9 },
      { text: 'he', start: 0.9, end: 1.2 },
    ]);
  });

  it('puts the times on words with their own casing and punctuation, shifted, and skips unmatched words', () => {
    const words: Array<{ text: string; start?: number; end?: number }> = [{ text: '"Don\'t' }, { text: 'cry,"' }, { text: 'she' }];
    expect(attachTimes(words, textGridWords(TEXTGRID), 10)).toBe(2);
    expect(words).toEqual([
      { text: '"Don\'t', start: 10.39, end: 10.56 },
      { text: 'cry,"', start: 10.56, end: 10.9 },
      { text: 'she' },
    ]);
  });
});
