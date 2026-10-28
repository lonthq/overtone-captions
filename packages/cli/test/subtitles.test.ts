import { describe, expect, it } from 'vitest';
import { decodeEntities, detectSubtitleFormat, parseSubtitles, parseTimestamp, subtitleText } from '../src/text/subtitles.js';

const texts = (content: string, format: 'srt' | 'vtt' = 'srt') => parseSubtitles(content, format).cues.map((c) => c.segments.map((s) => `${s.speaker}: ${s.text}`).join(' | '));

describe('parseTimestamp', () => {
  it.each([
    ['00:00:01,500', 1.5], ['01:02:03.250', 3723.25], ['02:03.5', 123.5], ['1:00:00.000', 3600], ['00:00:07', 7], ['100:00:00,000', 360000],
  ])('%s → %d', (value, seconds) => expect(parseTimestamp(value)).toBeCloseTo(seconds, 6));
  it.each(['', 'abc', '00:61.000', '00:00:61,000', '00:60:00,000', '1.5'])('rejects %j', (value) => expect(parseTimestamp(value)).toBeUndefined());
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones', () => {
    expect(decodeEntities('Tom &amp; Sarah &lt;3 &quot;hi&quot; &apos;x&#39; &#x2014; caf&#233; &bogus; a&nbsp;b')).toBe('Tom & Sarah <3 "hi" \'x\' — café &bogus; a b');
  });

  it('leaves names of object properties as written', () => {
    expect(decodeEntities('Use &constructor; and &toString; literally')).toBe('Use &constructor; and &toString; literally');
  });
});

describe('detectSubtitleFormat', () => {
  it('uses the extension first', () => {
    expect(detectSubtitleFormat('whatever', 'talk.SRT')).toBe('srt');
    expect(detectSubtitleFormat('whatever', 'talk.vtt')).toBe('vtt');
  });
  it('recognizes the content otherwise', () => {
    expect(detectSubtitleFormat('﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi', 'x.txt')).toBe('vtt');
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nHi', 'x.txt')).toBe('srt');
    expect(detectSubtitleFormat('00:00:01.000 --> 00:00:02.000\nHi', 'x')).toBe('vtt');
    expect(detectSubtitleFormat('Just a transcript --> with an arrow.', 'notes.txt')).toBeUndefined();
    expect(detectSubtitleFormat('Plain text.', 'notes.txt')).toBeUndefined();
  });
});

