import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROFILES, validate } from 'overtone-format';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, validateFileConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { buildProgram } from '../src/program.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmProvider, LlmRequest } from '../src/providers/types.js';
import { refine, type RefineOptions } from '../src/refine/llm-steps.js';
import { buildProfile } from '../src/segment/profile.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dirs = { cwd: '/tmp', configDir: '/tmp' };

afterEach(() => {
  process.exitCode = 0;
});

/** An LLM that answers every refine step and records each request. */
function fakeLlm(): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: 'fake:llm',
    requests,
    async complete<T>(req: LlmRequest): Promise<T> {
      requests.push(req);
      if (req.name === 'corrections') return { edits: [], speakers: [{ id: 'S1', label: 'Host', role: 'host' }, { id: 'S2', label: 'Maya', role: '' }] } as T;
      if (req.name === 'context') return { topic: 'A short greeting between a host and Maya.', names: ['Maya'], terms: [] } as T;
      if (req.name === 'styling') return { styles: [] } as T;
      return { cueStarts: [0, 1, 2, 3], lineStarts: [] } as T;
    },
  };
}

describe('llmLinebreaks in overtone.config.json, --llm-linebreaks and --no-llm-linebreaks', () => {
  it('validates the config field', () => {
    expect(validateFileConfig({ llmLinebreaks: false }).llmLinebreaks).toBe(false);
    expect(() => validateFileConfig({ llmLinebreaks: 'no' })).toThrow(/"llmLinebreaks" must be true or false/);
  });

  it('is off by default (rules only); the file can turn it on and a flag wins over the file', async () => {
    expect((await resolveConfig({}, {}, dirs)).llmLinebreaks).toBe(false);
    expect((await resolveConfig({}, { llmLinebreaks: true }, dirs)).llmLinebreaks).toBe(true);
    expect((await resolveConfig({}, { llmLinebreaks: false }, dirs)).llmLinebreaks).toBe(false);
    expect((await resolveConfig({ llmLinebreaks: true }, { llmLinebreaks: false }, dirs)).llmLinebreaks).toBe(true);
    expect((await resolveConfig({ llmLinebreaks: false }, { llmLinebreaks: true }, dirs)).llmLinebreaks).toBe(false);
  });

  it('parses --llm-linebreaks and --no-llm-linebreaks on transcribe; neither leaves it to the config file', async () => {
    const parse = async (args: string[]) => {
      const program = buildProgram(memoryLogger(), { cwd: '/nonexistent' });
      await program.parseAsync(['transcribe', 'missing.mp4', ...args], { from: 'user' });
      return program.commands.find((c) => c.name() === 'transcribe')!.opts<CliFlags>();
    };
    expect((await parse([])).llmLinebreaks).toBeUndefined();
    expect((await parse(['--llm-linebreaks'])).llmLinebreaks).toBe(true);
    expect((await parse(['--no-llm-linebreaks'])).llmLinebreaks).toBe(false);
  });
});

