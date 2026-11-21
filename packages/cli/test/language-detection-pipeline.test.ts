import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { burn } from '../src/burn/index.js';
import { resolveConfig, type CliFlags, type FileConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run, type ExtractResult } from '../src/media/extract.js';
import { runPipeline, type PipelineDeps } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { LanguageProvider, LanguageResult, LlmRequest, TextOptions } from '../src/providers/types.js';
import { az } from './helpers.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Fake providers; `heard` answers the detector's samples in order (the last one repeats). */
function fakes(heard: LanguageResult[] | undefined) {
  const seen = { text: [] as Array<string | undefined>, detect: 0 };
  const language: LanguageProvider | undefined = heard && {
    id: 'fake:lang',
    uncached: true,
    detect: async () => heard[Math.min(seen.detect++, heard.length - 1)]!,
  };
  const providers: Providers = {
    text: { id: 'fake:text', uncached: true, transcribe: async (_a, o?: TextOptions) => { seen.text.push(o?.language); return { text: 'hallo allemaal en welkom' }; } },
    timing: { id: 'fake:timing', uncached: true, align: async () => ({ words: az('hallo allemaal en welkom') }) },
    llm: {
      id: 'fake:llm',
      uncached: true,
      async complete<T>(req: LlmRequest): Promise<T> {
        if (req.name === 'context') return { topic: 'A test.', names: [], terms: [] } as T;
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
    ...(language ? { language } : {}),
  };
  return { providers, seen };
}

/** A media file generated at runtime (never committed). */
async function media(dir: string, kind: 'tone' | 'silent' | 'video-only', seconds = 120): Promise<string> {
  const file = join(dir, kind === 'video-only' ? 'clip.mp4' : 'clip.m4a');
  const input = kind === 'tone' ? `sine=frequency=330:duration=${seconds}` : kind === 'silent' ? `anullsrc=r=16000:cl=mono:d=${seconds}` : `color=c=black:s=64x64:r=5:d=${seconds}`;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', input, ...(kind === 'silent' ? ['-t', String(seconds)] : []), ...(kind === 'video-only' ? ['-c:v', 'libx264'] : ['-c:a', 'aac']), file]);
  return file;
}

async function transcribe(file: string, dir: string, p: Providers, flags: CliFlags = {}, fileConfig: FileConfig = {}, deps: Partial<PipelineDeps> = {}) {
  const cfg = await resolveConfig({ export: 'json,srt', llmLinebreaks: false, ...flags }, fileConfig, { cwd: dir, configDir: dir });
  const log = memoryLogger();
  const res = await runPipeline(file, { ...cfg, useCache: false }, { log, cwd: dir, providers: p, ...deps });
  return { res, log };
}

/** Providers that fail the test when any of them is called. */
function never(): Providers {
  const fail = () => { throw new Error('no provider may be called for silent media'); };
  return {
    text: { id: 'fake:text', uncached: true, transcribe: fail },
    timing: { id: 'fake:timing', uncached: true, align: fail },
    llm: { id: 'fake:llm', uncached: true, complete: fail },
    language: { id: 'fake:lang', uncached: true, detect: fail },
  };
}

describe.skipIf(!hasFfmpeg)('language detection in a run', () => {
  it('sure: sends the detected language and stores how it was found', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers, seen } = fakes([{ words: { nl: 60 } }]);
    const { res, log } = await transcribe(await media(dir, 'tone'), dir, providers);
    expect(seen.detect).toBe(3);
    expect(seen.text.length).toBeGreaterThan(0);
    expect(seen.text.every((l) => l === 'nl')).toBe(true);
    expect(res.doc.language).toBe('nl');
    expect(res.doc.meta?.languageDetection).toMatchObject({ verdict: 'sure', language: 'nl', provider: 'fake:lang' });
    expect((res.doc.meta?.languageDetection as { samples: unknown[] }).samples).toHaveLength(3);
    expect(log.lines).toContain('info:   language: nl (detected from the audio by fake:lang, sure)');
  });

  it('unsure: goes on with the most-heard language', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers, seen } = fakes([{ words: { en: 40 } }, { words: { nl: 70 } }, { words: { nl: 50 } }]);
    const { res, log } = await transcribe(await media(dir, 'tone'), dir, providers);
    expect(seen.text.every((l) => l === 'nl')).toBe(true);
    expect(res.doc.meta?.languageDetection).toMatchObject({ verdict: 'unsure', language: 'nl' });
    expect(log.lines).toContain('info:   language: nl (detected from the audio by fake:lang, unsure); samples: en 40, nl 70, nl 50');
    // logged once, by the detection step
    expect(log.lines.filter((l) => l.startsWith('info:   language: nl'))).toHaveLength(1);
  });

  it('languages.<code>.llm follows the detected language', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers } = fakes([{ words: { nl: 60 } }]);
    const created: string[] = [];
    const createLlm = (sel: { id: string }) => { created.push(sel.id); return providers.llm; };
    const { res, log } = await transcribe(await media(dir, 'tone', 20), dir, providers, {}, { languages: { nl: { llm: 'anthropic:nl-editor' } } }, { createLlm });
    expect(created).toEqual(['anthropic:nl-editor']);
    expect(log.lines).toContain('info:   editor for nl: anthropic:nl-editor (languages.nl.llm)');
    expect(res.doc.meta?.models?.llm).toBe('anthropic:nl-editor');
  });

  it('none: transcribes as without a detector', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers, seen } = fakes([{ words: {} }]);
    const { res } = await transcribe(await media(dir, 'tone'), dir, providers);
    expect(seen.text.every((l) => l === undefined)).toBe(true);
    expect(res.doc.meta?.languageDetection).toEqual(expect.objectContaining({ verdict: 'none' }));
    expect(res.doc.meta?.languageDetection).not.toHaveProperty('language');
  });

  it('--language: never calls the detector', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers, seen } = fakes([{ words: { nl: 60 } }]);
    const { res } = await transcribe(await media(dir, 'tone', 20), dir, providers, { language: 'en' });
    expect(seen.detect).toBe(0);
    expect(res.doc.meta).not.toHaveProperty('languageDetection');
  });

  for (const kind of ['silent', 'video-only'] as const) {
    it(`${kind}: writes an empty document without calling any provider`, async () => {
      const dir = await tempDir('overtone-detectrun-');
      const { res } = await transcribe(await media(dir, kind, 4), dir, never());
      expect(res.doc).toMatchObject({ language: 'und', turns: [], speakers: [] });
      expect(res.doc.meta?.languageDetection).toEqual({ verdict: 'silent' });
      expect(res.written.some((f) => f.endsWith('.overtone.json'))).toBe(true);
      expect(res.written.some((f) => f.endsWith('.srt'))).toBe(true);
      const json = JSON.parse(await readFile(res.written.find((f) => f.endsWith('.overtone.json'))!, 'utf8'));
      expect(json.meta.languageDetection).toEqual({ verdict: 'silent' });
      expect(res.usage).toEqual([]);
    });
  }

  it('stores the loudness, measured while the providers work', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const order: string[] = [];
    const { providers } = fakes(undefined);
    const text = providers.text.transcribe;
    providers.text = { ...providers.text, transcribe: async (a, o) => { order.push('text'); return text(a, o); } };
    const measureLoudness = async () => {
      order.push('measure start');
      await new Promise((r) => setTimeout(r, 300));
      order.push('measure end');
      return { standard: 'EBU R128 (ITU-R BS.1770)', integratedLufs: -19.5, rangeLu: 4.2, truePeakDbtp: -2.1, samplePeakDbfs: -2.4 };
    };
    const { res } = await transcribe(await media(dir, 'tone', 20), dir, providers, {}, {}, { measureLoudness });
    expect(order.indexOf('measure start')).toBeLessThan(order.indexOf('text'));
    expect(order.indexOf('text')).toBeLessThan(order.indexOf('measure end'));
    expect(res.doc.meta?.loudness).toEqual({ standard: 'EBU R128 (ITU-R BS.1770)', integratedLufs: -19.5, rangeLu: 4.2, truePeakDbtp: -2.1, samplePeakDbfs: -2.4 });
  });

  it('measures real loudness by default, and leaves it out when the measurement fails', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const real = await transcribe(await media(dir, 'tone', 20), dir, fakes(undefined).providers);
    expect(real.res.doc.meta?.loudness).toMatchObject({ standard: 'EBU R128 (ITU-R BS.1770)', integratedLufs: expect.any(Number) });
    const failed = await transcribe(await media(dir, 'tone', 20), dir, fakes(undefined).providers, {}, {}, { measureLoudness: async () => { throw new Error('ffmpeg exploded'); } });
    expect(failed.res.doc.meta).not.toHaveProperty('loudness');
    expect(failed.log.lines.filter((l) => l.startsWith('warn:') || l.startsWith('error:'))).toEqual([]);
  });

  it('stops the measurement when the run fails', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const { providers } = fakes(undefined);
    providers.text = { ...providers.text, transcribe: async () => { throw new Error('text provider down'); } };
    let aborted = false;
    const measureLoudness = (_m: string, signal?: AbortSignal) => new Promise<never>((_r, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    await expect(transcribe(await media(dir, 'tone', 20), dir, providers, {}, {}, { measureLoudness })).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it('stores the peaks of a silent file and no loudness for a file without audio', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const silent = await transcribe(await media(dir, 'silent', 4), dir, never());
    expect(silent.res.doc.meta?.loudness).toMatchObject({ standard: 'EBU R128 (ITU-R BS.1770)' });
    expect(silent.res.doc.meta?.loudness).not.toHaveProperty('integratedLufs');
    const video = await transcribe(await media(dir, 'video-only', 4), dir, never());
    expect(video.res.doc.meta).not.toHaveProperty('loudness');
  });

  it('silent with --text-file: warns that the text was not used', async () => {
    const dir = await tempDir('overtone-detectrun-');
    await writeFile(join(dir, 'script.txt'), 'Hello there.');
    const { res, log } = await transcribe(await media(dir, 'silent', 4), dir, never(), { textFile: 'script.txt' });
    expect(res.doc.turns).toEqual([]);
    expect(log.lines).toContain('warn: --text-file: the text of script.txt was not used, because the media is silent');
  });

  it('silent with --export mp4: says there are no captions to burn, and still encodes', async () => {
    const dir = await tempDir('overtone-detectrun-');
    const burned: string[] = [];
    const fakeBurn: typeof burn = async (m, _doc, o) => { burned.push(m); return o.output!; };
    const video = async () => ({ width: 64, height: 64, fps: 5, duration: 4 });
    const { res, log } = await transcribe(await media(dir, 'silent', 4), dir, never(), { export: 'json,mp4' }, {}, { burn: fakeBurn, probeVideo: video });
    expect(log.lines).toContain('info:   no captions to burn');
    expect(burned).toHaveLength(1);
    expect(res.written.some((f) => f.endsWith('.captioned.mp4'))).toBe(true);
  });
});

