// The Earnings-22 reference parser and window rule of the benchmark (bench/lib/earnings22.mjs).
import { describe, expect, it } from 'vitest';
import { parseNlp, pickWindow, windowRef } from '../../../bench/lib/earnings22.mjs';

const HEADER = 'token|speaker|ts|endTs|punctuation|prepunctuation|case|tags|oldTs|oldEndTs|ali_comment';
const nlp = (rows: string[]): string => [HEADER, ...rows].join('\n') + '\n';

describe('parseNlp', () => {
  it('keeps casing and punctuation, drops tags and the "inaudible" placeholder, keeps words without times', () => {
    const words = parseNlp(nlp([
      'Good|0|1.0|1.2|||UC|[]|||',
      'morning|0|1.2|1.5|,||LC|[]|||',
      '<inaudible>|0|1.6|1.8|||N/A|[]|||',
      'inaudible|0|1.9|2.0|.||LC|[]|||',
      'quote|1|||"|"|LC|[]|||',
      'Rev|1|2.5|2.8|.||UC|[]|||',
    ]));
    expect(words).toEqual([
      { text: 'Good', speaker: 'S0', start: 1.0, end: 1.2 },
      { text: 'morning,', speaker: 'S0', start: 1.2, end: 1.5 },
      { text: '"quote"', speaker: 'S1' },
      { text: 'Rev.', speaker: 'S1', start: 2.5, end: 2.8 },
    ]);
  });
});

// A 0.1 s word at every whole second for 100 s, speaker A until 50 s, then B; word 5 is long (5.0–5.9 s).
const words = Array.from({ length: 100 }, (_, i) => ({ text: `w${i}`, speaker: i < 50 ? 'A' : 'B', start: i, end: i === 5 ? 5.9 : i + 0.1 }));

describe('pickWindow', () => {
  it('takes the first window whose edges are 0.3 s away from every word', () => {
    expect(pickWindow(words, { from: 0.5, length: 30, step: 1, minSpeakers: 1 })).toEqual({ start: 0.5, end: 30.5 });
    expect(pickWindow(words, { from: 5.5, length: 30, step: 1, minSpeakers: 1 })).toEqual({ start: 6.5, end: 36.5 });
  });

  it('needs enough speakers and few words without times', () => {
    expect(pickWindow(words, { from: 0.5, length: 30, step: 1, minSpeakers: 2 })).toEqual({ start: 20.5, end: 50.5 });
    const untimed = words.map((w, i) => (i % 10 === 3 ? { text: w.text, speaker: w.speaker } : w));
    expect(pickWindow(untimed, { from: 0.5, length: 30, step: 1, minSpeakers: 2, maxUntimed: 0.05 })).toBeUndefined();
    expect(pickWindow(untimed, { from: 0.5, length: 30, step: 1, minSpeakers: 2, maxUntimed: 0.2 })).toEqual({ start: 20.5, end: 50.5 });
  });
});

describe('windowRef', () => {
  it('shifts times to the window and starts a segment at a speaker change or a sentence end', () => {
    const w = [
      { text: 'Hello', speaker: 'S0', start: 10.1, end: 10.4 },
      { text: 'there.', speaker: 'S0', start: 10.4, end: 10.8 },
      { text: 'Next', speaker: 'S0' },
      { text: 'one', speaker: 'S0', start: 11.2, end: 11.5 },
      { text: 'Yes', speaker: 'S1', start: 12.0, end: 12.3 },
    ];
    expect(windowRef(w, 10, 13)).toEqual({
      words: [
        { text: 'Hello', speaker: 'S0', seg: 0, start: 0.1, end: 0.4 },
        { text: 'there.', speaker: 'S0', seg: 0, start: 0.4, end: 0.8 },
        { text: 'Next', speaker: 'S0', seg: 1 },
        { text: 'one', speaker: 'S0', seg: 1, start: 1.2, end: 1.5 },
        { text: 'Yes', speaker: 'S1', seg: 2, start: 2.0, end: 2.3 },
      ],
      segments: [
        { id: 0, speaker: 'S0', start: 0.1, end: 0.8 },
        { id: 1, speaker: 'S0', start: 1.2, end: 1.5 },
        { id: 2, speaker: 'S1', start: 2.0, end: 2.3 },
      ],
    });
  });

  it('fails when a word runs past the window end', () => {
    expect(() => windowRef([{ text: 'long', speaker: 'S0', start: 9.5, end: 10.5 }], 0, 10)).toThrow(/past the window end/);
  });
});
