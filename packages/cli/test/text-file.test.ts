import { copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenWords, validate } from 'overtone-format';
import { resolveConfig, type CliFlags, type FileConfig } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import type { ExtractResult } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { FileTextProvider, readTranscriptFile } from '../src/providers/file.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmRequest } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/subtitles');

describe('readTranscriptFile', () => {
  it('reads SRT and WebVTT as their cue text, without timing, names or markup', async () => {
    const srt = await readTranscriptFile(join(FIXTURES, 'talk.srt'), 'talk.srt');
    expect(srt).toMatchObject({ format: 'srt', cues: 6 });
    expect(srt.text).toMatch(/^Welcome back to the workshop\. Today we look at .* Tom & Sarah tested it on 12 videos\. .* missed a word\.$/);
    const vtt = await readTranscriptFile(join(FIXTURES, 'interview.vtt'));
    expect(vtt.text.startsWith('Thanks for joining us. How did the project start? It started')).toBe(true);
    expect(vtt.text).not.toMatch(/Sarah|<|-->/);
  });

  it('reads anything else as plain text, and refuses JSON, empty and binary files', async () => {
    const dir = await tempDir('overtone-textfile-');
    await writeFile(join(dir, 'a.txt'), '﻿Hello  there.\r\n\r\nSecond   paragraph.\n');
    expect(await readTranscriptFile(join(dir, 'a.txt'))).toEqual({ path: join(dir, 'a.txt'), format: 'txt', text: 'Hello there. Second paragraph.' });
    // content that is SubRip is read as SubRip whatever its extension
    await writeFile(join(dir, 'b.txt'), '1\n00:00:01,000 --> 00:00:02,000\nJOHN: Hi.\n');
    expect((await readTranscriptFile(join(dir, 'b.txt'))).text).toBe('Hi.');
    await writeFile(join(dir, 'empty.txt'), ' \n');
    await writeFile(join(dir, 'x.overtone.json'), '{}');
    await writeFile(join(dir, 'clip.m4a'), Buffer.from([0, 1, 2, 3]));
    await expect(readTranscriptFile(join(dir, 'empty.txt'), 'empty.txt')).rejects.toThrow(/^--text-file empty\.txt is empty\.$/);
    await expect(readTranscriptFile(join(dir, 'x.overtone.json'), 'x.overtone.json')).rejects.toThrow(/not JSON\. To re-cut an \.overtone\.json file, use "overtone recut"/);
    await expect(readTranscriptFile(join(dir, 'clip.m4a'), 'clip.m4a')).rejects.toThrow(/clip\.m4a is not a text file/);
    await expect(readTranscriptFile(join(dir, 'gone.txt'), 'gone.txt')).rejects.toThrow(/^File not found: gone\.txt$/);
  });

  it('serves the whole text in one call as the text role', async () => {
    const p = new FileTextProvider({ path: '/x/talk.srt', format: 'srt', text: 'Hi there.' });
    expect(p).toMatchObject({ id: 'file:talk.srt', input: 'wav' });
    expect(await p.transcribe({ path: 'audio.wav', index: 0, start: 0, end: 10 })).toEqual({ text: 'Hi there.' });
  });
});

describe('--text-file options', () => {
  const resolveWith = (flags: CliFlags, file = {}) => resolveConfig(flags, file, { cwd: '/w', configDir: '/w' });

  it('resolves the path against the working folder', async () => {
    expect((await resolveWith({ textFile: 'talk.srt' })).textFile).toBe('/w/talk.srt');
    expect((await resolveWith({})).textFile).toBeUndefined();
  });

  it('cannot be combined with --two-pass or --text', async () => {
    await expect(resolveWith({ textFile: 'talk.srt', twoPass: true })).rejects.toThrow(new UserError('--two-pass cannot be combined with --text-file: the text comes from the file, so there is nothing to transcribe again.'));
    await expect(resolveWith({ textFile: 'talk.srt', text: 'openai' })).rejects.toThrow(/--text and --text-file cannot be combined/);
  });

  it('with --local (or "local": true), whisper.cpp times the file instead of "--timing same"', async () => {
    expect((await resolveWith({ textFile: 't.txt', local: true })).timing.id).toBe('whisper-cpp:large-v3-turbo');
    expect((await resolveWith({ textFile: 't.txt' }, { local: true })).timing.id).toBe('whisper-cpp:large-v3-turbo');
    expect((await resolveWith({ textFile: 't.txt', local: true, timing: 'azure-speech' })).timing.id).toBe('azure-speech');
    expect((await resolveWith({ local: true })).timing.id).toBe('same');
  });
});

