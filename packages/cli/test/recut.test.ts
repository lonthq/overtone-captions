import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenWords, validate, type OvertoneDocument } from 'overtone-format';
import { runRecut, type RecutFlags } from '../src/commands/recut.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { buildProgram } from '../src/program.js';
import { languageDataHash } from '../src/lang/fingerprint.js';
import { ESTIMATED_TIMING, estimateWordTimes, possibleSpeakerChanges } from '../src/recut.js';
import { parseSubtitles } from '../src/text/subtitles.js';
import { tempDir } from './tmp.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/subtitles');
const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');
const NOW = () => new Date('2026-10-17T09:00:00Z');

afterEach(() => {
  process.exitCode = 0;
});

/** Copy a fixture into a fresh folder and recut it there; returns the folder, the log and the document. */
async function recut(fixture: string, flags: RecutFlags = {}, config?: unknown) {
  const dir = await tempDir('overtone-recut-');
  await copyFile(join(FIXTURES, fixture), join(dir, fixture));
  if (config !== undefined) await writeFile(join(dir, 'overtone.config.json'), JSON.stringify(config));
  const log = memoryLogger();
  expect(await runRecut(fixture, flags, log, dir, { now: NOW, generator: 'overtone-captions@test' })).toBe(0);
  const base = fixture.replace(/\.[^.]+$/, '');
  const doc = JSON.parse(await readFile(join(dir, `${base}.overtone.json`), 'utf8')) as OvertoneDocument;
  return { dir, log, doc, base };
}

const cueTexts = (doc: OvertoneDocument, id: string) => doc.profiles.find((p) => p.id === id)!.cues.map((c) => c.lines.map((l) => l.text));

