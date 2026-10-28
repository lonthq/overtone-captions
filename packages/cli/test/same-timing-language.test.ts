import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { textLanguageOpts } from '../src/pipeline/align.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmRequest, TextOptions, TimingProvider } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const said = (text: string, start: number, step = 0.3): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker: 'S1' }));

describe('textLanguageOpts', () => {
  it('reduces the timing options to main language codes, as every text call sends them', () => {
    expect(textLanguageOpts({ language: 'nl-BE', languages: ['nl-BE', 'fr-BE', 'nl'] })).toEqual({ language: 'nl', languages: ['nl', 'fr'] });
    expect(textLanguageOpts({ language: 'en' })).toEqual({ language: 'en' });
    expect(textLanguageOpts({})).toEqual({ language: undefined });
  });
});

describe.skipIf(!hasFfmpeg)('--timing same: snippet re-listens with the text provider', () => {
  it('sends the main language code ("nl", not "nl-BE"), so a whisper-like provider takes the snippet', async () => {
    const dir = await tempDir('overtone-same-lang-');
    const file = `${dir}/clip.m4a`;
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:a', 'aac', file]);
    const cfg = await resolveConfig({ export: 'json', context: 'A film.', language: 'nl-BE', text: 'openai:whisper-1', timing: 'same' }, {}, { cwd: dir, configDir: dir });
    const deps = {
      cwd: dir,
      cutAudio: async (input: string, start: number, end: number) => input.replace(/\.wav$/, `.region-${Math.round(start * 1000)}-${Math.round(end * 1000)}.wav`),
    };
    // the whole file: words for "Hallo daar." and "Tot ziens." only; the shout in between has text but no words
    const heard = [...said('Hallo daar.', 1), ...said('Tot ziens.', 20)];
    const snippetOpts: TextOptions[] = [];
    const log = memoryLogger();
    const providers: Providers = {
      text: {
        id: 'fake:whisper',
        transcribe: async (audio, opts) => {
          if (!audio.path.includes('region-')) return { text: 'Hallo daar. Ga nu, ga! Tot ziens.', language: 'nl', words: heard };
          snippetOpts.push(opts);
          // whisper rejects a language with a region
          if (opts.language && opts.language.includes('-')) throw new Error(`400 Invalid language '${opts.language}'`);
          return { text: 'Ga nu, ga!', words: said('Ga nu, ga!', 0.5) };
        },
      },
      timing: { id: 'unused', align: async () => { throw new Error('not used with --timing same'); } } as TimingProvider,
      llm: {
        id: 'fake:llm',
        async complete<T>(req: LlmRequest): Promise<T> {
          if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
          if (req.name === 'styling') return { styles: [] } as T;
          return { cueStarts: [], lineStarts: [] } as T;
        },
      },
    };
    const { doc } = await runPipeline(file, cfg, { ...deps, log, providers });
    expect(snippetOpts.length).toBeGreaterThan(0);
    expect(snippetOpts.every((o) => o.language === 'nl')).toBe(true);
    // the adapter reports under the selection's id, not the fake provider's
    expect(log.lines.filter((l) => l.startsWith('warn:') && / failed for /.test(l))).toEqual([]);
    // the snippet was heard: its retry took words, and "ga!" got the snippet's time (0.5 s into the region), not an estimate
    const retries = doc.meta?.timingRetries as Array<{ provider: string; heard: number }> | undefined;
    expect(retries).toEqual([expect.objectContaining({ provider: 'openai:whisper-1' })]);
    expect(retries![0]!.heard).toBeGreaterThan(0);
    const ga = doc.turns.flatMap((t) => t.words).find((w) => w.text === 'ga!');
    expect(ga?.match).toBe('exact');
  });
});