describe('the extract cache and the peak level', () => {
  /** Two runs with the cache on and a fake extract stage; how often it extracted. */
  async function twice(peak: Partial<ExtractResult>): Promise<number> {
    const dir = await tempDir('overtone-detectrun-');
    const file = join(dir, 'clip.mp4');
    await writeFile(file, 'not really media'); // created by the test, never committed
    const cfg = await resolveConfig({ export: 'json', llmLinebreaks: false, language: 'nl' }, {}, { cwd: dir, configDir: dir });
    let extracted = 0;
    const extractAudio = async (): Promise<ExtractResult> => {
      extracted++;
      return { duration: 4, wav: join(dir, 'audio.wav'), chunks: [{ path: join(dir, 'c0.mp3'), index: 0, start: 0, end: 4 }], ...peak };
    };
    const { providers } = fakes(undefined);
    const deps = { cwd: dir, providers, extractAudio, checkBinaries: async () => [], probeDuration: async () => 4, probeVideo: async () => undefined };
    for (let i = 0; i < 2; i++) await runPipeline(file, cfg, { ...deps, log: memoryLogger() });
    return extracted;
  }

  it('reuses an entry that has the peak level', async () => {
    expect(await twice({ maxVolume: -12 })).toBe(1);
  });

  it('extracts again for an entry written before the peak level was measured', async () => {
    expect(await twice({})).toBe(2);
  });
});
