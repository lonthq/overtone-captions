import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from 'overtone-format';
import { afterEach, describe, expect, it } from 'vitest';
import { burnAssetsDir } from '../src/burn/assets.js';
import type { burn, BurnOptions } from '../src/burn/index.js';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { InternalError, UserError } from '../src/errors.js';
import { languageDataHash } from '../src/lang/fingerprint.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { MAX_PROMPT_CHARS, runPipeline, textPrompt } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmRequest, TextOptions, TimingOptions } from '../src/providers/types.js';
import { formatSummary } from '../src/summary.js';
import { HttpError } from '../src/util/retry.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const built = (() => {
  try {
    return existsSync(join(burnAssetsDir(), 'page.js'));
  } catch {
    return false;
  }
})();

/** Temp folders (media, outputs, .overtone cache) made by this file; removed after each test. */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(flags: CliFlags = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'overtone-pipe-'));
  dirs.push(dir);
  const cfg = await resolveConfig({ export: 'json,vtt,srt,txt', ...flags }, {}, { cwd: dir, configDir: dir });
  return { dir, cfg };
}

async function media(dir: string, seconds = 6): Promise<string> {
  const file = join(dir, 'clip.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-c:a', 'aac', file]);
  return file;
}

/** Providers that answer instantly and count their calls. */
function fakeProviders(
  opts: { failTiming?: boolean; text?: { text: string; language?: string }; edits?: unknown[] } = {},
): Providers & { calls: string[]; textOpts: TextOptions[]; timingOpts: TimingOptions[]; requests: LlmRequest[] } {
  const calls: string[] = [];
  const textOpts: TextOptions[] = [];
  const timingOpts: TimingOptions[] = [];
  const requests: LlmRequest[] = [];
  return {
    calls,
    textOpts,
    timingOpts,
    requests,
    text: { id: 'fake:text', transcribe: async (_chunk, o) => { calls.push('text'); textOpts.push(o); return opts.text ?? { text: 'Hello there. Hi Maya!', language: 'en' }; } },
    timing: {
      id: 'fake:timing',
      align: async (_audio, o) => {
        calls.push('timing');
        timingOpts.push(o);
        if (opts.failTiming) throw new Error('boom');
        if (opts.text) {
          // timing words that follow the given text, 0.4 s each
          const words = opts.text.text.split(/\s+/).filter(Boolean).map((t, i) => ({ text: t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(), start: 0.2 + i * 0.4, end: 0.5 + i * 0.4, speaker: 'S1' }));
          return { words };
        }
        return {
          language: 'en-US',
          words: [
            { text: 'hello', start: 0.5, end: 0.9, speaker: 'S1' },
            { text: 'there', start: 1.0, end: 1.4, speaker: 'S1' },
            { text: 'hi', start: 2.0, end: 2.3, speaker: 'S2' },
            { text: 'maya', start: 2.4, end: 2.9, speaker: 'S2' },
          ],
        };
      },
    },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        calls.push(req.name);
        requests.push(req);
        if (req.name === 'corrections') return { edits: opts.edits ?? [], speakers: [{ id: 'S1', label: 'Host', role: 'host' }, { id: 'S2', label: 'Maya', role: '' }] } as T;
        if (req.name === 'context') return { topic: 'A short greeting between a host and Maya.', names: ['Maya'], terms: [] } as T;
        if (req.name === 'styling') return { styles: [{ first: 3, last: 3, classes: ['brand'] }] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
}

describe('textPrompt', () => {
  it('combines context, glossary, style and the previous chunk tail', async () => {
    const { cfg } = await setup({ context: 'An ad.', numbers: 'digits', currency: 'symbol' });
    cfg.glossary = ['DriveCover'];
    expect(textPrompt(cfg, 'x'.repeat(400) + 'END')).toBe(
      `An ad.\nNames and terms: DriveCover.\nNumbers are written as digits.\nAmounts use currency symbols, e.g. €12.\n${'x'.repeat(297)}END`,
    );
    const { cfg: empty } = await setup();
    expect(textPrompt(empty)).toBeUndefined();
  });
});

describe('textPrompt length', () => {
  const terms = Array.from({ length: 400 }, (_, i) => `Term${i}`);
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  it('caps the glossary at about 1000 characters with whole terms only, and mentions it once', async () => {
    const { cfg } = await setup();
    cfg.glossary = terms;
    const prompt = textPrompt(cfg)!;
    expect(prompt.length).toBeLessThanOrEqual(1100);
    expect(count(prompt, 'Names and terms:')).toBe(1);
    expect(count(prompt, 'Term0')).toBe(1);
    const listed = prompt.replace(/^Names and terms: /, '').replace(/\.$/, '').split(', ');
    expect(listed.length).toBeGreaterThan(50);
    expect(listed.length).toBeLessThan(terms.length);
    expect(listed).toEqual(terms.slice(0, listed.length));
  });

  it('keeps the whole prompt within MAX_PROMPT_CHARS: context shrinks first, then the glossary, the tail stays', async () => {
    const { cfg } = await setup({ context: 'C'.repeat(5000), numbers: 'digits' });
    cfg.glossary = terms;
    const tail = 'x'.repeat(290) + 'END';
    const prompt = textPrompt(cfg, tail)!;
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt.endsWith(tail)).toBe(true);
    expect(prompt).toContain('Names and terms: Term0, Term1,');
    expect(prompt).toContain('Numbers are written as digits.');
    // the glossary kept its full ~1000 characters; only the context gave way
    expect(prompt.split('\n')[1]!.length).toBeGreaterThan(900);
    expect(prompt.split('\n')[0]).toMatch(/^C+$/);
  });

  it('shrinks the glossary too when the context alone cannot make room, and never exceeds the cap', async () => {
    const { cfg } = await setup({ context: 'C'.repeat(5000), styleGuide: 'G'.repeat(900) });
    cfg.glossary = terms;
    for (const tail of [undefined, 'y'.repeat(300)]) {
      const prompt = textPrompt(cfg, tail)!;
      expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
      if (tail) expect(prompt.endsWith(tail)).toBe(true);
    }
  });

  it('leaves short prompts untouched', async () => {
    const { cfg } = await setup({ context: 'An ad.' });
    cfg.glossary = ['DriveCover'];
    expect(textPrompt(cfg, 'Earlier.')).toBe('An ad.\nNames and terms: DriveCover.\nEarlier.');
  });
});

describe('textPrompt with a style guide', () => {
  it('adds the free-text style rules after the number and currency rules, before the previous chunk', async () => {
    const { cfg } = await setup({ numbers: 'digits', styleGuide: 'Write "e-mail" with a hyphen.' });
    expect(textPrompt(cfg, 'Earlier text.')).toBe('Numbers are written as digits.\nWrite "e-mail" with a hyphen.\nEarlier text.');
  });
});

describe.skipIf(!hasFfmpeg)('style guide in the pipeline', () => {
  it('reaches the text provider prompt', async () => {
    const { dir, cfg } = await setup({ styleGuide: 'Write "e-mail" with a hyphen.' });
    const providers = fakeProviders();
    await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.textOpts[0].prompt).toBe('Write "e-mail" with a hyphen.');
  });
});

