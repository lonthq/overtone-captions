import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTranscribe, type TranscribeFlags } from '../src/commands/transcribe.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import type { PipelineDeps } from '../src/pipeline.js';
import { buildProgram } from '../src/program.js';
import { registerProvider } from '../src/providers/registry.js';
import { tempDir } from './tmp.js';

// the command-line test probes a real file: it needs both ffmpeg (to make it) and ffprobe (to read it)
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const KEYS = { OPENAI_API_KEY: 'fake-openai', AZURE_SPEECH_KEY: 'fake-speech', AZURE_SPEECH_REGION: 'fakeregion' };
const fail = (what: string) => () => { throw new Error(`dry run called ${what}`); };

/** A folder with a placeholder media file (never read: the probes are injected) and the probes of a 10-minute 16:9 video. */
async function setup(): Promise<{ dir: string; deps: Partial<PipelineDeps> }> {
  const dir = await tempDir('overtone-dry-run-');
  await writeFile(join(dir, 'talk.mp4'), 'placeholder');
  const deps: Partial<PipelineDeps> = {
    cwd: dir,
    checkBinaries: async () => [],
    probeDuration: async () => 600,
    probeVideo: async () => ({ width: 1920, height: 1080, fps: 25 }),
    extractAudio: fail('extractAudio'),
    cutAudio: fail('cutAudio'),
    createLlm: fail('createLlm'),
  };
  return { dir, deps };
}

