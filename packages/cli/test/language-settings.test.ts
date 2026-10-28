import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { languageDefaultsFor, parseLanguages, resolveConfig, validateFileConfig, type CliFlags, type FileConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmProvider, LlmRequest, TextOptions, TimingOptions } from '../src/providers/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dirs = { cwd: '/tmp', configDir: '/tmp' };

describe('--language with candidate languages', () => {
  it('parses one code, auto, or a list whose first code is the main language', () => {
    expect(parseLanguages(undefined, '--language')).toEqual({});
    expect(parseLanguages('auto', '--language')).toEqual({});
    expect(parseLanguages('nl', '--language')).toEqual({ language: 'nl' });
    expect(parseLanguages('en, es', '--language')).toEqual({ language: 'en', candidates: ['en', 'es'] });
    expect(parseLanguages(['en', 'es'], 'the config file')).toEqual({ language: 'en', candidates: ['en', 'es'] });
    expect(() => parseLanguages('en,auto', '--language')).toThrow(/"auto" cannot be combined with other languages in --language/);
  });

  it('accepts a list in the config file; the flag wins', async () => {
    const file = validateFileConfig({ language: ['en', 'es'] });
    expect(await resolveConfig({}, file, dirs)).toMatchObject({ language: 'en', languageCandidates: ['en', 'es'] });
    const flagged = await resolveConfig({ language: 'nl' }, file, dirs);
    expect(flagged.language).toBe('nl');
    expect(flagged.languageCandidates).toBeUndefined();
    expect(() => validateFileConfig({ language: 3 })).toThrow(/"language" must be a string or an array of strings/);
  });
});

describe('effort and per-language defaults in overtone.config.json', () => {
  it('validates effort values and steps', () => {
    expect(() => validateFileConfig({ effort: { corrections: 'huge' } })).toThrow(/"effort.corrections" must be one of low, medium, high/);
    expect(() => validateFileConfig({ effort: { refine: 'low' } })).toThrow(/"effort.refine" must be one of the steps corrections, styling, linebreaks/);
    expect(() => validateFileConfig({ languages: { nl: { llm: 3 } } })).toThrow(/"languages.nl.llm" must be a string/);
    expect(() => validateFileConfig({ languages: { nl: { effort: { styling: 'max' } } } })).toThrow(/"languages.nl.effort.styling" must be one of/);
    expect(() => validateFileConfig({ inferContext: 'no' })).toThrow(/"inferContext" must be true or false/);
  });

  it('merges effort over the defaults and keys the language defaults by canonical code', async () => {
    const file: FileConfig = validateFileConfig({
      effort: { styling: 'medium' },
      languages: { NL: { llm: 'anthropic', effort: { corrections: 'high' } }, 'nl_be': { text: 'openai:gpt-4o-transcribe' } },
    });
    const cfg = await resolveConfig({}, file, dirs);
    expect(cfg.effort).toEqual({ corrections: 'medium', styling: 'medium', linebreaks: 'low' });
    expect(Object.keys(cfg.languageDefaults)).toEqual(['nl', 'nl-BE']);
    expect(languageDefaultsFor(cfg, 'nl-BE')?.text?.id).toBe('openai:gpt-4o-transcribe');
    expect(languageDefaultsFor(cfg, 'nl-NL')?.llm?.id).toBe('anthropic');
    expect(languageDefaultsFor(cfg, 'en')).toBeUndefined();
    await expect(resolveConfig({}, validateFileConfig({ languages: { 'not a code': {} } }), dirs)).rejects.toThrow(/Invalid language code "not a code"/);
  });

  it('records which roles were chosen with a flag, and the context inference switches', async () => {
    expect((await resolveConfig({ llm: 'openai' }, {}, dirs)).explicit).toEqual({ text: false, llm: true });
    expect((await resolveConfig({ local: true }, {}, dirs)).explicit).toEqual({ text: true, llm: true });
    expect((await resolveConfig({}, {}, dirs))).toMatchObject({ inferContext: true, twoPass: false });
    expect((await resolveConfig({ inferContext: true }, { inferContext: false }, dirs)).inferContext).toBe(false);
    expect((await resolveConfig({ inferContext: false }, {}, dirs)).inferContext).toBe(false);
    expect((await resolveConfig({ twoPass: true }, {}, dirs)).twoPass).toBe(true);
  });
});