describe('formatSummary', () => {
  it('formats the spec summary line', () => {
    const words = [...Array(290).fill({ match: 'exact' }), ...Array(18).fill({ match: 'fuzzy' }), ...Array(4).fill({ match: 'interpolated' })];
    expect(formatSummary({ words, edits: 6, rejected: 1, speakers: 2, profiles: [{ id: 'h', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: Array(48) }, { id: 'v', aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2 }, cues: Array(71) }] })).toBe(
      '312 words: 290 exact, 18 fuzzy, 4 interpolated · 6 edits, 1 rejected · 2 speakers · 48/71 cues',
    );
    expect(formatSummary({ words: [], edits: 1, rejected: 1, speakers: 2, profiles: [{ id: 'h', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [] }] })).toBe('0 words · 1 edit, 1 rejected · 2 speakers · 0 cues');
    expect(formatSummary({ words: [], edits: 1, rejected: 0, speakers: 1, profiles: [] })).toBe('0 words · 1 edit · 1 speaker ·  cues');
    expect(formatSummary({ words: [], edits: 3, rejected: 0, review: 2, speakers: 1, profiles: [] })).toBe('0 words · 3 edits · 2 to review · 1 speaker ·  cues');
  });
});

describe('preflight', () => {
  it('reports missing keys for the selected providers before any API call', async () => {
    const { dir, cfg } = await setup({ llm: 'anthropic' });
    const file = join(dir, 'x.wav');
    await writeFile(file, 'x');
    // AZURE_SPEECH_KEY is set: it is not listed, and its value never appears in the message
    const env = { AZURE_SPEECH_KEY: 'sk-secret-value-123' };
    const err = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, env, checkBinaries: async () => [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe([
      'Missing environment variables for the selected providers:',
      '  OPENAI_API_KEY (openai)',
      '  AZURE_SPEECH_REGION (azure-speech)',
      '  ANTHROPIC_API_KEY (anthropic)',
      'Set them in .env or your environment; .env.example lists them all (https://github.com/lonthq/overtone-captions/blob/main/.env.example).',
      'No keys? Use --local to run free and offline with whisper.cpp and Ollama.',
    ].join('\n'));
    expect((err as Error).message).not.toContain('sk-secret-value-123');
  });

  it('says so when the media path is a directory', async () => {
    const { dir, cfg } = await setup();
    await expect(runPipeline(dir, cfg, { log: memoryLogger(), cwd: dir, env: {} })).rejects.toThrow(`Media file is a directory: ${dir}`);
  });

  it('rejects an invalid --language before anything else runs', async () => {
    const { dir, cfg } = await setup({ language: 'klingon' });
    const file = join(dir, 'x.wav');
    await writeFile(file, 'x');
    let checked = false;
    const providers = fakeProviders();
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers, checkBinaries: async () => { checked = true; return []; } }))
      .rejects.toThrow('Invalid language "klingon"; expected a code such as en, nl or nl-BE, a name such as dutch, or "auto".');
    expect(checked).toBe(false);
    expect(providers.calls).toEqual([]);
    expect(existsSync(cfg.cacheDir)).toBe(false);
  });

  it('reports a missing ffmpeg and a missing media file', async () => {
    const { dir, cfg } = await setup();
    await expect(runPipeline(join(dir, 'nope.mp4'), cfg, { log: memoryLogger(), cwd: dir, env: {} })).rejects.toThrow(/Media file not found/);
    const file = join(dir, 'x.wav');
    await writeFile(file, 'x');
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, env: {}, checkBinaries: async () => ['ffmpeg', 'ffprobe'] })).rejects.toThrow(
      'ffmpeg and ffprobe not found on PATH',
    );
  });
});

