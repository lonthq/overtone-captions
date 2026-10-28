import { describe, expect, it } from 'vitest';
import { toSRT } from 'overtone-format';
import { makeDoc } from './helpers';

describe('toSRT', () => {
  it('writes numbered plain cues with comma milliseconds', () => {
    expect(toSRT(makeDoc(), 'horizontal')).toBe(
      [
        '1',
        '00:00:00,500 --> 00:00:02,200',
        'Hello everyone,',
        'welcome back.',
        '',
        '2',
        '00:00:02,500 --> 00:00:03,500',
        'Thanks!',
        '',
      ].join('\n'),
    );
  });

  it('numbers cues after applying the window', () => {
    const doc = makeDoc();
    doc.profiles[1].window = { start: 1.45, end: 5 };
    const srt = toSRT(doc, 'vertical');
    expect(srt.startsWith('1\n00:00:01,450 --> 00:00:02,200\nwelcome back.\n\n2\n')).toBe(true);
  });

  it('returns an empty string for a profile without cues', () => {
    const doc = makeDoc();
    doc.profiles[1].cues = [];
    expect(toSRT(doc, 'vertical')).toBe('');
  });

  it('throws for an unknown profile', () => {
    expect(() => toSRT(makeDoc(), 'square')).toThrow('Unknown profile "square"');
  });

  it('throws a RangeError for an out-of-range line word range', () => {
    const doc = makeDoc();
    doc.profiles[0].cues[1].lines[0].words = [4, 9];
    expect(() => toSRT(doc, 'horizontal')).toThrow(RangeError);
  });

  it('collapses whitespace inside word text so a cue stays one block', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].text = 'a\n\nb';
    const srt = toSRT(doc, 'vertical');
    expect(srt).toContain('3\n00:00:02,500 --> 00:00:03,500\na b\n');
    expect(srt.trimEnd().split('\n\n')).toHaveLength(3);
  });

  it('keeps text that looks like a timing line, a tag or an override from being read as one', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].text = 'a --> b <i>x</i> </font> {\\an8}';
    const srt = toSRT(doc, 'vertical');
    expect(srt).toContain('3\n00:00:02,500 --> 00:00:03,500\na → b ‹i>x‹/i> ‹/font> ｛\\an8}\n');
    expect(srt.match(/-->/g)).toHaveLength(3); // only the three timing lines
    expect(srt).not.toMatch(/<\/?[A-Za-z]|\{\\/);
  });

  it('leaves ordinary text with arrows, comparisons and braces unchanged', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].text = '-> 3 < 5, a<3 {x} 1 > 0 and --';
    expect(toSRT(doc, 'vertical')).toContain('\n-> 3 < 5, a<3 {x} 1 > 0 and --\n');
  });

  it('cannot form a new timing arrow from a longer run of dashes', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].text = '----> --->>';
    const cue = toSRT(doc, 'vertical').split('\n\n')[2];
    expect(cue.split('\n').slice(2)).toEqual(['--→ -→>', '']);
  });
});
