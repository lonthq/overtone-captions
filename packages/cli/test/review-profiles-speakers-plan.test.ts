import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTranscribe, type TranscribeFlags } from '../src/commands/transcribe.js';
import { parseSpeakers, resolveConfig, type FileConfig } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import type { PipelineDeps } from '../src/pipeline.js';
import { tempDir } from './tmp.js';

const dirsOf = async () => {
  const dir = await tempDir('overtone-review-');
  return { cwd: dir, configDir: dir };
};

describe('profiles: a WxH id defined in profileRules is a name', () => {
  it('keeps profileRules."2x2" as the profile 2x2 with its rules', async () => {
    const cfg = await resolveConfig({}, { profiles: ['2x2'], profileRules: { '2x2': { aspect: '1:1', rules: { maxCharsPerLine: 10 } } } }, await dirsOf());
    expect(cfg.profiles).toHaveLength(1);
    expect(cfg.profiles[0]).toMatchObject({ id: '2x2', aspect: '1:1', rules: { maxCharsPerLine: 10 } });
  });

  it('keeps profileRules."1x1" with its own aspect', async () => {
    const cfg = await resolveConfig({}, { profiles: ['1x1'], profileRules: { '1x1': { aspect: '16:9' } } }, await dirsOf());
    expect(cfg.profiles.map((p) => [p.id, p.aspect])).toEqual([['1x1', '16:9']]);
  });

  it('reads "1x1" and "1:1" as the aspect 1:1 without profileRules; "1:1" stays an aspect next to profileRules', async () => {
    const dirs = await dirsOf();
    expect((await resolveConfig({ profiles: '1x1' }, {}, dirs)).profiles.map((p) => [p.id, p.aspect])).toEqual([['1x1', '1:1']]);
    const withRules = await resolveConfig({ profiles: '1:1' }, { profileRules: { '1x1': { rules: { maxCharsPerLine: 20 } } } }, dirs);
    expect(withRules.profiles[0]).toMatchObject({ id: '1x1', aspect: '1:1', rules: { maxCharsPerLine: 20 } });
    await expect(resolveConfig({ profiles: '1:1' }, { profileRules: { '1x1': { aspect: '16:9' } } }, dirs)).rejects.toThrow(/given as "1:1" in the profile list but profileRules\.1x1\.aspect is "16:9"/);
  });
});

describe('--speakers: ids that are Object.prototype keys', () => {
  it('keeps "__proto__" and "constructor" as own ids and finds duplicates of them', () => {
    expect(() => parseSpeakers('__proto__=Sarah,__proto__=Tom')).toThrow(new UserError('Speaker "__proto__" is given twice in --speakers ("Sarah" and "Tom"); give each speaker id once.'));
    const fromString = parseSpeakers('__proto__=Sarah,constructor=Tom');
    expect(Object.keys(fromString)).toEqual(['__proto__', 'constructor']);
    expect(fromString.__proto__).toBe('Sarah');
    const fromObject = parseSpeakers(JSON.parse('{"__proto__":"Sarah"}') as Record<string, string>, 'the config file');
    expect(Object.keys(fromObject)).toEqual(['__proto__']);
    expect(Object.hasOwn(fromObject, '__proto__')).toBe(true);
    // an id that is not given is not found on the prototype either
    expect(parseSpeakers('S1=Sarah').constructor).toBeUndefined();
  });
});

const KEYS = { OPENAI_API_KEY: 'fake-openai', AZURE_SPEECH_KEY: 'fake-speech', AZURE_SPEECH_REGION: 'fakeregion' };
const fail = (what: string) => () => { throw new Error(`dry run called ${what}`); };

async function dryRun(flags: TranscribeFlags, env: NodeJS.ProcessEnv, extra: Partial<PipelineDeps> = {}, config?: FileConfig) {
  const dir = await tempDir('overtone-review-dry-');
  await writeFile(join(dir, 'talk.mp4'), 'placeholder');
  if (config) await writeFile(join(dir, 'overtone.config.json'), JSON.stringify(config));
  const before = await readdir(dir);
  const log = memoryLogger();
  const deps: Partial<PipelineDeps> = {
    cwd: dir, env,
    checkBinaries: async () => [],
    probeDuration: async () => 600,
    probeVideo: async () => ({ width: 1920, height: 1080, fps: 25 }),
    extractAudio: fail('extractAudio'), cutAudio: fail('cutAudio'), createLlm: fail('createLlm'),
    ...extra,
  };
  const result = await runTranscribe('talk.mp4', { ...flags, dryRun: true }, log, deps).then((code) => ({ code, error: undefined }), (error: Error) => ({ code: 1, error }));
  expect(await readdir(dir)).toEqual(before);
  const out = log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5));
  const line = (key: string) => out.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);
  return { ...result, dir, line };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fail('fetch'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('--dry-run: an editor for some detected languages', () => {
  it('local providers with a cloud languages.en.llm: a conditional destination, and no $0', async () => {
    const r = await dryRun({}, {}, {}, { local: true, languages: { en: { llm: 'openai' }, de: { llm: 'openai' } } });
    expect(r.line('transcript goes to')).toBe('Ollama on this machine (localhost:11434) [local], OpenAI (api.openai.com) [cloud] (if the language is en or de)');
    expect(r.line('audio goes to')).toBe('whisper.cpp on this machine [local]');
    expect(r.line('estimated cost')).toBe('depends on the detected language: $0 with the local providers, plus the cloud editor OpenAI (api.openai.com) if the language is en or de');
  });

  it('a forced language without an entry: no conditional destination, $0', async () => {
    const r = await dryRun({ language: 'nl' }, {}, {}, { local: true, languages: { en: { llm: 'openai' } } });
    expect(r.line('transcript goes to')).toBe('Ollama on this machine (localhost:11434) [local]');
    expect(r.line('estimated cost')).toBe('$0 (local providers only)');
  });

  it('the measured default setup with a languages.nl.llm editor: the estimate says it depends on the language', async () => {
    const r = await dryRun({}, { ...KEYS, ANTHROPIC_API_KEY: 'fake-ant' }, {}, { languages: { nl: { llm: 'anthropic' } } });
    expect(r.line('transcript goes to')).toBe('OpenAI (api.openai.com) [cloud], Anthropic (api.anthropic.com) [cloud] (if the language is nl)');
    expect(r.line('estimated cost')).toMatch(/^\$0\.020–0\.026 per audio minute.*; depends on the detected language: the editor is Anthropic \(api\.anthropic\.com\) if the language is nl \(not in this estimate\)$/);
  });
});

describe('--dry-run --export mp4: the video stream', () => {
  it('no video stream (the probe ran): not runnable, with the run\'s message', async () => {
    const r = await dryRun({ export: 'mp4' }, KEYS, { probeVideo: async () => undefined });
    expect(r.line('runnable')).toBe('no');
    expect(r.error?.message).toBe(`${join(r.dir, 'talk.mp4')} has no video stream; --export mp4 needs a video.`);
  });

  it('a failed video probe: the stream is not checked, not reported as missing', async () => {
    const r = await dryRun({ export: 'mp4' }, KEYS, { probeVideo: async () => { throw new Error('ffprobe failed'); } });
    expect(r.error).toBeUndefined();
    expect(r.line('runnable')).toBe('yes');
    expect(r.line('not checked')).toMatch(/^the video stream for --export mp4, Chrome and ffmpeg 5\.0\+ for --export mp4/);
  });

  it('a video: runnable', async () => {
    const r = await dryRun({ export: 'mp4' }, KEYS);
    expect(r.code).toBe(0);
    expect(r.line('not checked')).not.toMatch(/video stream/);
  });
});