async function dryRun(flags: TranscribeFlags, env: NodeJS.ProcessEnv, extra: Partial<PipelineDeps> = {}) {
  const { dir, deps } = await setup();
  const log = memoryLogger();
  const before = await readdir(dir);
  const result = await runTranscribe('talk.mp4', { ...flags, dryRun: true }, log, { ...deps, env, ...extra }).then((code) => ({ code, error: undefined }), (error: Error) => ({ code: 1, error }));
  // nothing written: no cache folder, no outputs
  expect(await readdir(dir)).toEqual(before);
  const out = log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5));
  const line = (key: string) => out.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);
  return { ...result, dir, out, line };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fail('fetch'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe('overtone transcribe --dry-run', () => {
  it('default selection with keys: providers, destinations, outputs and the measured cost, exit code 0', async () => {
    const r = await dryRun({}, KEYS);
    expect(r.error).toBeUndefined();
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('dry run: nothing was extracted, sent, cached or written');
    expect(r.line('duration')).toBe('0:10:00 (600.0 s)');
    expect(r.line('text')).toBe('openai:gpt-transcribe (cloud: OpenAI (api.openai.com))');
    expect(r.line('timing')).toMatch(/^azure-speech:fast \(cloud: Azure AI Speech/);
    expect(r.line('second hearing')).toBe('none (auto: ELEVENLABS_API_KEY is not set)');
    expect(r.line('llm')).toMatch(/^openai:gpt-6\.1-sol \(cloud/);
    expect(r.line('language')).toBe('detected during the run');
    expect(r.line('context')).toBe('inferred from the transcript (one LLM request)');
    expect(r.line('audio goes to')).toBe('OpenAI (api.openai.com) [cloud], Azure AI Speech (the region in AZURE_SPEECH_REGION) [cloud]');
    expect(r.line('missing environment variables')).toBe('none');
    expect(r.line('config file')).toBe('none');
    expect(r.line('.env')).toBe('not found');
    expect(r.out).toContain(`  ${join(r.dir, 'talk.overtone.json')}`);
    expect(r.out).toContain(`  ${join(r.dir, 'talk.vertical.vtt')}`);
    expect(r.line('cache')).toBe(join(r.dir, '.overtone'));
    expect(r.line('estimated cost')).toBe('$0.020–0.026 per audio minute, about $0.20–0.26 for this media (estimate at list prices, measured on the default setup)');
    expect(r.line('runnable')).toBe('yes');
    // never a value of the environment
    expect(r.out.join('\n')).not.toMatch(/fake-|fakeregion/);
  });

  it('adds ElevenLabs as the automatic second hearing when its key is set', async () => {
    const r = await dryRun({}, { ...KEYS, ELEVENLABS_API_KEY: 'fake-eleven' });
    expect(r.line('second hearing')).toBe('elevenlabs:scribe_v2 (cloud: ElevenLabs (api.elevenlabs.io)) (auto: ELEVENLABS_API_KEY is set)');
    expect(r.line('audio goes to')).toContain('ElevenLabs (api.elevenlabs.io) [cloud]');
    expect(r.line('estimated cost')).toMatch(/^\$0\.025–0\.039 per audio minute, about \$0\.25–0\.39 for this media/);
  });

  it('estimates Azure OpenAI deployments named after the default models, and not other deployments', async () => {
    const azure = { AZURE_OPENAI_ENDPOINT: 'https://fake.openai.azure.com', AZURE_OPENAI_API_KEY: 'fake-azure', AZURE_SPEECH_KEY: 'fake-speech', AZURE_SPEECH_REGION: 'fakeregion' };
    const named = await dryRun({ text: 'azure-openai:gpt-transcribe', llm: 'azure-openai:gpt-6.1-sol' }, azure);
    expect(named.line('estimated cost')).toMatch(/^\$0\.020–0\.026 per audio minute.*assuming the Azure deployments run the models they are named after\)$/);
    const other = await dryRun({ text: 'azure-openai:my-whisper', llm: 'azure-openai:gpt-6.1-sol' }, azure);
    expect(other.line('estimated cost')).toBe('no measured estimate for this combination of providers');
  });

  it('--local: local providers only, no second hearing, $0, local tools not checked', async () => {
    const r = await dryRun({ local: true }, { ELEVENLABS_API_KEY: 'fake-eleven' });
    expect(r.code).toBe(0);
    expect(r.line('text')).toBe('whisper-cpp:large-v3-turbo (local: whisper.cpp on this machine)');
    expect(r.line('timing')).toBe('same as text (whisper-cpp:large-v3-turbo gives the word timings)');
    expect(r.line('second hearing')).toBe('none');
    expect(r.line('llm')).toMatch(/^ollama:.* \(local: Ollama on this machine/);
    expect(r.line('audio goes to')).toBe('whisper.cpp on this machine [local]');
    expect(r.line('estimated cost')).toBe('$0 (local providers only)');
    expect(r.line('not checked')).toMatch(/whisper\.cpp binary and model file, Ollama server and model/);
  });

  it('applies the config file: providers, profiles, output folder and per-language editors', async () => {
    const { dir, deps } = await setup();
    await writeFile(join(dir, 'overtone.config.json'), JSON.stringify({
      llm: 'anthropic', profiles: ['vertical'], out: 'captions', export: ['json', 'srt'], timingSecondOpinion: 'none',
      languages: { nl: { llm: 'openai' } },
    }));
    await writeFile(join(dir, '.env'), '# placeholder; never read by the dry run\n');
    const log = memoryLogger();
    expect(await runTranscribe('talk.mp4', { dryRun: true }, log, { ...deps, env: { ...KEYS, ANTHROPIC_API_KEY: 'fake-ant', ELEVENLABS_API_KEY: 'fake-eleven' } })).toBe(0);
    const out = log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5));
    expect(out).toContain(`config file: ${join(dir, 'overtone.config.json')}`);
    expect(out).toContain(`.env: found (${join(dir, '.env')})`);
    expect(out.find((l) => l.startsWith('llm: '))).toMatch(/^llm: anthropic:\S+ \(cloud: Anthropic \(api\.anthropic\.com\)\)$/);
    expect(out).toContain('second hearing: none');
    expect(out).toContain('profiles: vertical');
    expect(out).toContain(`  ${join(dir, 'captions', 'talk.vertical.srt')}`);
    expect(out.find((l) => l.startsWith('per-language: '))).toMatch(/^per-language: languages\.nl\.llm: openai:gpt-6\.1-sol \(OpenAI \(api\.openai\.com\)\), if the detected language is nl$/);
    expect(out).toContain('estimated cost: no measured estimate for this combination of providers');
  });

  it('adds the profile for the media\'s own shape, as the run does', async () => {
    const r = await dryRun({}, KEYS, { probeVideo: async () => ({ width: 1080, height: 1080, fps: 25 }) });
    expect(r.line('profiles')).toBe('horizontal, vertical, 1x1 (1x1 added for the media\'s shape)');
    expect(r.out).toContain(`  ${join(r.dir, 'talk.1x1.vtt')}`);
  });

  it('missing keys: the whole plan, then the missing-variables error and exit code 1', async () => {
    const r = await dryRun({}, { OPENAI_API_KEY: 'fake-openai' });
    expect(r.line('missing environment variables')).toBe('AZURE_SPEECH_KEY (azure-speech), AZURE_SPEECH_REGION (azure-speech)');
    expect(r.line('runnable')).toBe('no');
    expect(r.error?.name).toBe('UserError');
    expect(r.error?.message).toMatch(/^Missing environment variables for the selected providers:\n {2}AZURE_SPEECH_KEY/);
  });

  it('ffprobe missing: says so and goes on; the run would stop, so exit code 1', async () => {
    const r = await dryRun({}, KEYS, { checkBinaries: async () => ['ffprobe'], probeDuration: undefined });
    expect(r.line('duration')).toBe('unknown (ffprobe not found on PATH)');
    expect(r.line('estimated cost')).toMatch(/^\$0\.020–0\.026 per audio minute \(estimate/);
    expect(r.error?.message).toMatch(/ffprobe not found on PATH/);
  });

  it('constructs and calls no provider, not even a selected one', async () => {
    const calls: string[] = [];
    const remove = registerProvider({
      id: 'trap', description: 'throws when touched', roles: ['llm'], env: [{ name: 'TRAP_KEY', description: 'key', required: true }], defaults: { llm: 'm' },
      preflight: async () => { calls.push('preflight'); },
      create: () => { calls.push('create'); throw new Error('created'); },
    });
    try {
      const r = await dryRun({ llm: 'trap' }, { ...KEYS, TRAP_KEY: 'fake-trap' });
      expect(r.code).toBe(0);
      expect(r.line('llm')).toBe('trap:m (cloud: trap (throws when touched))');
      expect(calls).toEqual([]);
    } finally {
      remove();
    }
  });

  it('refuses bad input as the run would: a missing media file', async () => {
    const { deps } = await setup();
    await expect(runTranscribe('nope.mp4', { dryRun: true }, memoryLogger(), { ...deps, env: KEYS })).rejects.toThrow(/Media file not found/);
  });

  it.skipIf(!hasFfmpeg)('works from the command line on a real file (ffprobe), writing nothing', async () => {
    const dir = await tempDir('overtone-dry-run-cli-');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'aac', join(dir, 'clip.m4a')]);
    const log = memoryLogger();
    await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'transcribe', 'clip.m4a', '--local', '--dry-run']);
    expect(log.lines).toContain('out: video: none (audio only)');
    expect(log.lines.find((l) => l.startsWith('out: duration: '))).toMatch(/^out: duration: 0:00:03 \(3\.0 s\)$/);
    expect(log.lines).toContain('out: runnable: yes');
    expect(process.exitCode).toBe(0);
    // not runnable: --export mp4 on audio only is refused as the run would, with exit code 1
    const failing = memoryLogger();
    await buildProgram(failing, { cwd: dir }).parseAsync(['node', 'overtone', 'transcribe', 'clip.m4a', '--local', '--dry-run', '--export', 'mp4']);
    expect(failing.lines).toContain('out: runnable: no');
    expect(failing.lines.join('\n')).toMatch(/clip\.m4a has no video stream; --export mp4 needs a video\./);
    expect(process.exitCode).toBe(1);
    expect(await readdir(dir)).toEqual(['clip.m4a']);
  });
});