describe('duration limit', () => {
  it('rejects media over 2 hours from ffprobe on the input, before extracting or calling a provider', async () => {
    const { dir, cfg } = await setup();
    const file = join(dir, 'long.mp4');
    await writeFile(file, 'x');
    const providers = fakeProviders();
    const probed: string[] = [];
    const err = await runPipeline(file, cfg, {
      log: memoryLogger(), cwd: dir, providers, checkBinaries: async () => [],
      probeDuration: async (p) => { probed.push(p); return 10 * 3600; },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('Media is 10:00:00 long; v1 supports up to 2:00:00.');
    expect(probed).toEqual([file]);
    expect(existsSync(cfg.cacheDir)).toBe(false);
    expect(providers.calls).toEqual([]);
  });

  it('prints the length as h:mm:ss', async () => {
    const { dir, cfg } = await setup();
    const file = join(dir, 'long.mp4');
    await writeFile(file, 'x');
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), checkBinaries: async () => [], probeDuration: async () => 7300.4 }))
      .rejects.toThrow('Media is 2:01:40 long; v1 supports up to 2:00:00.');
  });

  it('runs the keys check before probing', async () => {
    const { dir, cfg } = await setup();
    const file = join(dir, 'long.mp4');
    await writeFile(file, 'x');
    let probed = false;
    await expect(runPipeline(file, cfg, {
      log: memoryLogger(), cwd: dir, env: {}, checkBinaries: async () => [],
      probeDuration: async () => { probed = true; return 1; },
    })).rejects.toThrow(/^Missing environment variables/);
    expect(probed).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('non-media input', () => {
  it.each([['bogus.mp4', 'x\n'], ['empty.mp4', '']])('%s fails in preflight with one line and no cache folder', async (name, content) => {
    const { dir, cfg } = await setup();
    const file = join(dir, name);
    await writeFile(file, content);
    const providers = fakeProviders();
    const err = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/^Cannot read .*: not an audio\/video file \(.+\)$/);
    expect((err as Error).message).not.toMatch(/run the same command again/);
    expect(existsSync(cfg.cacheDir)).toBe(false);
    expect(providers.calls).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)('runPipeline (ffmpeg, fake providers)', () => {
  it('runs every stage, writes the files and prints a summary', async () => {
    const { dir, cfg } = await setup({ context: 'A greeting.' });
    const providers = fakeProviders();
    const log = memoryLogger();
    const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers, now: () => new Date('2026-10-07T09:00:00Z') });
    expect(res.written.map((p) => p.slice(dir.length + 1))).toEqual([
      'clip.overtone.json', 'clip.horizontal.vtt', 'clip.horizontal.srt', 'clip.vertical.vtt', 'clip.vertical.srt', 'clip.txt',
    ]);
    const json = JSON.parse(await readFile(join(dir, 'clip.overtone.json'), 'utf8'));
    expect(validate(json).valid).toBe(true);
    expect(json.meta).toEqual({
      context: 'A greeting.',
      contextSource: 'user',
      style: { numbers: 'auto', currency: 'auto' },
      // the default since rule set 1: captions and lines cut by the rules alone
      linebreaks: 'rules',
      rules: '1',
      languageData: languageDataHash('en'),
      models: { text: 'openai:gpt-transcribe', timing: 'azure-speech:fast', llm: 'openai:gpt-6.1-sol' },
      generator: expect.stringMatching(/^overtone-captions@\d+\.\d+\.\d+/),
      createdAt: '2026-10-07T09:00:00.000Z',
    });
    expect(json.language).toBe('en');
    expect(json.speakers).toEqual([{ id: 'S1', label: 'Host', role: 'host' }, { id: 'S2', label: 'Maya' }]);
    expect(json.turns.map((t: { words: Array<{ text: string }> }) => t.words.map((w) => w.text).join(' '))).toEqual(['Hello there.', 'Hi Maya!']);
    expect(res.summary).toBe('4 words: 4 exact · 0 edits · 2 speakers · 2/2 cues');
    expect(log.lines.filter((l) => l.startsWith('info: [')).map((l) => l.replace(/ in [\d.]+ s$/, ''))).toEqual([
      'info: [1/6] extract …', 'info: [1/6] extract: done',
      'info: [2/6] transcribe …', 'info: [2/6] transcribe: done',
      'info: [3/6] timing …', 'info: [3/6] timing: done',
      'info: [4/6] align …', 'info: [4/6] align: done',
      'info: [5/6] refine …', 'info: [5/6] refine: done',
      'info: [6/6] export …',
    ]);
    expect(providers.calls).toEqual(['text', 'timing', 'corrections', 'styling']);
  });

  describe('media profile', () => {
    const shaped = (width: number, height: number) => async () => ({ width, height, fps: 25, duration: 18 });
    const ids = (res: Awaited<ReturnType<typeof runPipeline>>) => res.doc.profiles.map((p) => p.id);
    const noMediaLine = (log: { lines: string[] }) => expect(log.lines.filter((l) => l.includes('media is'))).toEqual([]);

    it('adds the profile of a square video', async () => {
      const { dir, cfg } = await setup();
      const log = memoryLogger();
      const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers: fakeProviders(), probeVideo: shaped(1080, 1080) });
      expect(res.doc.profiles.map((p) => [p.id, p.aspect])).toEqual([['horizontal', '16:9'], ['vertical', '9:16'], ['1x1', '1:1']]);
      expect(log.lines).toContain('info:   media is 1:1: adding profile 1x1 (32 characters per line)');
    });

    it('keeps the configured profiles when they are explicit', async () => {
      const { dir, cfg } = await setup();
      const log = memoryLogger();
      const res = await runPipeline(await media(dir), { ...cfg, profilesExplicit: true }, { log, cwd: dir, providers: fakeProviders(), probeVideo: shaped(1080, 1080) });
      expect(ids(res)).toEqual(['horizontal', 'vertical']);
      noMediaLine(log);
    });

    it('adds nothing for a 16:9 video', async () => {
      const { dir, cfg } = await setup();
      const log = memoryLogger();
      const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers: fakeProviders(), probeVideo: shaped(1920, 1080) });
      expect(ids(res)).toEqual(['horizontal', 'vertical']);
      noMediaLine(log);
    });

    it('adds nothing for audio-only media', async () => {
      const { dir, cfg } = await setup();
      const log = memoryLogger();
      const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers: fakeProviders(), probeVideo: async () => undefined });
      expect(ids(res)).toEqual(['horizontal', 'vertical']);
      noMediaLine(log);
    });

    it('carries on with the configured profiles when the video probe fails, and logs why in debug mode', async () => {
      const { dir, cfg } = await setup();
      const log = memoryLogger({ debug: true });
      const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers: fakeProviders(), probeVideo: async () => { throw new Error('ffprobe exploded'); } });
      expect(ids(res)).toEqual(['horizontal', 'vertical']);
      expect(log.lines.filter((l) => l.startsWith('debug: video probe failed'))).toEqual(['debug: video probe failed: ffprobe exploded']);
      noMediaLine(log);
    });
  });

  describe('--export mp4', () => {
    const video = async () => ({ width: 1920, height: 1080, fps: 25, duration: 18 });
    const burned: Array<{ media: string; opts: BurnOptions }> = [];
    const fakeBurn: typeof burn = async (m, _doc, o) => {
      burned.push({ media: m, opts: o });
      return o.output!;
    };
    const noCalls = (p: ReturnType<typeof fakeProviders>) => expect(p.calls).toEqual([]);

    it('writes the captioned video as the only output, and passes the burn options', async () => {
      burned.length = 0;
      const { dir, cfg } = await setup({ export: 'mp4', burnStyle: 'social', burnSpeakerNames: 'always' });
      const file = await media(dir);
      const res = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), probeVideo: video, burn: fakeBurn });
      expect(res.written).toEqual([join(dir, 'clip.captioned.mp4')]);
      expect(burned).toHaveLength(1);
      expect(burned[0].media).toBe(file);
      expect(burned[0].opts).toEqual({ cwd: dir, style: 'social', speakerNames: 'always', output: join(dir, 'clip.captioned.mp4') });
      expect(await readdir(dir)).not.toContain('clip.overtone.json');
    });

    it('writes the other formats too, into --out', async () => {
      burned.length = 0;
      const { dir, cfg } = await setup({ export: 'json,mp4', out: 'out' });
      const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), probeVideo: video, burn: fakeBurn });
      expect(res.written).toEqual([join(dir, 'out', 'clip.overtone.json'), join(dir, 'out', 'clip.captioned.mp4')]);
      expect(burned[0].opts.output).toBe(join(dir, 'out', 'clip.captioned.mp4'));
    });

    it('stops before any provider call for audio without a video stream', async () => {
      const { dir, cfg } = await setup({ export: 'mp4' });
      const providers = fakeProviders();
      const file = await media(dir);
      await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers, probeVideo: async () => undefined, burn: fakeBurn }))
        .rejects.toThrow(new UserError(`${file} has no video stream; --export mp4 needs a video.`));
      noCalls(providers);
    });

    it('rethrows a failing video probe as a user error, before any provider call', async () => {
      const { dir, cfg } = await setup({ export: 'mp4' });
      const providers = fakeProviders();
      const file = await media(dir);
      await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers, probeVideo: async () => { throw new Error('boom'); }, burn: fakeBurn }))
        .rejects.toThrow(new UserError(`Cannot read ${file} as a video for --export mp4 (boom).`));
      noCalls(providers);
    });

    // unbuilt checkout: the built-in styles ship in dist/burn (npm run build)
    it.skipIf(!built)('checks the style before any provider call', async () => {
      const { dir, cfg } = await setup({ export: 'mp4', burnStyle: 'nope' });
      const providers = fakeProviders();
      await expect(runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers, probeVideo: video, burn: fakeBurn }))
        .rejects.toThrow(/^Unknown style "nope"/);
      noCalls(providers);
    });

    it('checks the ffmpeg version before any provider call', async () => {
      const { dir, cfg } = await setup({ export: 'mp4' });
      const providers = fakeProviders();
      const ffmpegVersion = async () => 'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021';
      await expect(runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers, probeVideo: video, burn: fakeBurn, ffmpegVersion }))
        .rejects.toThrow(/^Burning needs ffmpeg 5\.0 or later/);
      noCalls(providers);
    });

    it('names the files already written when the burn fails', async () => {
      const { dir, cfg } = await setup({ export: 'json,mp4' });
      const failing: typeof burn = async () => { throw new UserError('Could not start Chrome (x): boom.'); };
      await expect(runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), probeVideo: video, burn: failing }))
        .rejects.toThrow(new UserError(`Could not start Chrome (x): boom.\nWritten before the MP4 failed: ${join(dir, 'clip.overtone.json')}`));
    });

    it('checks the font file before any provider call', async () => {
      const { dir, cfg } = await setup({ export: 'mp4', burnFont: 'missing.woff2' });
      const providers = fakeProviders();
      await expect(runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers, probeVideo: video, burn: fakeBurn })).rejects.toBeInstanceOf(UserError);
      noCalls(providers);
    });
  });

  it('reuses the cache and re-runs from a stage', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    const providers = fakeProviders();
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers });
    providers.calls.length = 0;
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers });
    expect(providers.calls).toEqual([]);
    expect(log.lines).toContain('info: [1/6] extract: cached');
    // the stages run again, every provider request is answered from the cache
    expect(log.lines.filter((l) => / provider requests? from the cache\)$/.test(l)).map((l) => l.split(':')[1])).toEqual([' [2/6] transcribe', ' [3/6] timing', ' [5/6] refine']);

    await runPipeline(file, { ...cfg, fromStage: 'refine' }, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.calls).toEqual(['corrections', 'styling']);
    // the inferred context is part of the timing stage: --from-stage timing infers it again
    providers.calls.length = 0;
    await runPipeline(file, { ...cfg, fromStage: 'timing' }, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.calls).toEqual(['timing', 'context', 'corrections', 'styling']);
  });

  it('says on failure with --no-cache that finished requests were still cached', async () => {
    const { dir, cfg } = await setup({ cache: false });
    const file = await media(dir);
    const failing = fakeProviders({ failTiming: true });
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failing })).rejects.toThrow(
      /^Stage "timing" failed: boom\nWith --no-cache the cached answers were ignored, but the finished provider requests were still cached in .+; run the command again without --no-cache to continue from them\.$/,
    );
  });

  it('stops on a failing stage with a clear message and resumes from the cache', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    const failing = fakeProviders({ failTiming: true });
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failing })).rejects.toThrow(/^Stage "timing" failed: boom\nFinished provider requests are cached in /);
    const providers = fakeProviders();
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers });
    expect(log.lines.some((l) => /^info: \[2\/6\] transcribe: done in [\d.]+ s \(its provider request from the cache\)$/.test(l))).toBe(true);
    expect(providers.calls[0]).toBe('timing');
  });

  it('re-extracts when cached audio files are gone', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders() });
    const hashDir = join(cfg.cacheDir, (await readdir(cfg.cacheDir))[0]);
    await rm(join(hashDir, 'audio.wav'));
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers: fakeProviders() });
    expect(log.lines).toContain('info: [1/6] extract …');
    expect(existsSync(join(hashDir, 'audio.wav'))).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)('language hand-off to the timing stage', () => {
  const DUTCH = 'Dit is een test van de nieuwe app en het werkt echt goed, maar we hebben nog niet alles gezien.';

  it('detects Dutch from the text when nobody names a language', async () => {
    const { dir, cfg } = await setup();
    const providers = fakeProviders({ text: { text: DUTCH } });
    const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.timingOpts[0].language).toBe('nl');
    expect(res.doc.language).toBe('nl');
  });

  it('--language wins over the text provider and the heuristic', async () => {
    const { dir, cfg } = await setup({ language: 'de' });
    const providers = fakeProviders({ text: { text: DUTCH, language: 'en' } });
    const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.timingOpts[0].language).toBe('de');
    expect(res.doc.language).toBe('de');
  });

  it('maps a language name given to --language to its code', async () => {
    const { dir, cfg } = await setup({ language: 'Dutch' });
    const providers = fakeProviders({ text: { text: DUTCH, language: 'en' } });
    const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.textOpts[0].language).toBe('nl');
    expect(providers.timingOpts[0].language).toBe('nl');
    expect(res.doc.language).toBe('nl');
  });

  it("the text provider's language wins over the heuristic", async () => {
    const { dir, cfg } = await setup();
    const providers = fakeProviders({ text: { text: DUTCH, language: 'nl-BE' } });
    const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.timingOpts[0].language).toBe('nl');
    const other = fakeProviders({ text: { text: DUTCH, language: 'english' } });
    const { dir: dir2, cfg: cfg2 } = await setup();
    await runPipeline(await media(dir2), cfg2, { log: memoryLogger(), cwd: dir2, providers: other });
    expect(other.timingOpts[0].language).toBe('en');
    expect(res.doc.language).toBe('nl');
  });

  it('omits the language when nothing names one and the text is inconclusive', async () => {
    const { dir, cfg } = await setup();
    const providers = fakeProviders({ text: { text: 'CarCover DriveCover 2026.' } });
    const res = await runPipeline(await media(dir), cfg, { log: memoryLogger(), cwd: dir, providers });
    expect(providers.timingOpts[0].language).toBeUndefined();
    expect(res.doc.language).toBe('und');
  });
});

