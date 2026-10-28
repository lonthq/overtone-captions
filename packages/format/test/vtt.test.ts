// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import vttjs from 'videojs-vtt.js';
import { speakerLabel, toWebVTT } from 'overtone-format';
import { makeDoc } from './helpers';

/** Parses WebVTT with vtt.js, the parser video.js uses, and returns the cues and any parsing errors. */
function parseVtt(text: string) {
  const cues: Array<{ startTime: number; endTime: number; text: string }> = [];
  const errors: unknown[] = [];
  const parser = new vttjs.WebVTT.Parser(window, vttjs.WebVTT.StringDecoder());
  parser.oncue = (cue) => cues.push(cue);
  parser.onparsingerror = (error) => errors.push(error);
  parser.parse(text);
  parser.flush();
  return { cues, errors };
}

describe('speakerLabel', () => {
  it('uses the label, then the id', () => {
    const doc = makeDoc();
    expect(speakerLabel(doc, 'S1')).toBe('Sarah');
    expect(speakerLabel(doc, 'S2')).toBe('S2');
    expect(speakerLabel(doc, 'S9')).toBe('S9');
  });

  it('collapses whitespace, trims, and falls back to the id when the label is blank', () => {
    const doc = makeDoc();
    doc.speakers[0].label = '  Sarah \n  Jones ';
    expect(speakerLabel(doc, 'S1')).toBe('Sarah Jones');
    doc.speakers[0].label = '   ';
    expect(speakerLabel(doc, 'S1')).toBe('S1');
  });

  it('collapses whitespace in the id fallback too', () => {
    const doc = makeDoc();
    doc.speakers.push({ id: ' S\n\n2 ' });
    expect(speakerLabel(doc, ' S\n\n2 ')).toBe('S 2');
    expect(speakerLabel(doc, 'X\t\tY')).toBe('X Y');
  });
});

describe('toWebVTT', () => {
  it('writes styled cues with voice tags and class spans by default', () => {
    expect(toWebVTT(makeDoc(), 'horizontal')).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.500 --> 00:00:02.200',
        '<v Sarah>Hello <c.soft>everyone,</c>',
        '<c.emphasis>welcome</c> back.',
        '',
        '00:00:02.500 --> 00:00:03.500',
        '<v S2><c.key>Thanks!</c>',
        '',
      ].join('\n'),
    );
  });

  it('with wordTimings, puts a timestamp tag before each word that starts inside the cue, after the one before', () => {
    const doc = makeDoc();
    doc.turns[0]!.words[3]!.start = 1.45; // same start as the word before: no second tag at that time
    const vtt = toWebVTT(doc, 'horizontal', { wordTimings: true });
    expect(vtt).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.500 --> 00:00:02.200',
        '<v Sarah>Hello <00:00:00.950><c.soft>everyone,</c>',
        '<00:00:01.450><c.emphasis>welcome</c> back.',
        '',
        '00:00:02.500 --> 00:00:03.500',
        '<v S2><c.key>Thanks!</c>',
        '',
      ].join('\n'),
    );
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toEqual([]);
    expect(cues).toHaveLength(2);
  });

  it('writes plain text (still with voice tags) when styled is false', () => {
    expect(toWebVTT(makeDoc(), 'vertical', { styled: false })).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.500 --> 00:00:01.400',
        '<v Sarah>Hello everyone,',
        '',
        '00:00:01.450 --> 00:00:02.200',
        '<v Sarah>welcome back.',
        '',
        '00:00:02.500 --> 00:00:03.500',
        '<v S2>Thanks!',
        '',
      ].join('\n'),
    );
  });

  it('joins several classes into one span', () => {
    const doc = makeDoc();
    doc.turns[1].words[0].classes = ['brand', 'key'];
    expect(toWebVTT(doc, 'horizontal')).toContain('<v S2><c.brand.key>Thanks!</c>');
  });

  it('escapes &, < and > in text and speaker labels', () => {
    const doc = makeDoc();
    doc.speakers[0].label = 'R&D <team>';
    doc.turns[0].words[0].text = 'A&B<>';
    doc.profiles[0].cues[0].lines[0].text = 'A&B<> everyone,';
    const vtt = toWebVTT(doc, 'horizontal');
    expect(vtt).toContain('<v R&amp;D &lt;team&gt;>A&amp;B&lt;&gt; <c.soft>everyone,</c>');
  });

  it('only writes cues inside the profile window, clamped to it', () => {
    const doc = makeDoc();
    doc.profiles[0].window = { start: 1, end: 3 };
    const vtt = toWebVTT(doc, 'horizontal');
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.200');
    expect(vtt).toContain('00:00:02.500 --> 00:00:03.000');
  });

  it('writes only the header for a profile without cues', () => {
    const doc = makeDoc();
    doc.profiles[1].cues = [];
    expect(toWebVTT(doc, 'vertical')).toBe('WEBVTT\n');
  });

  it('throws for an unknown profile', () => {
    expect(() => toWebVTT(makeDoc(), 'square')).toThrow('Unknown profile "square"');
  });

  it('throws a RangeError for an out-of-range line word range (like toSRT)', () => {
    const doc = makeDoc();
    doc.profiles[0].cues[1].lines[0].words = [4, 9];
    expect(() => toWebVTT(doc, 'horizontal')).toThrow(RangeError);
    doc.profiles[0].cues[1].lines[0].words = [3, 2];
    expect(() => toWebVTT(doc, 'horizontal')).toThrow(RangeError);
  });

  it('produces a file that vtt.js parses without errors', () => {
    const { cues, errors } = parseVtt(toWebVTT(makeDoc(), 'horizontal'));
    expect(errors).toEqual([]);
    expect(cues.map((cue) => [cue.startTime, cue.endTime])).toEqual([
      [0.5, 2.2],
      [2.5, 3.5],
    ]);
    expect(cues[0].text).toBe('<v Sarah>Hello <c.soft>everyone,</c>\n<c.emphasis>welcome</c> back.');
  });

  it('keeps a label ending in "-" from forming a "-->" sequence', () => {
    const doc = makeDoc();
    doc.speakers[0].label = 'Team --';
    const vtt = toWebVTT(doc, 'horizontal');
    expect(vtt).toContain('<v Team -- >Hello');
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toEqual([]);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toContain('Hello');
    expect(cues[0].text).toContain('welcome');
  });

  it('falls back to the speaker id for a blank label', () => {
    const doc = makeDoc();
    doc.speakers[0].label = '   ';
    expect(toWebVTT(doc, 'horizontal')).toContain('<v S1>Hello');
  });

  it('collapses whitespace and newlines inside word text', () => {
    const doc = makeDoc();
    doc.turns[0].words[0].text = 'a\n\nb';
    const vtt = toWebVTT(doc, 'horizontal');
    expect(vtt).toContain('<v Sarah>a b <c.soft>everyone,</c>');
    const { cues, errors } = parseVtt(vtt);
    expect(errors).toEqual([]);
    expect(cues).toHaveLength(2);
    expect(cues[0].text.split('\n')[0]).toBe('<v Sarah>a b <c.soft>everyone,</c>');
  });
});