describe('refine without LLM line cutting', () => {
  const words: SpeakerWord[] = [
    ...tokenizeDisplay('Hello there.').map((t, k) => ({ text: t, start: 0.5 + k * 0.5, end: 0.9 + k * 0.5, speaker: 'S1', match: 'exact' as const, confidence: 1 })),
    ...tokenizeDisplay('Hi Maya!').map((t, k) => ({ text: t, start: 2 + k * 0.5, end: 2.4 + k * 0.5, speaker: 'S2', match: 'exact' as const, confidence: 1 })),
  ];
  const opts: RefineOptions = {
    glossary: [],
    style: { numbers: 'auto', currency: 'auto' },
    language: 'en',
    pinnedSpeakers: {},
    edits: { maxSpan: 6 },
    styling: { maxStyledRatio: 0.15, maxKeyPerCue: 1 },
    profiles: [{ id: 'horizontal', ...DEFAULT_PROFILES.horizontal }, { id: 'vertical', ...DEFAULT_PROFILES.vertical }],
    duration: 6,
  };

  it('sends no linebreaks requests and uses the deterministic layout for every profile', async () => {
    const llm = fakeLlm();
    const res = await refine(llm, words, { ...opts, llmLinebreaks: false }, memoryLogger());
    expect(llm.requests.map((r) => r.name)).toEqual(['corrections', 'styling']);
    for (const [k, spec] of opts.profiles.entries()) {
      const det = buildProfile(res.words, spec, { language: 'en', glossary: [], duration: 6 }).profile;
      expect(res.profiles[k]).toEqual(det);
    }
    expect(res.cutting.map((c) => [c.profile, c.rules, c.fromProposal, c.proposalCues, c.repairedCues])).toEqual([
      ['horizontal', true, 0, 0, 0],
      ['vertical', true, 0, 0, 0],
    ]);
  });

  it('asks for line cutting per profile when refine() is not told otherwise (the CLI always passes its setting)', async () => {
    const llm = fakeLlm();
    const res = await refine(llm, words, opts, memoryLogger());
    expect(llm.requests.map((r) => r.name).sort()).toEqual(['corrections', 'linebreaks-horizontal', 'linebreaks-vertical', 'styling']);
    expect(res.cutting.every((c) => c.rules === undefined)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)('llmLinebreaks in the pipeline (ffmpeg, fake providers)', () => {
  function fakeProviders(): Providers & { calls: string[] } {
    const calls: string[] = [];
    const llm = fakeLlm();
    return {
      calls,
      text: { id: 'fake:text', transcribe: async () => { calls.push('text'); return { text: 'Hello there. Hi Maya!', language: 'en' }; } },
      timing: {
        id: 'fake:timing',
        align: async () => {
          calls.push('timing');
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
      llm: { id: llm.id, complete: async <T>(req: LlmRequest) => { calls.push(req.name); return llm.complete<T>(req); } },
    };
  }

  it('skips the linebreaks requests, logs it, records meta.linebreaks and sends only the requests the setting needs', async () => {
    const dir = await tempDir('overtone-linebreaks-');
    const file = join(dir, 'clip.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'aac', file]);
    const on = await resolveConfig({ export: 'json,vtt', llmLinebreaks: true }, {}, { cwd: dir, configDir: dir });
    const off = await resolveConfig({ export: 'json,vtt' }, {}, { cwd: dir, configDir: dir });
    expect(off.llmLinebreaks).toBe(false);

    const first = fakeProviders();
    const withLlm = await runPipeline(file, on, { log: memoryLogger(), cwd: dir, providers: first });
    expect(first.calls).toContain('linebreaks-horizontal');
    expect(withLlm.doc.meta?.linebreaks).toBe('llm');

    // toggled off: refine re-runs (never the LLM-assisted cut) without linebreaks requests; the other requests are
    // the same, so their answers come from the cache
    const second = fakeProviders();
    const log = memoryLogger();
    await runPipeline(file, off, { log, cwd: dir, providers: second });
    expect(second.calls).toEqual([]);
    expect(log.lines).toContain('info:   horizontal: lines cut by rules only (LLM line cutting off), 2 speaker blocks');
    expect(log.lines).toContain('info:   vertical: lines cut by rules only (LLM line cutting off), 2 speaker blocks');
    expect(log.lines.some((l) => l.includes('cut as proposed by the LLM'))).toBe(false);
    const json = JSON.parse(await readFile(join(dir, 'clip.overtone.json'), 'utf8'));
    expect(validate(json).valid).toBe(true);
    expect(json.meta.linebreaks).toBe('rules');

    // off again, with another (unused) linebreaks effort: cached
    const third = fakeProviders();
    await runPipeline(file, { ...off, effort: { ...off.effort, linebreaks: 'high' } }, { log: memoryLogger(), cwd: dir, providers: third });
    expect(third.calls).toEqual([]);

    // back on: refine re-runs with the LLM line cutting, from the cached answers of the first run
    const fourth = fakeProviders();
    const again = await runPipeline(file, on, { log: memoryLogger(), cwd: dir, providers: fourth });
    expect(fourth.calls).toEqual([]);
    expect(again.doc.profiles).toEqual(withLlm.doc.profiles);
  });
});