describe.skipIf(!hasFfmpeg)('request cache keys', () => {
  /** Remove the cached answers of one role (`text`, `timing`, `llm`). */
  const forget = async (hashDir: string, role: string) => {
    for (const f of await readdir(join(hashDir, 'requests'))) if (f.startsWith(`${role}-`)) await rm(join(hashDir, 'requests', f));
  };

  it('a new generator version extracts again but sends no request again (the audio is the same)', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), generator: 'overtone-captions@0.0.1' });
    const providers = fakeProviders();
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers, generator: 'overtone-captions@0.0.2' });
    expect(log.lines).toContain('info: [1/6] extract …');
    expect(providers.calls).toEqual([]);
    expect(res.doc.meta?.generator).toBe('overtone-captions@0.0.2');
  });

  it('a different answer upstream re-sends only the requests it changes', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders() });
    const hashDir = join(cfg.cacheDir, (await readdir(cfg.cacheDir))[0]);

    // the same text again: every later request is the same, so it comes from the cache
    await forget(hashDir, 'text');
    const same = fakeProviders();
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: same });
    expect(same.calls).toEqual(['text']);

    // a different text: the LLM requests that hold it are sent again; the timing request (same audio and language) is not.
    // "Mia!" where the timing provider heard "Maya!" is a disagreement: the text vote re-listens its snippet and asks
    // the chooser
    await forget(hashDir, 'text');
    const changed = fakeProviders({ text: { text: 'Hello there. Hi Mia!', language: 'en' } });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: changed });
    expect(changed.calls).toEqual(['text', 'context', 'text', 'choose', 'corrections', 'styling']);
    expect(log.lines.some((l) => /^info: \[3\/6\] timing: done in [\d.]+ s \(its provider request from the cache\)$/.test(l))).toBe(true);
    expect(res.doc.turns.flatMap((t) => t.words.map((w) => w.text))).toContain('Mia!');
  });

  it('never write environment variables or API keys into .overtone', async () => {
    const { dir, cfg } = await setup();
    expect(cfg.cacheDir).toBe(join(dir, '.overtone'));
    const file = await media(dir);
    const secrets = { OPENAI_API_KEY: 'sk-proj-FAKEKEY-0123456789abcdef', AZURE_SPEECH_KEY: 'azFAKEKEY9876543210fedcba', AZURE_SPEECH_REGION: 'westeurope' };
    const fakeOpenAI = () => ({
      audio: { transcriptions: { create: async () => ({ text: 'Hello there. Hi Maya!', languages: [{ code: 'en' }] }) } },
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const name = (params.response_format as { json_schema: { name: string } }).json_schema.name;
            const body = name === 'corrections' ? { edits: [], speakers: [] } : name === 'styling' ? { styles: [] } : { cueStarts: [], lineStarts: [] };
            return { choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }] };
          },
        },
      },
    });
    const azure = {
      phrases: [
        { speaker: 0, offsetMilliseconds: 500, durationMilliseconds: 900, text: 'Hello there.', locale: 'en-US', words: [
          { text: 'Hello', offsetMilliseconds: 500, durationMilliseconds: 400 }, { text: 'there.', offsetMilliseconds: 1000, durationMilliseconds: 400 }] },
        { speaker: 1, offsetMilliseconds: 2000, durationMilliseconds: 900, text: 'Hi Maya!', locale: 'en-US', words: [
          { text: 'Hi', offsetMilliseconds: 2000, durationMilliseconds: 300 }, { text: 'Maya!', offsetMilliseconds: 2400, durationMilliseconds: 500 }] },
      ],
    };
    const res = await runPipeline(file, cfg, {
      log: memoryLogger(),
      cwd: dir,
      env: { ...secrets },
      checkBinaries: async () => [],
      providerDeps: { openai: fakeOpenAI, fetch: async () => new Response(JSON.stringify(azure), { status: 200, headers: { 'content-type': 'application/json' } }) },
    });
    expect(res.summary).toMatch(/^4 words/);
    const files = (await readdir(cfg.cacheDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = await readFile(join(f.parentPath, f.name), 'latin1');
      for (const value of Object.values(secrets)) expect(content.includes(value), `${f.name} contains ${value}`).toBe(false);
    }
  });
});