/** SubRip text from [start, end, text] cues (seconds, under a minute). */
const srt = (cues: ReadonlyArray<[number, number, string]>) => {
  const time = (s: number) => `00:00:${String(Math.floor(s)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
  return cues.map(([start, end, text], i) => `${i + 1}\n${time(start)} --> ${time(end)}\n${text}\n`).join('\n');
};

/** Recut subtitles given as text, written to a fresh folder as `name`; returns the document. */
async function recutText(name: string, content: string, flags: RecutFlags = {}) {
  const dir = await tempDir('overtone-recut-');
  await writeFile(join(dir, name), content);
  expect(await runRecut(name, { language: 'en', export: 'json', ...flags }, memoryLogger(), dir, { now: NOW, generator: 'overtone-captions@test' })).toBe(0);
  return JSON.parse(await readFile(join(dir, name.replace(/\.[^.]+$/, '.overtone.json')), 'utf8')) as OvertoneDocument;
}

/** Two people, no speaker labels. */
const DOOR = srt([
  [1, 2.4, 'Did you lock the door?'],
  [2.4, 3.4, 'Yes. Twice.'],
  [3.4, 5, 'Then why is it open?'],
  [5, 6.4, 'I was going to tell you...'],
  [6.4, 7.4, '...but you would panic.'],
  [7.4, 8.6, 'I thought we could-'],
  [8.6, 9.4, 'No.'],
]);
/** Dialogue dashes mark the two speakers inside the first cue only. */
const DASHES = srt([[1, 2.5, '- Are you ready?\n- Of course.'], [2.6, 3.8, 'Then go.'], [3.8, 5, 'I am going.']]);
/** Voice tags name every speaker. */
const VOICES = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.400\n<v Sarah>Thanks for coming in.\n\n00:00:02.400 --> 00:00:03.600\n<v Sarah>It means a lot.\n\n00:00:03.800 --> 00:00:05.200\n<v Tom>Happy to be here.\n\n00:00:05.200 --> 00:00:06.000\n<v Tom>Really.\n';

/** Word indices where `marks` is true. */
const marked = (marks: readonly boolean[] | undefined) => marks?.flatMap((m, i) => (m ? [i] : []));

describe('estimateWordTimes', () => {
  const cue = (start: number, end: number, text: string, speaker = 'S1') => ({ start, end, segments: [{ speaker, text }] });

  it('spreads a cue over its words in proportion to their letters; a gap between cues stays a pause', () => {
    const words = estimateWordTimes([cue(1, 2, 'a bbb.'), cue(5, 6, 'cc dd')]);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([['a', 1, 1.25], ['bbb.', 1.25, 2], ['cc', 5, 5.5], ['dd', 5.5, 6]]);
    expect(words.every((w) => w.match === 'interpolated' && w.confidence === 0 && w.speaker === 'S1')).toBe(true);
  });

  it('keeps times ordered for overlapping, unsorted and zero-length cues', () => {
    const words = estimateWordTimes([cue(3, 3, 'x y'), cue(1, 4, 'one two', 'S2'), cue(3.5, 5, 'three')]);
    expect(words.map((w) => [w.text, w.start, w.end, w.speaker])).toEqual([
      ['one', 1, 2.5, 'S2'], ['two', 2.5, 4, 'S2'], ['x', 4, 4.001, 'S1'], ['y', 4.001, 4.002, 'S1'], ['three', 4.002, 5, 'S1'],
    ]);
  });

  it('times words of several speakers in one cue and glues punctuation-only tokens', () => {
    const words = estimateWordTimes([{ start: 0, end: 1, segments: [{ speaker: 'S1', text: 'Hi —' }, { speaker: 'S2', text: 'yo!' }] }]);
    expect(words.map((w) => [w.text, w.speaker])).toEqual([['Hi —', 'S1'], ['yo!', 'S2']]);
    expect(words[0].end).toBe(0.5);
  });
});

describe('possibleSpeakerChanges', () => {
  it('marks the end of a cue that ends a sentence or breaks off, unless the next cue opens with an ellipsis', () => {
    const parsed = parseSubtitles(DOOR, 'srt');
    expect(parsed.speakerSource).toBe('none');
    const words = estimateWordTimes(parsed.cues).map((w) => w.text);
    expect(marked(possibleSpeakerChanges(parsed))!.map((i) => words[i])).toEqual(['door?', 'Twice.', 'open?', 'panic.', 'could-']);
    expect(possibleSpeakerChanges(parsed)).toHaveLength(words.length);
  });

  it('does not mark a cue that ends on a comma or an abbreviation', () => {
    const parsed = parseSubtitles(srt([[1, 2, 'When it opened,'], [2, 3, 'I called Dr.'], [3, 4, 'Lee right away.'], [4, 5, 'She came.']]), 'srt');
    const words = estimateWordTimes(parsed.cues).map((w) => w.text);
    expect(marked(possibleSpeakerChanges(parsed))!.map((i) => words[i])).toEqual(['away.']);
  });

  it('marks cue ends in a file with dialogue dashes, whose speaker changes between cues have no mark', () => {
    const parsed = parseSubtitles(DASHES, 'srt');
    expect(parsed.speakerSource).toBe('dialogue dashes');
    const words = estimateWordTimes(parsed.cues).map((w) => w.text);
    expect(marked(possibleSpeakerChanges(parsed))!.map((i) => words[i])).toEqual(['course.', 'go.']);
  });

  it('marks nothing in a file that names its speakers', () => {
    expect(possibleSpeakerChanges(parseSubtitles(VOICES, 'vtt'))).toBeUndefined();
    expect(possibleSpeakerChanges(parseSubtitles(srt([[1, 2, 'NURSE: Take a seat.'], [2, 3, 'The doctor is late.'], [3, 4, 'PATIENT: How late?']]), 'srt'))).toBeUndefined();
  });
});

describe('overtone recut', () => {
  it('re-cuts an SRT file into horizontal and vertical, writing a valid document and every format', async () => {
    const { dir, log, doc } = await recut('talk.srt');
    expect(validate(doc).valid).toBe(true);
    expect(doc.language).toBe('en');
    expect(doc.meta).toEqual({ source: 'srt', timing: ESTIMATED_TIMING, linebreaks: 'rules', rules: '1', languageData: languageDataHash('en'), generator: 'overtone-captions@test', createdAt: '2026-10-17T09:00:00.000Z' });
    expect(doc.speakers).toEqual([{ id: 'S1' }]);
    expect(doc.duration).toBe(24.9);
    const words = flattenWords(doc);
    expect(words.map((w) => w.text).join(' ')).toBe(
      'Welcome back to the workshop. Today we look at how captions are cut for phones. Most subtitle files were written for a wide screen, with lines of forty characters or more. On a phone that becomes four or five short lines, and nobody can read that fast. So we re-cut them: shorter lines, shorter cues, and breaks that follow the sentence. Tom & Sarah tested it on 12 videos. The result was easier to read, and nobody missed a word.',
    );
    expect(words.every((w) => w.match === 'interpolated' && w.confidence === 0)).toBe(true);
    // the pause between cue 3 (ends 12.6) and cue 4 (starts 14.8) stays
    expect(words.find((w) => w.text === 'So')!.start).toBe(14.8);
    expect(doc.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
    for (const p of doc.profiles) for (const cue of p.cues) for (const line of cue.lines) expect(line.text.length).toBeLessThanOrEqual(p.rules!.maxCharsPerLine);
    expect(log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5))).toEqual(
      ['talk.overtone.json', 'talk.horizontal.vtt', 'talk.horizontal.srt', 'talk.vertical.vtt', 'talk.vertical.srt', 'talk.txt'].map((f) => join(dir, f)),
    );
    expect(log.lines).toContain('info: recut: 6 SubRip cues, 79 words; word times estimated from the cue times');
    expect(log.lines).toContain('info:   language: en (detected from the text)');
    const srt = await readFile(join(dir, 'talk.vertical.srt'), 'utf8');
    expect(srt.startsWith('1\n00:00:00,500 --> ')).toBe(true);
    expect(await readFile(join(dir, 'talk.txt'), 'utf8')).toMatch(/^S1: Welcome back to the workshop\./);
  });

  it('re-cuts a WebVTT file with voice tags into speaker turns and labels', async () => {
    const { doc, log } = await recut('interview.vtt', { profiles: 'vertical', speakers: 'S2=Tom B.' });
    expect(validate(doc).valid).toBe(true);
    expect(doc.speakers).toEqual([{ id: 'S1', label: 'Sarah' }, { id: 'S2', label: 'Tom B.' }]);
    expect(doc.turns.map((t) => t.speaker)).toEqual(['S1', 'S2', 'S1', 'S2', 'S1', 'S2']);
    expect(doc.meta?.source).toBe('vtt');
    expect(doc.profiles.map((p) => p.id)).toEqual(['vertical']);
    // a speaker change always starts a new cue
    for (const cue of doc.profiles[0].cues) expect(new Set(flattenWords(doc).slice(cue.lines[0].words[0], cue.lines.at(-1)!.words[1] + 1).map((w) => w.speaker)).size).toBe(1);
    expect(log.lines).toContain('info:   speakers: 2 (from voice tags)');
  });

  it('never runs a caption past a cue that ends a sentence when the file names no speakers', async () => {
    const doc = await recutText('door.srt', DOOR);
    expect(doc.speakers).toEqual([{ id: 'S1' }]);
    expect(doc.turns).toHaveLength(1);
    expect(cueTexts(doc, 'horizontal')).toEqual([
      ['Did you lock the door?'],
      ['Yes. Twice.'],
      ['Then why is it open?'],
      // an ellipsis that opens a cue continues the sentence: these two may share a caption
      ['I was going to tell you...', '...but you would panic.'],
      ['I thought we could-'],
      ['No.'],
    ]);
    // in every profile, no caption spans a marked cue end
    const marks = possibleSpeakerChanges(parseSubtitles(DOOR, 'srt'))!;
    for (const p of doc.profiles) {
      for (const cue of p.cues) {
        for (let i = cue.lines[0].words[0]; i < cue.lines.at(-1)!.words[1]; i++) expect(marks[i], `${p.id}: ${cue.lines.map((l) => l.text).join(' / ')}`).toBe(false);
      }
    }
  });

  it('never runs a caption past a cue that ends a sentence in a file with dialogue dashes', async () => {
    const doc = await recutText('dashes.srt', DASHES);
    for (const id of ['horizontal', 'vertical']) expect(cueTexts(doc, id)).toEqual([['Are you ready?'], ['Of course.'], ['Then go.'], ['I am going.']]);
  });

  it('still joins the sentences of one named speaker across cues', async () => {
    const doc = await recutText('voices.vtt', VOICES);
    expect(cueTexts(doc, 'horizontal')).toEqual([['Thanks for coming in. It means a lot.'], ['Happy to be here. Really.']]);
  });

  it('applies --profiles and the config file\'s profileRules exactly as transcribe does', async () => {
    const config = { profileRules: { vertical: { rules: { maxCharsPerLine: 32 } }, square: { description: 'Feed', aspect: '1:1', rules: { maxCharsPerLine: 26, maxLines: 3 } } }, export: ['json', 'srt'] };
    const { dir, doc, log } = await recut('talk.srt', { profiles: 'vertical,square' }, config);
    expect(doc.profiles.map((p) => [p.id, p.description, p.rules])).toEqual([
      ['vertical', 'Phone', { maxCharsPerLine: 32, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5 }],
      ['square', 'Feed', { maxCharsPerLine: 26, maxLines: 3, maxCps: 16, minDuration: 0.9, maxDuration: 6 }],
    ]);
    expect(Math.max(...cueTexts(doc, 'vertical').flat().map((l) => l.length))).toBeGreaterThan(22);
    for (const l of cueTexts(doc, 'vertical').flat()) expect(l.length).toBeLessThanOrEqual(32);
    expect(cueTexts(doc, 'square').some((lines) => lines.length === 3)).toBe(true);
    // the config file's "export" applies too
    expect(log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5))).toEqual(['talk.overtone.json', 'talk.vertical.srt', 'talk.square.srt'].map((f) => join(dir, f)));
  });

  it('ignores the config file\'s context settings, which recut does not use (a missing context file is no error)', async () => {
    const { doc } = await recut('talk.srt', { export: 'json' }, { contextFile: 'missing-context.txt', context: 'A talk.' });
    expect(doc.profiles.length).toBeGreaterThan(0);
  });

  it('uses --language for the language pack and rejects an invalid one', async () => {
    const { doc } = await recut('talk.srt', { language: 'en-GB', export: 'json' });
    expect(doc.language).toBe('en-GB');
    const dir = await tempDir('overtone-recut-');
    await copyFile(join(FIXTURES, 'talk.srt'), join(dir, 'talk.srt'));
    await expect(runRecut('talk.srt', { language: 'not a language' }, memoryLogger(), dir)).rejects.toThrow(/Invalid language "not a language"/);
  });

  it('re-cuts an .overtone.json document from its real word times, keeping words, speakers and edits', async () => {
    const dir = await tempDir('overtone-recut-');
    await copyFile(SAMPLE, join(dir, 'sample.overtone.json'));
    await writeFile(join(dir, 'overtone.config.json'), JSON.stringify({ profileRules: { vertical: { rules: { maxCharsPerLine: 32 } } } }));
    const original = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const log = memoryLogger();
    // same folder: the input is never overwritten
    await runRecut('sample.overtone.json', { profiles: 'vertical' }, log, dir, { now: NOW, generator: 'overtone-captions@test' });
    expect(log.lines.some((l) => l.startsWith('warn: Not overwriting the input file'))).toBe(true);
    expect(await readFile(join(dir, 'sample.overtone.json'), 'utf8')).toBe(await readFile(SAMPLE, 'utf8'));

    await runRecut('sample.overtone.json', { profiles: 'vertical', out: 'out' }, memoryLogger(), dir, { now: NOW, generator: 'overtone-captions@test' });
    const doc = JSON.parse(await readFile(join(dir, 'out', 'sample.overtone.json'), 'utf8')) as OvertoneDocument;
    expect(validate(doc).valid).toBe(true);
    expect(flattenWords(doc).map(({ text, start, end }) => ({ text, start, end }))).toEqual(flattenWords(original).map(({ text, start, end }) => ({ text, start, end })));
    expect(doc.speakers).toEqual(original.speakers);
    expect(doc.edits).toEqual(original.edits);
    expect(doc.language).toBe('en');
    expect(doc.profiles.map((p) => [p.id, p.rules?.maxCharsPerLine])).toEqual([['vertical', 32]]);
    expect(doc.meta).toMatchObject({ title: original.meta?.title, context: original.meta?.context, linebreaks: 'rules', generator: 'overtone-captions@test' });
    expect(doc.meta?.timing).toBeUndefined();
  });

  it('runs through the CLI without any API key or ffmpeg', async () => {
    const dir = await tempDir('overtone-recut-');
    await copyFile(join(FIXTURES, 'interview.vtt'), join(dir, 'interview.vtt'));
    const log = memoryLogger();
    await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'recut', 'interview.vtt', '--export', 'vtt', '--profiles', 'vertical']);
    expect(process.exitCode).toBe(0);
    const vtt = await readFile(join(dir, 'interview.vertical.vtt'), 'utf8');
    expect(vtt).toMatch(/^WEBVTT\n\n00:00:01\.000 --> [\d:.]+\n<v Sarah>Thanks for joining us\./);
  });

  describe('errors', () => {
    const fail = async (name: string, content: string | Buffer | undefined, message: RegExp) => {
      const dir = await tempDir('overtone-recut-');
      if (content !== undefined) await writeFile(join(dir, name), content);
      const err = await runRecut(name, {}, memoryLogger(), dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as Error).message).toMatch(message);
    };
    it('missing file', () => fail('gone.srt', undefined, /^File not found: gone\.srt$/));
    it('empty file', () => fail('empty.srt', '﻿ \r\n', /^empty\.srt is empty\.$/));
    it('subtitles without cues', () => fail('nocues.vtt', 'WEBVTT\n\nNOTE nothing here\n', /^nocues\.vtt has no cues with text \(read as WebVTT\)\.$/));
    it('plain text', () => fail('talk.txt', 'Just a transcript.', /not a subtitle file recut can read: expected SubRip \(\.srt\), WebVTT \(\.vtt\) or an \.overtone\.json document.*--text-file talk\.txt/s));
    it('a media file', () => fail('clip.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), /^clip\.mp4 is not a text file \(it looks binary\)\. Is it a media file\?$/));
    it('invalid JSON', () => fail('x.overtone.json', '{ nope', /^x\.overtone\.json: not valid JSON/));
    it('a JSON file that is not a document', () => fail('x.json', '{"format":"other"}', /^x\.json is not a valid Overtone document:\n/));
    it('an unknown profile', async () => {
      const dir = await tempDir('overtone-recut-');
      await copyFile(join(FIXTURES, 'talk.srt'), join(dir, 'talk.srt'));
      await expect(runRecut('talk.srt', { profiles: 'square' }, memoryLogger(), dir)).rejects.toThrow(/Unknown profile "square": use horizontal or vertical, an aspect such as "1:1", or define profileRules\.square/);
    });
  });
});

describe('overtone recut with mp4', () => {
  const message = 'mp4 needs the media file; use "overtone burn <media> <document>".';

  it('refuses --export mp4 before writing anything', async () => {
    const dir = await tempDir('overtone-recut-mp4-');
    await copyFile(join(FIXTURES, 'talk.srt'), join(dir, 'talk.srt'));
    await expect(runRecut('talk.srt', { export: 'mp4' }, memoryLogger(), dir)).rejects.toThrow(new UserError(message));
    await expect(runRecut('talk.srt', { export: 'json,mp4' }, memoryLogger(), dir)).rejects.toThrow(new UserError(message));
    await writeFile(join(dir, 'overtone.config.json'), JSON.stringify({ export: ['mp4'] }));
    await expect(runRecut('talk.srt', { export: 'mp4' }, memoryLogger(), dir)).rejects.toThrow(new UserError(message));
    expect(await readdir(dir)).toEqual(['overtone.config.json', 'talk.srt']);
  });

  it('ignores "mp4" from the config file\'s "export" with an info line and writes the other formats', async () => {
    const dir = await tempDir('overtone-recut-mp4-');
    await copyFile(join(FIXTURES, 'talk.srt'), join(dir, 'talk.srt'));
    await writeFile(join(dir, 'overtone.config.json'), JSON.stringify({ export: ['srt', 'mp4'] }));
    const log = memoryLogger();
    expect(await runRecut('talk.srt', {}, log, dir)).toBe(0);
    expect(log.lines).toContain('info: recut: ignoring "mp4" from the config file\'s "export" (it needs the media; use overtone burn)');
    expect((await readdir(dir)).filter((f) => f.startsWith('talk.')).sort()).toEqual(['talk.horizontal.srt', 'talk.srt', 'talk.vertical.srt']);
  });

  it('writes the default formats when the config file lists only "mp4"', async () => {
    const dir = await tempDir('overtone-recut-mp4-');
    await copyFile(join(FIXTURES, 'talk.srt'), join(dir, 'talk.srt'));
    await writeFile(join(dir, 'overtone.config.json'), JSON.stringify({ export: 'mp4' }));
    const log = memoryLogger();
    expect(await runRecut('talk.srt', {}, log, dir)).toBe(0);
    expect(log.lines.some((l) => l.includes('ignoring "mp4"'))).toBe(true);
    expect(await readdir(dir)).toContain('talk.overtone.json');
  });
});
