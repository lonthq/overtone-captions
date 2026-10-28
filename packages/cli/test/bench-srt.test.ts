// SRT files for the benchmark's SubER scores (bench/lib/srt.mjs).
import { describe, expect, it } from 'vitest';
import { captionCues, refCues, textCue, toSrt, wordCues } from '../../../bench/lib/srt.mjs';

describe('SubER SRT files', () => {
  it('writes normalized tokens, numbered cues and SRT times, and skips empty cues', () => {
    expect(toSrt([{ start: 0, end: 1.5, text: 'hello there' }, { start: 2, end: 2, text: '' }, { start: 3661.25, end: 3661.25, text: 'bye' }])).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nhello there\n\n2\n01:01:01,250 --> 01:01:01,260\nbye\n',
    );
  });

  it('makes one reference cue per segment, keeps untimed segments and merges overlapping ones', () => {
    const ref = {
      segments: [{ id: 0, start: 0, end: 2 }, { id: 1 }, { id: 2, start: 5, end: 8 }, { id: 3, start: 7, end: 9 }],
      words: [{ text: 'Um, Hello', seg: 0 }, { text: 'there.', seg: 1 }, { text: 'Yes!', seg: 2 }, { text: "We're", seg: 3 }].flatMap((w) =>
        w.text.split(' ').map((t) => ({ text: t, seg: w.seg }))),
    };
    expect(refCues(ref, 'en')).toEqual([
      { start: 0, end: 2, text: 'hello there' },
      { start: 5, end: 9, text: 'yes we are' },
    ]);
    expect(refCues({ segments: [{ id: 0 }], words: [{ text: 'x', seg: 0 }] }, 'en')).toBeUndefined();
  });

  it('times system words, Overtone cues and an untimed text', () => {
    expect(wordCues([{ text: "Don't", start: 1, end: 1.4 }, { text: 'no', start: undefined }], 'en')).toEqual([{ start: 1, end: 1.4, text: 'do not' }]);
    // normalized together, as for WER: a number over two words is one token, in the first word's cue
    expect(wordCues([{ text: 'twenty', start: 1, end: 1.3 }, { text: 'five', start: 1.3, end: 1.6 }, { text: 'cats.', start: 1.6, end: 2 }], 'en')).toEqual([
      { start: 1, end: 1.3, text: '25' }, { start: 1.3, end: 1.6, text: '' }, { start: 1.6, end: 2, text: 'cats' },
    ]);
    const doc = { profiles: [{ cues: [{ start: 0.5, end: 2, lines: [{ text: 'In our first year.' }, { text: 'Yes,' }] }] }] };
    expect(captionCues(doc, 'en')).toEqual([{ start: 0.5, end: 2, text: 'in our first year yes' }]);
    expect(textCue('Uh, thank you.', 10, 'en')).toEqual([{ start: 0, end: 10, text: 'thank you' }]);
  });
});