describe.skipIf(!hasFfmpeg)('context and glossary reach refine and the edit guards', () => {
  const MAJA = { text: 'Hello there. Hi Maja!', language: 'en' };
  const RENAME = [{ first: 3, last: 3, to: 'Maya!', reason: 'brand', sure: true, note: '' }];

  async function runWith(flags: CliFlags, glossary: string[]) {
    const { dir, cfg } = await setup(flags);
    cfg.glossary = glossary;
    const providers = fakeProviders({ text: MAJA, edits: RENAME });
    const log = memoryLogger();
    const res = await runPipeline(await media(dir), cfg, { log, cwd: dir, providers });
    return { res, providers, log, words: res.doc.turns.flatMap((t) => t.words.map((w) => w.text)) };
  }

  it('puts the context and glossary in every LLM prompt', async () => {
    const { providers } = await runWith({ context: 'A greeting for Maya.', llmLinebreaks: true }, ['DriveCover']);
    // styling and the line cutting of each profile run concurrently, so their order varies: check each by name
    const names = ['corrections', 'styling', 'linebreaks-horizontal', 'linebreaks-vertical'];
    expect(providers.requests.map((r) => r.name).sort()).toEqual([...names].sort());
    for (const name of names) {
      const r = providers.requests.find((q) => q.name === name)!;
      expect(r.system + r.user, name).toContain('A greeting for Maya.');
      expect(r.system + r.user, name).toContain('DriveCover');
    }
  });

  it('applies the editor\'s name change, and shows an inferred topic and names to the editor', async () => {
    const viaContext = await runWith({ context: 'A greeting for Maya.' }, []);
    expect(viaContext.words).toContain('Maya!');
    expect(viaContext.res.doc.edits).toHaveLength(1);

    const viaInferred = await runWith({}, []);
    expect(viaInferred.words).toContain('Maya!');
    expect(viaInferred.res.doc.meta).toMatchObject({ context: 'A short greeting between a host and Maya.', contextSource: 'inferred' });
    expect(viaInferred.providers.requests.find((r) => r.name === 'corrections')!.system).toContain('(inferred from the transcript, not verified): Maya');
    expect(viaInferred.log.lines).toContain('info:   context (inferred): A short greeting between a host and Maya.');
  });
});