describe('--local with text from another provider', () => {
  it('times it with whisper.cpp instead of "--timing same", which that provider cannot do', async () => {
    const dirs = { cwd: '/w', configDir: '/w' };
    const sel = async (flags: CliFlags, file: FileConfig = {}) => {
      const cfg = await resolveConfig(flags, file, dirs);
      return [cfg.text.id, cfg.timing.id];
    };
    expect(await sel({ local: true, text: 'openai' })).toEqual(['openai', 'whisper-cpp:large-v3-turbo']);
    expect(await sel({ text: 'openai' }, { local: true })).toEqual(['openai', 'whisper-cpp:large-v3-turbo']);
    expect(await sel({ local: true }, { text: 'openai' })).toEqual(['whisper-cpp:large-v3-turbo', 'same']);
    // another whisper.cpp model still writes the text and its timings in one call; an explicit --timing wins
    expect(await sel({ local: true, text: 'whisper-cpp:base' })).toEqual(['whisper-cpp:base', 'same']);
    expect(await sel({ local: true, text: 'openai', timing: 'azure-speech' })).toEqual(['openai', 'azure-speech']);
  });
});

/** Timing words for "Hello there, this is a test of the captions. We keep the text from the file." (heard slightly differently). */
const HEARD = ['hello', 'there', 'this', 'is', 'a', 'test', 'of', 'the', 'caption', 'we', 'keep', 'the', 'text', 'from', 'the', 'file'];
const timed = (words: readonly string[], from = 0.5, speaker = (i: number) => (i < 9 ? 'S1' : 'S2')): TimedWord[] =>
  words.map((text, i) => ({ text, start: from + i * 0.5, end: from + i * 0.5 + 0.4, speaker: speaker(i) }));

function providers(timingWords: TimedWord[]): Providers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    text: { id: 'fake:text', transcribe: async () => { throw new Error('the text provider must not be called with --text-file'); } },
    timing: { id: 'fake:timing', align: async () => { calls.push('timing'); return { words: timingWords }; } },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        calls.push(req.name);
        if (req.name === 'context') return { topic: 'A short test of captions.', names: [], terms: [] } as T;
        if (req.name === 'corrections') return { edits: [], speakers: [{ id: 'S1', label: 'Host', role: 'host' }] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
}

/** Run the pipeline on a dummy media file with a fake extract stage (no ffmpeg, no audio). */
async function run(text: { name: string; content?: string; fixture?: string }, timingWords: TimedWord[], flags: CliFlags = {}, duration = 10, folder?: string) {
  const dir = folder ?? (await tempDir('overtone-textfile-'));
  const media = join(dir, 'clip.mp4');
  await writeFile(media, 'not really media'); // created by the test, never committed
  if (text.fixture) await copyFile(join(FIXTURES, text.fixture), join(dir, text.name));
  else await writeFile(join(dir, text.name), text.content ?? '');
  const cfg = await resolveConfig({ export: 'json,srt', llmLinebreaks: false, textFile: text.name, ...flags }, {}, { cwd: dir, configDir: dir });
  const extract = async (): Promise<ExtractResult> => ({ duration, wav: join(dir, 'audio.wav'), chunks: [{ path: join(dir, 'c0.mp3'), index: 0, start: 0, end: duration }] });
  const p = providers(timingWords);
  const log = memoryLogger();
  const res = await runPipeline(media, cfg, { log, cwd: dir, providers: p, extractAudio: extract, checkBinaries: async () => [], probeDuration: async () => duration });
  return { res, log, calls: p.calls };
}

