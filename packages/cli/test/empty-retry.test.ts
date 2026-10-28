// The retries of a chunk the text provider answered with no text (text-base.ts, EMPTY_RETRY). The offline regression
// gate starts from frozen hearings, after this step, so it cannot see a change here: these tests can.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { EMPTY_RETRY } from '../src/pipeline/text-base.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { TextRetry } from '../src/pipeline/types.js';
import type { AudioChunk, LlmRequest, TextOptions } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const CONTEXT = 'A short film that opens with a long stretch of music.';
const LINES = 'Excuse me, sir. Do you have a moment?';
const said = (text: string, start: number, step = 0.4): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker: 'S1' }));
// 12 s of music, then the dialogue (the engines heard it); the clip is 20 s long
const HEARD = said(LINES, 12);

interface Call { path: string; start: number; end: number; opts: TextOptions }

/**
 * A text provider like gpt-transcribe on a film that opens with music: no text for the whole chunk, also
 * loudness-normalized; `answers` decides what each retry gets (by its audio and prompt).
 */
function fakeProviders(answer: (c: Call) => string) {
  const calls: Call[] = [];
  const providers: Providers = {
    text: {
      id: 'fake:text',
      transcribe: async (chunk: AudioChunk, opts: TextOptions) => {
        const c = { path: chunk.path, start: chunk.start, end: chunk.end, opts };
        calls.push(c);
        return { text: answer(c) };
      },
    },
    timing: { id: 'fake:timing', align: async () => ({ words: HEARD, language: 'en-US' }) },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        if (req.name === 'choose') return { spans: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
  return { providers, calls };
}

async function setup(flags: CliFlags = {}, glossary: string[] = ['Franck', 'Victor']) {
  const dir = await tempDir('overtone-empty-retry-');
  const file = `${dir}/film.m4a`;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:a', 'aac', file]);
  const cfg = await resolveConfig({ export: 'json', context: CONTEXT, ...flags }, { glossary }, { cwd: dir, configDir: dir });
  const cuts: Array<{ input: string; start: number; end: number }> = [];
  const deps = {
    cwd: dir,
    normalizeLoudness: async (path: string) => path.replace(/\.(mp3|wav)$/, '.loud.$1'),
    cutAudio: async (input: string, start: number, end: number) => {
      cuts.push({ input, start, end });
      return input.replace(/\.(mp3|wav)$/, `.region-${Math.round(start * 1000)}-${Math.round(end * 1000)}.$1`);
    },
  };
  return { file, cfg, cuts, deps };
}

const textOf = (doc: { turns: Array<{ words: Array<{ text: string }> }> }) => doc.turns.flatMap((t) => t.words.map((w) => w.text)).join(' ');
const trimmed = (c: Call) => c.path.includes('.loud.region-');
const retriesOf = (doc: { meta?: object }) => ((doc.meta as { textRetries?: TextRetry[] } | undefined)?.textRetries ?? []);

describe.skipIf(!hasFfmpeg)('pipeline: retries of an empty chunk', () => {
  it('recovers the text of a film whose music intro left the text model with no language: only the speech is sent', async () => {
    expect(EMPTY_RETRY).toEqual({ pad: 0.5, minCut: 1 });
    const { file, cfg, cuts, deps } = await setup();
    const { providers, calls } = fakeProviders((c) => (trimmed(c) ? LINES : ''));
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers });

    expect(calls).toHaveLength(3);
    const [first, whole, speech] = calls;
    // the first request has the full prompt and no language
    expect(first!.opts.prompt).toContain(CONTEXT);
    expect(first!.opts.language).toBeUndefined();
    // retry 1: the whole chunk, loudness-normalized, with the language the engines heard and the whole prompt
    expect(whole!.path.endsWith('.loud.mp3')).toBe(true);
    expect(whole!.opts.language).toBe('en');
    expect(whole!.opts.prompt).toBe(first!.opts.prompt);
    expect(whole!.opts.prompt).toContain(CONTEXT);
    // retry 2: from the engines' first word − 0.5 s to their last word + 0.5 s, the glossary alone, same language
    const last = HEARD[HEARD.length - 1]!.end;
    expect(cuts).toEqual([{ input: expect.stringMatching(/\.loud\.mp3$/), start: 11.5, end: expect.closeTo(last + 0.5, 3) }]);
    expect(speech).toMatchObject({ start: 11.5, end: expect.closeTo(last + 0.5, 3), opts: { language: 'en', prompt: 'Names and terms: Franck, Victor.' } });

    expect(textOf(res.doc)).toBe(LINES);
    expect(res.doc.meta).not.toHaveProperty('fallbacks');
    expect(res.doc.meta?.textRetries).toEqual([{
      start: 0, end: expect.closeTo(20, 0), reason: 'the text provider returned no text where the engines heard 8 words', loudnorm: true, language: 'en',
      attempts: [
        { audio: 'chunk', prompt: 'context', words: 0 },
        { audio: 'speech', start: 11.5, end: expect.closeTo(last + 0.5, 3), prompt: 'names', words: 8 },
      ],
      attempt: 2, result: 'retry',
    }]);
    expect(log.lines).toContain('info:   chunk 1/1 (0:00:00–0:00:20): retry 2 of 3 (only 0:00:12–0:00:16, where the engines heard speech, glossary and earlier text as prompt): 8 words');
  });

  it('stops at the first answer with words', async () => {
    const { file, cfg, cuts, deps } = await setup();
    const { providers, calls } = fakeProviders((c) => (c.path.endsWith('.loud.mp3') ? LINES : ''));
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(calls).toHaveLength(2);
    expect(cuts).toEqual([]);
    expect(textOf(res.doc)).toBe(LINES);
    expect(res.doc.meta?.textRetries).toEqual([expect.objectContaining({ attempts: [{ audio: 'chunk', prompt: 'context', words: 8 }], attempt: 1, result: 'retry' })]);
  });

  it('counts what one engine heard in the note, not both engines\' words added up', async () => {
    const { file, cfg, deps } = await setup();
    const { providers } = fakeProviders((c) => (trimmed(c) ? LINES : ''));
    const second = { id: 'fake:second', align: async () => ({ words: HEARD, language: 'en-US' }) };
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: { ...providers, secondTiming: second } });
    expect(retriesOf(res.doc)[0]?.reason).toBe(`the text provider returned no text where the engines heard ${HEARD.length} words`);
  });

  it('tries the speech once more without a prompt, then takes the engines\' words', async () => {
    const { file, cfg, deps } = await setup();
    const { providers, calls } = fakeProviders(() => '');
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers });
    expect(calls).toHaveLength(4);
    expect(trimmed(calls[3]!)).toBe(true);
    expect(calls[3]!.opts.prompt).toBeUndefined();
    expect(textOf(res.doc)).toBe(LINES);
    expect(res.doc.meta?.fallbacks).toEqual([expect.objectContaining({ start: 0 })]);
    expect(res.doc.meta?.textRetries).toEqual([expect.objectContaining({
      attempts: [
        { audio: 'chunk', prompt: 'context', words: 0 },
        expect.objectContaining({ audio: 'speech', prompt: 'names', words: 0 }),
        expect.objectContaining({ audio: 'speech', prompt: 'none', words: 0 }),
      ],
      result: 'timing',
    })]);
    expect(retriesOf(res.doc)[0]).not.toHaveProperty('attempt');
  });

  it('sends no request twice: without a glossary the speech has no prompt either way, so there is no third try', async () => {
    const { file, cfg, deps } = await setup({}, []);
    const { providers, calls } = fakeProviders(() => '');
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).map((c) => [trimmed(c), c.opts.prompt])).toEqual([[false, CONTEXT], [true, undefined]]);
    expect(retriesOf(res.doc)[0]?.attempts?.map((a) => a.prompt)).toEqual(['context', 'none']);
  });

  it('without a context or glossary every try has no prompt: the whole chunk, then the speech', async () => {
    const { file, cfg, deps } = await setup({ context: undefined, inferContext: false }, []);
    cfg.context = undefined;
    const { providers, calls } = fakeProviders(() => '');
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(calls.slice(1).map((c) => [trimmed(c), c.opts.prompt])).toEqual([[false, undefined], [true, undefined]]);
    expect(retriesOf(res.doc)[0]?.attempts?.map((a) => a.prompt)).toEqual(['none', 'none']);
  });

  it('does not trim when the speech fills the chunk', async () => {
    const { file, cfg, cuts, deps } = await setup();
    const { providers, calls } = fakeProviders(() => '');
    const filled = said('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', 0.3, 0.98);
    providers.timing = { id: 'fake:timing', align: async () => ({ words: filled, language: 'en-US' }) };
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(cuts).toEqual([]);
    expect(calls.slice(1).map((c) => [trimmed(c), c.opts.prompt === undefined])).toEqual([[false, false], [false, true]]);
    expect(retriesOf(res.doc)[0]?.attempts?.map((a) => a.audio)).toEqual(['chunk', 'chunk']);
  });
});
