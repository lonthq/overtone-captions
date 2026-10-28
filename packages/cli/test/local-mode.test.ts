import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertValid } from 'overtone-format';
import { afterEach, describe, expect, it } from 'vitest';
import { runTranscribe } from '../src/commands/transcribe.js';
import { parseModelSpec } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { OllamaLlmProvider, ollamaHost, ollamaProvider } from '../src/providers/ollama.js';
import { jsonContent } from '../src/providers/json-answer.js';
import { createProvider, resolveSelection } from '../src/providers/registry.js';
import {
  DEFAULT_MODEL_DIR,
  INSTALL_HINT,
  WhisperCppProvider,
  findExecutable,
  mapWhisperJson,
  missingModelMessage,
  modelUrl,
  promptTail,
  resolveModelFile,
  whisperCppProvider,
  type WhisperJson,
} from '../src/providers/whisper-cpp.js';
import { tempDir } from './tmp.js';

const FIXTURES = join(import.meta.dirname, 'conformance/fixtures');
const sample = async () => JSON.parse(await readFile(join(FIXTURES, 'whisper-cpp/sample-base.ojf.json'), 'utf8')) as WhisperJson;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

afterEach(() => {
  process.exitCode = 0;
});

describe('mapWhisperJson (a real whisper-cli 1.9.5 -ojf output, ggml-base)', () => {
  it('joins sub-word tokens, drops special tokens, and keeps punctuation out of the word end', async () => {
    const { words, text, language } = mapWhisperJson(await sample());
    expect(language).toBe('en');
    expect(words).toHaveLength(46);
    expect(text.startsWith('Every year, one in five drivers has some kind of car damage. With drive cover from Lumora, you\'re insured')).toBe(true);
    expect(text).not.toMatch(/\[_/);
    const by = (t: string) => words.find((w) => w.text === t)!;
    // " Lum" + "ora" + "," → one word, from the first token's start to the end of "ora" (not of the comma)
    expect(by('Lumora,')).toMatchObject({ start: 6.14, end: 6.34, speaker: 'S1' });
    expect(by("you're")).toMatchObject({ start: 6.47, end: 6.78 });
    // "damage" ends at 3.93 s; the "." token runs on to 4.8 s through the pause
    expect(by('damage.')).toMatchObject({ start: 3.45, end: 3.93 });
    // a zero-length token gets 10 ms
    expect(by('Every')).toMatchObject({ start: 0.4, end: 0.41 });
    for (const w of words) expect(w.confidence).toBeGreaterThan(0);
    expect(new Set(words.map((w) => w.speaker))).toEqual(new Set(['S1']));
  });

  it('tinydiarize: alternates S1/S2 after a speaker_turn_next segment and skips annotation segments', async () => {
    const json = JSON.parse(await readFile(join(FIXTURES, 'whisper-cpp/tdrz-synthetic.ojf.json'), 'utf8')) as WhisperJson;
    const { words, text } = mapWhisperJson(json, { tdrz: true });
    expect(text).toBe('Hi Maya, how are you? Fine, thanks. Good to hear.');
    expect(words.map((w) => w.speaker)).toEqual(['S1', 'S1', 'S1', 'S1', 'S1', 'S2', 'S2', 'S1', 'S1', 'S1']);
    // without -tdrz the markers mean nothing
    expect(new Set(mapWhisperJson(json).words.map((w) => w.speaker))).toEqual(new Set(['S1']));
  });

  it('handles an empty result', () => {
    expect(mapWhisperJson({})).toEqual({ text: '', words: [] });
    expect(mapWhisperJson({ result: { language: 'auto' }, transcription: [] })).toEqual({ text: '', words: [] });
  });
});

describe('whisper-cli arguments', () => {
  const p = (modelName: string, extra: Partial<ConstructorParameters<typeof WhisperCppProvider>[1]> = {}) =>
    new WhisperCppProvider('whisper-cpp:x', { bin: 'whisper-cli', modelPath: '/m.bin', modelName, tdrz: false, extraArgs: [], ...extra });

  it('auto-detects the language with multilingual models and forces English with .en models', () => {
    expect(p('base').args('/a.wav', {})).toEqual(['-m', '/m.bin', '-f', '/a.wav', '-l', 'auto', '-oj', '-ojf', '-np']);
    expect(p('small.en').args('/a.wav', {})).toContain('en');
    expect(p('small.en-tdrz', { tdrz: true, threads: 8, extraArgs: ['-ng'] }).args('/a.wav', { language: 'nl-BE', prompt: 'Lumora' }))
      .toEqual(['-m', '/m.bin', '-f', '/a.wav', '-l', 'nl', '-oj', '-ojf', '-np', '--prompt', 'Lumora', '-tdrz', '-t', '8', '-ng']);
  });

  it('keeps the end of a long prompt (whisper keeps at most 224 tokens), cut at a word', () => {
    const long = `${'context '.repeat(200)}Names and terms: DriveCover, Lumora.`;
    const tail = promptTail(long)!;
    expect(tail.length).toBeLessThanOrEqual(600);
    expect(tail.endsWith('Names and terms: DriveCover, Lumora.')).toBe(true);
    expect(tail.startsWith('context')).toBe(true);
    expect(promptTail('  a\n b ')).toBe('a b');
    expect(promptTail(undefined)).toBeUndefined();
  });

  it('turns on -tdrz for tdrz model names and with WHISPER_CPP_TDRZ=1', () => {
    const make = (model: string, env: NodeJS.ProcessEnv = {}) =>
      (createProvider('text', resolveSelection(parseModelSpec(`whisper-cpp:${model}`), 'text'), env, { cwd: '/' }) as unknown as WhisperCppProvider).args('/a.wav', {});
    expect(make('small.en-tdrz')).toContain('-tdrz');
    expect(make('base')).not.toContain('-tdrz');
    expect(make('/models/custom.bin', { WHISPER_CPP_TDRZ: '1' })).toContain('-tdrz');
  });
});

describe('whisper.cpp model and binary resolution', () => {
  it('finds ggml-<name>.bin in ~/.cache/whisper.cpp, a WHISPER_CPP_MODEL folder, or uses a pinned file or a path', async () => {
    const dir = await tempDir('overtone-models-');
    expect(resolveModelFile('base', {}, '/w').path).toBe(join(homedir(), '.cache/whisper.cpp/ggml-base.bin'));
    expect(DEFAULT_MODEL_DIR).toBe(join(homedir(), '.cache/whisper.cpp'));
    expect(resolveModelFile('small.en', { WHISPER_CPP_MODEL: dir }, '/w').path).toBe(join(dir, 'ggml-small.en.bin'));
    expect(resolveModelFile('base', { WHISPER_CPP_MODEL: join(dir, 'mine.bin') }, '/w').path).toBe(join(dir, 'mine.bin'));
    expect(resolveModelFile('models/ggml-tiny.bin', {}, '/w').path).toBe('/w/models/ggml-tiny.bin');
    expect(resolveModelFile('~/m/ggml-x.bin', {}, '/w').path).toBe(join(homedir(), 'm/ggml-x.bin'));
  });

  it('explains how to download a missing model, with its size and URL', () => {
    const msg = missingModelMessage('/home/u/.cache/whisper.cpp/ggml-large-v3-turbo.bin', 'large-v3-turbo');
    expect(msg).toContain('Download it (1.5 GiB) once:');
    expect(msg).toContain('curl -L --fail -o "/home/u/.cache/whisper.cpp/ggml-large-v3-turbo.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin');
    expect(modelUrl('small.en-tdrz')).toBe('https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin');
    expect(missingModelMessage('/x/y.bin', './y.bin')).toBe('whisper.cpp model file not found: /x/y.bin');
  });

  it('preflight: missing binary → install hint; missing model → download hint; both present → ok', async () => {
    const dir = await tempDir('overtone-wpre-');
    const deps = { role: 'text' as const, id: 'whisper-cpp:base', cwd: dir };
    await expect(whisperCppProvider.preflight!({ PATH: dir }, 'base', deps)).rejects.toThrow(INSTALL_HINT);
    const bin = join(dir, 'whisper-cli');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
    expect(await findExecutable('whisper-cli', { PATH: dir }, dir)).toBe(bin);
    await expect(whisperCppProvider.preflight!({ PATH: dir, WHISPER_CPP_MODEL: dir }, 'base', deps)).rejects.toThrow(/whisper\.cpp model not found: .*ggml-base\.bin\nDownload it \(142 MiB\) once:/);
    await writeFile(join(dir, 'ggml-base.bin'), 'x');
    await expect(whisperCppProvider.preflight!({ PATH: dir, WHISPER_CPP_MODEL: dir }, 'base', deps)).resolves.toBeUndefined();
    await expect(whisperCppProvider.preflight!({ WHISPER_CPP_BIN: bin, WHISPER_CPP_MODEL: dir }, 'base', deps)).resolves.toBeUndefined();
    await expect(whisperCppProvider.preflight!({ WHISPER_CPP_BIN: join(dir, 'nope'), WHISPER_CPP_MODEL: dir }, 'base', deps)).rejects.toThrow(/not found at WHISPER_CPP_BIN=/);
  });
});

describe('ollama', () => {
  const tags = JSON.parse(readFileSync(join(FIXTURES, 'ollama/tags.json'), 'utf8')) as unknown;
  const deps = { role: 'llm' as const, id: 'ollama:qwen3:8b', cwd: '/' };
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('defaults to a local server; OLLAMA_BASE_URL may end in /v1 or /api', () => {
    expect(ollamaHost({})).toBe('http://localhost:11434');
    expect(ollamaHost({ OLLAMA_BASE_URL: 'http://gpu-box:11434/v1/' })).toBe('http://gpu-box:11434');
    expect(ollamaHost({ OLLAMA_BASE_URL: 'https://ollama.com/api' })).toBe('https://ollama.com');
  });

  it('preflight: the model is there (a bare name matches its :latest tag)', async () => {
    await expect(ollamaProvider.preflight!({}, 'qwen3:8b', { ...deps, fetch: answering(200, tags) })).resolves.toBeUndefined();
    await expect(ollamaProvider.preflight!({}, 'llama3.1', { ...deps, fetch: answering(200, { models: [{ name: 'llama3.1:latest' }] }) })).resolves.toBeUndefined();
  });

  it('preflight: a missing model gives the pull command', async () => {
    await expect(ollamaProvider.preflight!({}, 'gemma3:12b', { ...deps, fetch: answering(200, tags) }))
      .rejects.toThrow('Ollama has no model "gemma3:12b" yet. Pull it first: ollama pull gemma3:12b\n(installed: qwen3:8b, llama3.1:8b)');
  });

  it('preflight: a server that is not running gives install and start instructions; bad settings are user errors', async () => {
    const refused = (async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); }) as unknown as typeof fetch;
    await expect(ollamaProvider.preflight!({}, 'qwen3:8b', { ...deps, fetch: refused }))
      .rejects.toThrow(/^Ollama is not reachable at http:\/\/localhost:11434\.\nInstall it from https:\/\/ollama\.com\/download/);
    await expect(ollamaProvider.preflight!({}, 'qwen3:8b', { ...deps, fetch: answering(500, {}) })).rejects.toThrow(/answered HTTP 500/);
    await expect(ollamaProvider.preflight!({ OLLAMA_NUM_CTX: 'big' }, 'qwen3:8b', { ...deps, fetch: answering(200, tags) })).rejects.toThrow(/OLLAMA_NUM_CTX must be an integer/);
    await expect(ollamaProvider.preflight!({ OLLAMA_THINK: 'maybe' }, 'qwen3:8b', { ...deps, fetch: answering(200, tags) })).rejects.toThrow(/OLLAMA_THINK must be/);
  });

  it('asks for a 16K context and an 8K answer limit with thinking off by default; the variables change them', () => {
    const req = { name: 'n', system: 's', user: 'u', schema: { type: 'object' } };
    const body = (env: NodeJS.ProcessEnv) => (createProvider('llm', resolveSelection(parseModelSpec('ollama'), 'llm'), env, { cwd: '/' }) as unknown as OllamaLlmProvider).body(req);
    expect(body({})).toEqual({
      model: 'qwen3:8b',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      format: { type: 'object' },
      stream: true,
      think: false,
      options: { num_ctx: 16384, num_predict: 8192 },
    });
    expect(body({ OLLAMA_THINK: 'High', OLLAMA_NUM_CTX: '32768', OLLAMA_MAX_TOKENS: '2048' })).toMatchObject({ think: 'high', options: { num_ctx: 32768, num_predict: 2048 } });
    expect(body({ OLLAMA_THINK: 'default' })).not.toHaveProperty('think');
  });

  it('an answer that filled the context window is reported as cut off', async () => {
    const full = `${JSON.stringify({ message: { content: '{}' }, done: false })}\n${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 16300, eval_count: 84 })}\n`;
    const f = (async () => new Response(full, { status: 200 })) as unknown as typeof fetch;
    const p = createProvider('llm', resolveSelection(parseModelSpec('ollama'), 'llm'), {}, { cwd: '/', deps: { fetch: f } }) as unknown as OllamaLlmProvider;
    await expect(p.complete({ name: 'n', system: '', user: '', schema: {} })).rejects.toMatchObject({ truncated: true, message: expect.stringMatching(/raise OLLAMA_NUM_CTX/) });
  });

  it('retries an error reported in the middle of the stream (a crashed model runner)', async () => {
    const bodies = [
      `${JSON.stringify({ message: { content: '{"a"' }, done: false })}\n${JSON.stringify({ error: 'an error was encountered while running the model: unexpected EOF' })}\n`,
      `${JSON.stringify({ message: { content: '{"a":1}' }, done: false })}\n${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 })}\n`,
    ];
    let n = 0;
    const f = (async () => new Response(bodies[n++]!, { status: 200 })) as unknown as typeof fetch;
    const p = createProvider('llm', resolveSelection(parseModelSpec('ollama'), 'llm'), {}, { cwd: '/', deps: { fetch: f, retry: { sleep: async () => {} } } }) as unknown as OllamaLlmProvider;
    expect(await p.complete({ name: 'n', system: '', user: '', schema: {} })).toEqual({ a: 1 });
    expect(n).toBe(2);
  });

  it('strips a leading <think> block and a ```json fence before parsing', () => {
    expect(jsonContent('<think>\nThe user wants edits.\n</think>\n\n{"edits":[]}')).toBe('{"edits":[]}');
    expect(jsonContent('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonContent('  {"a":1} ')).toBe('{"a":1}');
    expect(jsonContent(null)).toBe('');
  });
});

describe.skipIf(!hasFfmpeg)('local mode end to end (fake whisper-cli replaying a real -ojf output, recorded LLM)', () => {
  it('runs --text whisper-cpp --timing same: one whisper call on the WAV, its timings pass through', async () => {
    const dir = await tempDir('overtone-local-e2e-');
    const media = join(dir, 'sample.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=18', '-c:a', 'aac', media]);
    const bin = join(dir, 'whisper-cli');
    await copyFile(join(import.meta.dirname, 'conformance/fake-whisper-cli.mjs'), bin);
    await chmod(bin, 0o755);
    await writeFile(join(dir, 'ggml-base.bin'), 'fake model');
    const calls = join(dir, 'calls.jsonl');
    const script = join(dir, 'script.json');
    await writeFile(script, JSON.stringify({ steps: [{ exit: 0, json: join(FIXTURES, 'whisper-cpp/sample-base.ojf.json') }], calls }));
    const env = { PATH: process.env.PATH, WHISPER_CPP_BIN: bin, WHISPER_CPP_MODEL: dir, FAKE_WHISPER_SCRIPT: script };
    const recorded = resolve(import.meta.dirname, '../../../examples/fixtures/recorded/sample');
    const log = memoryLogger();
    const code = await runTranscribe(media, { text: 'whisper-cpp:base', timing: 'same', llm: `recorded:${recorded}`, out: dir, export: 'json', glossary: undefined }, log, { cwd: dir, env });
    expect(code).toBe(0);

    const argv = (await readFile(calls, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(argv).toHaveLength(1);
    expect(argv[0]![argv[0]!.indexOf('-f') + 1]).toMatch(/audio\.wav$/);
    expect(argv[0]![argv[0]!.indexOf('-m') + 1]).toBe(join(dir, 'ggml-base.bin'));

    const doc = assertValid(JSON.parse(await readFile(join(dir, 'sample.overtone.json'), 'utf8')));
    expect(doc.meta?.models).toEqual({ text: 'whisper-cpp:base', timing: 'whisper-cpp:base', llm: `recorded:${recorded}` });
    const words = doc.turns.flatMap((t) => t.words);
    expect(words.filter((w) => w.match === 'exact' || w.match === 'edited').length).toBe(words.length);
    expect(log.lines).toContain('info: usage: text whisper-cpp:base 1 request, 18.0 s audio');
    expect(log.lines.at(-1)).toMatch(/^info: \d+ words: \d+ exact/);
  });
});
