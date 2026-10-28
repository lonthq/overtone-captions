// Without --language, the text provider's first request carries the language the second hearing detected
// (pipeline/timing.ts secondHearingOnce): gpt-transcribe returns no text for some films when it must detect it.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { AudioChunk, AudioFile, LlmRequest, TextOptions, TimingOptions } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const LINES = 'We have main engine start. Four, three, two, one.';
const HEARD: TimedWord[] = LINES.split(' ').map((t, i) => ({ text: t, start: 1 + i * 0.4, end: 1.3 + i * 0.4, speaker: 'S1' }));

/**
 * A text provider like gpt-transcribe on a film soundtrack: no text unless it is told the language. The second
 * hearing detects the language (`heard`), or fails (`fails`).
 */
function fakeProviders(second: { heard?: string; fails?: boolean }) {
  const textOpts: TextOptions[] = [];
  const secondOpts: TimingOptions[] = [];
  const providers: Providers = {
    text: {
      id: 'fake:text',
      transcribe: async (_chunk: AudioChunk, opts: TextOptions) => {
        textOpts.push(opts);
        return { text: opts.language === 'en' ? LINES : '' };
      },
    },
    timing: { id: 'fake:timing', align: async () => ({ words: HEARD, language: 'en-US' }) },
    secondTiming: {
      id: 'fake:second',
      align: async (_file: AudioFile, opts: TimingOptions) => {
        secondOpts.push(opts);
        if (second.fails) throw new Error('HTTP 503 unavailable');
        return { words: HEARD, ...(second.heard ? { language: second.heard } : {}) };
      },
    },
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
  return { providers, textOpts, secondOpts };
}

async function setup(flags: CliFlags = {}) {
  const dir = await tempDir('overtone-second-language-');
  const file = `${dir}/film.m4a`;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-c:a', 'aac', file]);
  const cfg = await resolveConfig({ export: 'json', context: 'A short science-fiction film.', ...flags }, {}, { cwd: dir, configDir: dir });
  return { file, cfg, deps: { cwd: dir, normalizeLoudness: async (path: string) => path } };
}

const textOf = (doc: { turns: Array<{ words: Array<{ text: string }> }> }) => doc.turns.flatMap((t) => t.words.map((w) => w.text)).join(' ');

describe.skipIf(!hasFfmpeg)('pipeline: the language of the first text request', () => {
  it('without --language, sends the text provider the language the second hearing detected, and asks the second hearing once', async () => {
    const { file, cfg, deps } = await setup();
    const { providers, textOpts, secondOpts } = fakeProviders({ heard: 'en' });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers });
    expect(secondOpts).toHaveLength(1);
    expect(secondOpts[0]!.language).toBeUndefined();
    expect(textOpts).toHaveLength(1);
    expect(textOpts[0]!.language).toBe('en');
    expect(textOf(res.doc)).toBe(LINES);
    expect(res.doc.meta).not.toHaveProperty('textRetries');
    expect(log.lines).toContain('info:   language: en (heard by fake:second), sent with the text');
  });

  it('with --language, sends that language to both and does not wait for the second hearing', async () => {
    const { file, cfg, deps } = await setup({ language: 'en' });
    const { providers, textOpts, secondOpts } = fakeProviders({ heard: 'nl' });
    const log = memoryLogger();
    await runPipeline(file, cfg, { ...deps, log, providers });
    expect(secondOpts.map((o) => o.language)).toEqual(['en']);
    expect(textOpts[0]!.language).toBe('en');
    expect(log.lines.some((l) => l.includes('sent with the text'))).toBe(false);
  });

  it('when the second hearing fails, sends the first request without a language and retries the empty chunk as before', async () => {
    const { file, cfg, deps } = await setup();
    const { providers, textOpts, secondOpts } = fakeProviders({ fails: true });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers });
    expect(secondOpts).toHaveLength(1);
    expect(textOpts[0]!.language).toBeUndefined();
    // the retry takes the language the timing provider heard
    expect(textOpts[1]!.language).toBe('en');
    expect(textOf(res.doc)).toBe(LINES);
    expect(log.lines.filter((l) => l.startsWith('warn:') && l.includes('fake:second failed'))).toHaveLength(1);
  });

  it('when the second hearing reports no language, sends the first request without one', async () => {
    const { file, cfg, deps } = await setup();
    const { providers, textOpts } = fakeProviders({});
    await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(textOpts[0]!.language).toBeUndefined();
  });
});