describe('parseSubtitles: SubRip', () => {
  it('reads BOM, CRLF, multi-line cues, markup and entities', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> <font color="#fff">there,</font>\r\n{\\an8}Tom &amp; Sarah.\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000 X1:10 X2:20 Y1:5 Y2:9\r\n<b>Bye</b>  now.\r\n';
    const parsed = parseSubtitles(srt, 'srt');
    expect(parsed.cues).toEqual([
      { start: 1, end: 3.5, segments: [{ speaker: 'S1', text: 'Hello there, Tom & Sarah.' }] },
      { start: 4, end: 5, segments: [{ speaker: 'S1', text: 'Bye now.' }] },
    ]);
    expect(parsed).toMatchObject({ format: 'srt', speakers: [{ id: 'S1' }], speakerSource: 'none', skipped: 0 });
  });

  it('keeps "a < b" that is not a tag, and skips blocks without timing or text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nIf a < b and b > c\n\n2\nno timing here\n\n3\n00:00:03,000 --> nonsense\nText\n\n4\n00:00:04,000 --> 00:00:05,000\n<i></i>\n\n5\n\n00:00:06,000 --> 00:00:07,000\nLast.';
    const parsed = parseSubtitles(srt, 'srt');
    expect(parsed.cues.map((c) => c.segments[0].text)).toEqual(['If a < b and b > c', 'Last.']);
    expect(parsed.skipped).toBe(3);
  });

  it('starts a new cue at a timing line without a blank line before it, dropping its number', () => {
    const parsed = parseSubtitles('1\n00:00:01,000 --> 00:00:03,000\nHello there.\n2\n00:00:04,000 --> 00:00:06,000\nGeneral Kenobi.\n00:00:07,000 --> 00:00:08,000\nYou are a bold one.\n', 'srt');
    expect(parsed.cues.map((c) => [c.start, c.end, c.segments.map((x) => x.text).join(' ')])).toEqual([
      [1, 3, 'Hello there.'], [4, 6, 'General Kenobi.'], [7, 8, 'You are a bold one.'],
    ]);
    expect(parsed.skipped).toBe(0);
    // a number line that is cue text stays text; "a --> b" is no timing line
    expect(texts('1\n00:00:01,000 --> 00:00:03,000\nThe answer is\n42\nand a --> b\n')).toEqual(['S1: The answer is 42 and a --> b']);
    expect(texts('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne.\n00:00:02.000 --> 00:00:03.000\nTwo.\n', 'vtt')).toEqual(['S1: One.', 'S1: Two.']);
  });

  it('takes speakers from all-caps NAME: prefixes and removes them from the text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nSARAH: Hi Tom.\nTOM: Hi.\n\n2\n00:00:02,000 --> 00:00:03,000\nHow are you?\n\n3\n00:00:03,000 --> 00:00:04,000\n- DR. LEE: Fine, thanks.';
    const parsed = parseSubtitles(srt, 'srt');
    expect(parsed.speakerSource).toBe('name prefixes');
    expect(parsed.speakers).toEqual([{ id: 'S1', label: 'SARAH' }, { id: 'S2', label: 'TOM' }, { id: 'S3', label: 'DR. LEE' }]);
    expect(texts(srt)).toEqual(['S1: Hi Tom. | S2: Hi.', 'S2: How are you?', 'S3: Fine, thanks.']);
  });

  it('takes capitalized "Name:" prefixes only when two names each start two lines', () => {
    const one = '1\n00:00:01,000 --> 00:00:02,000\nNote: this is said.\n\n2\n00:00:02,000 --> 00:00:03,000\nNote: twice.';
    expect(parseSubtitles(one, 'srt').speakerSource).toBe('none');
    expect(texts(one)).toEqual(['S1: Note: this is said.', 'S1: Note: twice.']);
    const two = '1\n00:00:01,000 --> 00:00:02,000\nSarah: Hello.\nMark Jones: Hi.\n\n2\n00:00:02,000 --> 00:00:03,000\nSarah: Ready?\nMark Jones: Yes.\nRemember: the light.';
    expect(parseSubtitles(two, 'srt').speakers).toEqual([{ id: 'S1', label: 'Sarah' }, { id: 'S2', label: 'Mark Jones' }]);
    // "Remember" starts one line only: it stays text of the current speaker
    expect(texts(two)).toEqual(['S1: Hello. | S2: Hi.', 'S1: Ready? | S2: Yes. Remember: the light.']);
  });

  it('dialogue dashes: each dashed line starts a turn, two unnamed speakers alternate', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nSo here we are.\n\n2\n00:00:02,000 --> 00:00:04,000\n- Where were you?\n- Out.\n\n3\n00:00:04,000 --> 00:00:06,000\n-Why?\n-It was\nsunny.\n\n4\n00:00:06,000 --> 00:00:07,000\n- A single dashed line stays.';
    const parsed = parseSubtitles(srt, 'srt');
    expect(parsed.speakerSource).toBe('dialogue dashes');
    expect(parsed.speakers).toEqual([{ id: 'S1' }, { id: 'S2' }]);
    expect(texts(srt)).toEqual(['S1: So here we are.', 'S1: Where were you? | S2: Out.', 'S1: Why? | S2: It was sunny.', 'S2: - A single dashed line stays.']);
  });
});

describe('parseSubtitles: WebVTT', () => {
  const vtt = [
    'WEBVTT - a title',
    'Kind: captions',
    '',
    'NOTE a comment',
    'over two lines --> with an arrow',
    '',
    'STYLE',
    '::cue { color: white }',
    '',
    'REGION',
    'id:fred width:40%',
    '',
    'cue-1',
    '00:01.000 --> 00:03.000 align:start position:10% line:85%',
    '<v Sarah>Hello <c.loud>there</c>, <00:02.000>Tom.</v>',
    '',
    '00:00:03.500 --> 00:00:05.000',
    '<v.excited Tom>Hi!</v> <v Sarah>Ready?',
    '',
    '00:05.000 --> 00:06.000',
    'Yes &amp; no; <ruby>漢<rt>kan</rt></ruby>字.',
  ].join('\n');

  it('skips header, NOTE, STYLE and REGION blocks; reads identifiers and cue settings', () => {
    const parsed = parseSubtitles(vtt, 'vtt');
    expect(parsed.cues.map((c) => [c.start, c.end])).toEqual([[1, 3], [3.5, 5], [5, 6]]);
    expect(parsed.skipped).toBe(0);
  });

  it('takes speakers from voice tags (also with classes and several voices in one cue)', () => {
    const parsed = parseSubtitles(vtt, 'vtt');
    expect(parsed.speakerSource).toBe('voice tags');
    expect(parsed.speakers).toEqual([{ id: 'S1', label: 'Sarah' }, { id: 'S2', label: 'Tom' }]);
    expect(texts(vtt, 'vtt')).toEqual(['S1: Hello there, Tom.', 'S2: Hi! | S1: Ready?', 'S1: Yes & no; 漢字.']);
    expect(subtitleText(parsed)).toBe('Hello there, Tom. Hi! Ready? Yes & no; 漢字.');
  });
});