describe.skipIf(!hasFfmpeg)('extract cache safety', () => {
  it('re-extracts when a cached audio file was truncated (stale extract.json)', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders() });
    const hashDir = join(cfg.cacheDir, (await readdir(cfg.cacheDir))[0]);
    const full = (await stat(join(hashDir, 'audio.wav'))).size;
    await writeFile(join(hashDir, 'audio.wav'), (await readFile(join(hashDir, 'audio.wav'))).subarray(0, 4096));
    const providers = fakeProviders();
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers });
    expect(log.lines).toContain('info: [1/6] extract …');
    expect((await stat(join(hashDir, 'audio.wav'))).size).toBe(full);
    expect(providers.calls).toEqual([]); // same audio again: everything after extract stays cached
  });

  it('names what to check for a refused key, does not suggest a re-run for a client error, keeps a bug\'s stack', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    const failWith = (err: Error) => ({ ...fakeProviders(), timing: { id: 'fake:timing', align: async () => { throw err; } } });
    const refused = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failWith(new HttpError(401, 'HTTP 401: invalid subscription key')) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UserError);
    expect((refused as Error).message).toMatch(/^Stage "timing" failed: the provider refused the request \(HTTP 401\): HTTP 401: invalid subscription key\nCheck its API key and endpoint/);
    const client = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failWith(new HttpError(404, 'HTTP 404: no such model')) }).catch((e: unknown) => e);
    expect(client).toBeInstanceOf(UserError);
    expect((client as Error).message).toBe('Stage "timing" failed: HTTP 404: no such model');
    const transient = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failWith(new HttpError(503, 'HTTP 503: busy')) }).catch((e: unknown) => e);
    expect((transient as Error).message).toMatch(/^Stage "timing" failed: HTTP 503: busy\nFinished provider requests are cached in .*run the same command again/);
    const bug = new TypeError("Cannot read properties of undefined (reading 'words')");
    const log = memoryLogger();
    await expect(runPipeline(file, cfg, { log, cwd: dir, providers: failWith(bug) })).rejects.toBe(bug);
    expect(log.lines).toContain('error: Stage "timing" failed with an internal error; please report it with the stack trace below.');
    const invariant = new InternalError('alignment traceback failed at (3, 4)');
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: failWith(invariant) })).rejects.toBe(invariant);
  });

  it('drops extract.json before re-extracting, so an interrupted extraction is never trusted', async () => {
    const { dir, cfg } = await setup();
    const file = await media(dir);
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders() });
    const hashDir = join(cfg.cacheDir, (await readdir(cfg.cacheDir))[0]);
    const interrupted = async () => { throw new Error('interrupted'); };
    await expect(runPipeline(file, { ...cfg, useCache: false }, { log: memoryLogger(), cwd: dir, providers: fakeProviders(), extractAudio: interrupted }))
      .rejects.toThrow(/^Stage "extract" failed: interrupted/);
    expect(existsSync(join(hashDir, 'extract.json'))).toBe(false);
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers: fakeProviders() });
    expect(log.lines).toContain('info: [1/6] extract …');
  });
});

describe.skipIf(!hasFfmpeg)('a failed --no-cache run', () => {
  it('still caches its finished requests, and a run without --no-cache continues from them', async () => {
    const { dir, cfg } = await setup({ cache: false });
    const file = await media(dir);
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: fakeProviders({ failTiming: true }) })).rejects.toThrow(/without --no-cache to continue/);
    const providers = fakeProviders();
    const log = memoryLogger();
    await runPipeline(file, { ...cfg, useCache: true }, { log, cwd: dir, providers });
    expect(log.lines.some((l) => /^info: \[2\/6\] transcribe: done in [\d.]+ s \(its provider request from the cache\)$/.test(l))).toBe(true);
    expect(providers.calls[0]).toBe('timing');
  });
});