/** Fake providers that record what each role got. */
function providers(language = 'nl') {
  const textOpts: TextOptions[] = [];
  const timingOpts: TimingOptions[] = [];
  const requests: LlmRequest[] = [];
  const answer = (name: string) => {
    if (name === 'corrections') return { edits: [], speakers: [] };
    if (name === 'styling') return { styles: [] };
    if (name === 'context') return { topic: 'Een groet.', names: [], terms: [] };
    return { cueStarts: [], lineStarts: [] };
  };
  const llm = (id: string): LlmProvider => ({ id, async complete<T>(req: LlmRequest) { requests.push({ ...req, name: `${id}/${req.name}` }); return answer(req.name) as T; } });
  const p: Providers = {
    text: { id: 'fake:text', transcribe: async (_c, o) => { textOpts.push(o); return { text: 'Hallo daar. Hoi Maya!', language }; } },
    timing: {
      id: 'fake:timing',
      align: async (_a, o) => {
        timingOpts.push(o);
        return {
          language: language === 'nl' ? 'nl-NL' : 'en-US',
          languagesHeard: { en: 0.75, es: 0.25 },
          words: [['hallo', 0.5], ['daar', 1], ['hoi', 2], ['maya', 2.4]].map(([text, start]) => ({ text: text as string, start: start as number, end: (start as number) + 0.4, speaker: 'S1' })),
        };
      },
    },
    llm: llm('base'),
  };
  return { p, textOpts, timingOpts, requests, llm };
}

async function setup(flags: CliFlags, file: FileConfig = {}) {
  const dir = await tempDir('overtone-lang-');
  const media = join(dir, 'clip.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', media]);
  const cfg = await resolveConfig({ export: 'json', context: 'Een groet.', ...flags }, validateFileConfig(file), { cwd: dir, configDir: dir });
  return { dir, media, cfg };
}

describe.skipIf(!hasFfmpeg)('pipeline: per-language defaults and candidate languages', () => {
  const LANGS = { languages: { nl: { text: 'openai:nl-transcribe', llm: 'anthropic:nl-editor', effort: { corrections: 'high' as const } } } };

  it('uses the language’s LLM and effort once the language is detected; the text provider only when given up front', async () => {
    const { dir, media, cfg } = await setup({}, LANGS);
    const f = providers('nl');
    const created: string[] = [];
    const log = memoryLogger();
    const res = await runPipeline(media, cfg, { log, cwd: dir, providers: f.p, createLlm: (sel) => { created.push(sel.id); return f.llm('nl'); } });
    expect(created).toEqual(['anthropic:nl-editor']);
    expect(f.requests.map((r) => r.name)).toEqual(['nl/corrections', 'nl/styling']);
    expect(f.requests[0]!.effort).toBe('high');
    expect(f.requests[1]!.effort).toBe('low');
    expect(res.doc.meta?.models).toEqual({ text: 'openai:gpt-transcribe', timing: 'azure-speech:fast', llm: 'anthropic:nl-editor' });
    expect(log.lines).toContain('info:   editor for nl: anthropic:nl-editor (languages.nl.llm)');
  });

  it('applies the text provider of the language given with --language, and flags win over the language', async () => {
    const given = await setup({ language: 'nl' }, LANGS);
    const res = await runPipeline(given.media, given.cfg, { log: memoryLogger(), cwd: given.dir, providers: providers('nl').p });
    expect(res.doc.meta?.models).toMatchObject({ text: 'openai:nl-transcribe', llm: 'anthropic:nl-editor' });

    const flagged = await setup({ language: 'nl', llm: 'openai:my-editor', text: 'openai:my-text' }, LANGS);
    const f = providers('nl');
    const out = await runPipeline(flagged.media, flagged.cfg, { log: memoryLogger(), cwd: flagged.dir, providers: f.p, createLlm: () => { throw new Error('not expected'); } });
    expect(out.doc.meta?.models).toMatchObject({ text: 'openai:my-text', llm: 'openai:my-editor' });
    expect(f.requests[0]!.name).toBe('base/corrections');
    expect(f.requests[0]!.effort).toBe('high'); // effort still comes from the language
  });

  it('passes candidate languages to the text and timing providers and records the languages heard', async () => {
    const { dir, media, cfg } = await setup({ language: 'en,es' });
    const f = providers('en');
    const log = memoryLogger();
    const res = await runPipeline(media, cfg, { log, cwd: dir, providers: f.p });
    expect(f.textOpts[0]).toMatchObject({ language: 'en', languages: ['en', 'es'] });
    expect(f.timingOpts[0]).toMatchObject({ language: 'en', languages: ['en', 'es'] });
    expect(res.doc.language).toBe('en');
    expect(res.doc.meta?.languagesHeard).toEqual({ en: 0.75, es: 0.25 });
    expect(log.lines).toContain('info:   languages heard: en 75%, es 25%');
    expect(log.lines).toContain('info:   language: en (--language); candidates: en, es');
  });

  it('rejects an invalid candidate', async () => {
    const { dir, media, cfg } = await setup({ language: 'en,123' });
    await expect(runPipeline(media, cfg, { log: memoryLogger(), cwd: dir, providers: providers('en').p })).rejects.toThrow(/Invalid language "123"/);
  });
});