describe('transcribe --text-file', () => {
  it('times the file\'s text with the timing provider: the text wins, speakers come from timing, refine runs', async () => {
    const { res, log, calls } = await run({ name: 'script.txt', content: 'Hello there, this is a test of the captions. We keep the text from the file.' }, timed(HEARD));
    expect(calls).toEqual(['timing', 'context', 'corrections', 'styling']);
    const words = flattenWords(res.doc);
    expect(words.map((w) => w.text).join(' ')).toBe('Hello there, this is a test of the captions. We keep the text from the file.');
    expect(words.find((w) => w.text === 'captions.')).toMatchObject({ start: 4.5, match: 'fuzzy' });
    expect(res.doc.turns.map((t) => t.speaker)).toEqual(['S1', 'S2']);
    expect(res.doc.speakers[0]).toEqual({ id: 'S1', label: 'Host', role: 'host' });
    expect(res.doc.meta?.models?.text).toBe('file:script.txt');
    expect(res.doc.meta?.contextSource).toBe('inferred');
    expect(validate(res.doc).valid).toBe(true);
    expect(log.lines).toContain('info:   text: script.txt (16 words; no text provider is called)');
    expect(log.lines.some((l) => l.startsWith('warn:'))).toBe(false);
  });

  it('reads SubRip as its text only: cue times and markup are dropped, the timing provider gives the times', async () => {
    const heard = 'welcome back to the workshop today we look at how captions are cut for phones'.split(' ');
    const srt = '1\n00:00:00,000 --> 00:00:01,000\n<i>Welcome back</i> to the workshop.\n\n2\n00:00:01,000 --> 00:00:02,000\nToday we look at how captions\nare cut for phones.\n';
    const { res, log } = await run({ name: 'talk.srt', content: srt }, timed(heard, 2, () => 'S1'));
    const words = flattenWords(res.doc);
    expect(words.map((w) => w.text).join(' ')).toBe('Welcome back to the workshop. Today we look at how captions are cut for phones.');
    expect(words[0]).toMatchObject({ start: 2, match: 'exact' });
    expect(log.lines).toContain('info:   text: talk.srt (2 cues, 15 words; no text provider is called)');
  });

  it('warns when the file leaves out speech the timing provider heard, and keeps the text as given (no fill)', async () => {
    const extra = 'and then the second half of the talk goes on for a long while about many other things nobody wrote down here at all'.split(' ');
    const { res, log } = await run({ name: 'part.txt', content: 'Hello there, this is a test of the captions. We keep the text from the file.' }, timed([...HEARD, ...extra], 0.5, () => 'S1'), {}, 30);
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toEqual([
      'warn: --text-file: the text has no words for 0:00:09–0:00:20 (24 words heard); keeping the text as given, so speech it leaves out gets no captions',
    ]);
    expect(flattenWords(res.doc).map((w) => w.text).join(' ')).toBe('Hello there, this is a test of the captions. We keep the text from the file.');
    expect(res.doc.meta?.fallbacks).toBeUndefined();
  });

  it('reads the file again on every run, so a changed text is used', async () => {
    const dir = await tempDir('overtone-textfile-');
    const first = await run({ name: 's.txt', content: 'Hello there, this is a test.' }, timed(HEARD), { inferContext: false }, 10, dir);
    expect(first.log.lines).toContain('info: [2/6] transcribe …');
    const changed = await run({ name: 's.txt', content: 'Hello there, this was a test.' }, timed(HEARD), { inferContext: false }, 10, dir);
    expect(changed.log.lines).toContain('info: [2/6] transcribe …');
    expect(flattenWords(changed.res.doc).map((w) => w.text)).toContain('was');
  });

  it('warns when the file is far shorter than the speech', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const { log } = await run({ name: 'short.txt', content: 'Just three words.' }, timed(many, 0, () => 'S1'), { inferContext: false }, 25);
    expect(log.lines).toContain('warn: --text-file: the text has 3 words where the timing provider heard 40 (is it the transcript of this media?); keeping the text as given, so speech it leaves out gets no captions');
  });

  it('refuses --timing same: the file has no word timings', async () => {
    await expect(run({ name: 't.txt', content: 'Hi.' }, [], { timing: 'same' })).rejects.toThrow(/^--timing same cannot be used with --text-file: the file has no word timings/);
  });

  it('stops before any work for an unusable file', async () => {
    await expect(run({ name: 'empty.vtt', content: 'WEBVTT\n' }, [])).rejects.toThrow(/^--text-file \S*empty\.vtt has no cues with text\.$/);
  });
});
