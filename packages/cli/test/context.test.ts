import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmProvider, LlmRequest, TextOptions } from '../src/providers/types.js';
import { CONTEXT_HEAD_WORDS, CONTEXT_SAMPLE_WORDS, CONTEXT_SAMPLES, contextExcerpt, inferContext } from '../src/refine/context.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const llm = (answer: (req: LlmRequest) => unknown): LlmProvider & { requests: LlmRequest[] } => {
  const requests: LlmRequest[] = [];
  return { id: 'fake', requests, async complete<T>(req: LlmRequest) { requests.push(req); return answer(req) as T; } };
};

describe('inferContext', () => {
  it('sends the transcript and cleans the answer: trimmed, de-duplicated, sensible lengths', async () => {
    const fake = llm(() => ({ topic: '  An interview   with an astronaut. ', names: ['Jim Dutton', 'jim dutton', ' NASA ', 'x'.repeat(80), 3], terms: ['STS-124'] }));
    const res = await inferContext(fake, 'We talked to Jim Dutton.', { language: 'en', log: memoryLogger() });
    expect(res).toEqual({ topic: 'An interview with an astronaut.', names: ['Jim Dutton', 'NASA'], terms: ['STS-124'] });
    expect(fake.requests[0]).toMatchObject({ name: 'context', effort: 'low' });
    expect(fake.requests[0]!.user).toBe('Language: en\nTranscript:\nWe talked to Jim Dutton.');
    expect(fake.requests[0]!.system).toMatch(/1–2 sentences: what the recording is about, its setting .* and its tone/);
  });

  it('returns undefined with a warning when the call fails or gives no topic', async () => {
    const log = memoryLogger();
    expect(await inferContext(llm(() => { throw new Error('HTTP 500'); }), 'text', { log })).toBeUndefined();
    expect(await inferContext(llm(() => ({ topic: ' ', names: [], terms: [] })), 'text', { log })).toBeUndefined();
    expect(log.lines).toEqual([
      'warn: context inference failed (HTTP 500); continuing without a context',
      'warn: context inference returned no topic; continuing without a context',
    ]);
  });

  it('sends a long transcript as its first words plus samples of the rest', () => {
    const words = Array.from({ length: 20_000 }, (_, i) => `w${i}`);
    const excerpt = contextExcerpt(words.join(' '));
    const parts = excerpt.split('\n[…]\n');
    expect(parts).toHaveLength(1 + CONTEXT_SAMPLES);
    expect(parts[0]!.split(' ')).toHaveLength(CONTEXT_HEAD_WORDS);
    for (const p of parts.slice(1)) expect(p.split(' ')).toHaveLength(CONTEXT_SAMPLE_WORDS);
    expect(parts.at(-1)!.split(' ').at(-1)).not.toBe('w19999');
    expect(contextExcerpt('a  b\nc')).toBe('a b c');
  });
});

function providers(): Providers & { calls: string[]; prompts: Array<string | undefined>; requests: LlmRequest[] } {
  const calls: string[] = [];
  const prompts: Array<string | undefined> = [];
  const requests: LlmRequest[] = [];
  return {
    calls,
    prompts,
    requests,
    text: { id: 'fake:text', transcribe: async (_c, o: TextOptions) => { calls.push('text'); prompts.push(o.prompt); return { text: 'Hello there. Hi Maya!', language: 'en' }; } },
    timing: {
      id: 'fake:timing',
      align: async () => {
        calls.push('timing');
        return { words: [['hello', 0.5], ['there', 1], ['hi', 2], ['maya', 2.4]].map(([text, start]) => ({ text: text as string, start: start as number, end: (start as number) + 0.4, speaker: 'S1' })) };
      },
    },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        calls.push(req.name);
        requests.push(req);
        if (req.name === 'context') return { topic: 'A greeting between two friends.', names: ['Maya'], terms: [] } as T;
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
}

async function setup(flags: CliFlags = {}) {
  const dir = await tempDir('overtone-context-');
  const file = join(dir, 'clip.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', file]);
  const cfg = await resolveConfig({ export: 'json', ...flags }, {}, { cwd: dir, configDir: dir });
  return { dir, file, cfg };
}

describe.skipIf(!hasFfmpeg)('pipeline: inferred context', () => {
  it('infers a context once, caches its request and uses it for refine', async () => {
    const { dir, file, cfg } = await setup();
    const p = providers();
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(p.calls).toEqual(['text', 'timing', 'context', 'corrections', 'styling']);
    expect(res.doc.meta).toMatchObject({ context: 'A greeting between two friends.', contextSource: 'inferred' });
    expect(log.lines).toContain('info:   context (inferred): A greeting between two friends.');
    expect(log.lines).toContain('info:   names and terms (inferred): Maya');
    expect(p.requests.find((r) => r.name === 'corrections')!.system).toContain('What this media is about: A greeting between two friends.');
    // --from-stage refine keeps the cached context
    p.calls.length = 0;
    const again = memoryLogger();
    await runPipeline(file, { ...cfg, fromStage: 'refine' }, { log: again, cwd: dir, providers: p });
    expect(p.calls).toEqual(['corrections', 'styling']);
    expect(again.lines).toContain('info:   context (inferred, cached): A greeting between two friends.');
  });

  it('skips the inference with a user context or --no-infer-context', async () => {
    for (const flags of [{ context: 'Two friends.' }, { inferContext: false }] as CliFlags[]) {
      const { dir, file, cfg } = await setup(flags);
      const p = providers();
      const res = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: p });
      expect(p.calls).not.toContain('context');
      if (flags.context) expect(res.doc.meta).toMatchObject({ context: 'Two friends.', contextSource: 'user' });
      else expect(res.doc.meta).not.toHaveProperty('context');
    }
  });

  it('--two-pass transcribes again with the inferred context and names in the prompt, and warns about the cost', async () => {
    const { dir, file, cfg } = await setup({ twoPass: true });
    const p = providers();
    const log = memoryLogger();
    await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(p.calls.slice(0, 4)).toEqual(['text', 'timing', 'context', 'text']);
    expect(p.prompts[0]).toBeUndefined();
    expect(p.prompts[1]).toBe('A greeting between two friends.\nNames and terms: Maya.');
    expect(log.lines).toContain('warn: --two-pass: every chunk is transcribed twice, which doubles the transcription cost');

    // cached: no second transcription on the next run
    p.calls.length = 0;
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: p });
    expect(p.calls).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)('pipeline: --two-pass with --timing same', () => {
  it('aligns the second pass to its own word times, not to the first pass\'s', async () => {
    const { dir, file, cfg } = await setup({ twoPass: true, text: 'openai:whisper-1', timing: 'same', language: 'en' });
    const p = providers();
    const timed = (spec: Array<[string, number]>) => spec.map(([text, start]) => ({ text, start, end: start + 0.3, speaker: 'S1' }));
    // the first pass mishears the name and times the last two words a second early; the second pass has both right
    p.text = {
      id: 'fake:text',
      transcribe: async (_c, o: TextOptions) => (o.prompt?.includes('A greeting')
        ? { text: 'Hello there. Hi Maya!', language: 'en', words: timed([['Hello', 0.5], ['there.', 1], ['Hi', 2], ['Maya!', 2.4]]) }
        : { text: 'Hello there. Hi Mia!', language: 'en', words: timed([['Hello', 0.5], ['there.', 1], ['Hi', 1], ['Mia!', 1.4]]) }),
    };
    const res = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: p });
    const words = res.doc.turns.flatMap((t) => t.words);
    expect(words.map((w) => w.text)).toEqual(['Hello', 'there.', 'Hi', 'Maya!']);
    expect(words.find((w) => w.text === 'Maya!')).toMatchObject({ start: 2.4, match: 'exact' });
    expect(words.find((w) => w.text === 'Hi')).toMatchObject({ start: 2 });
  });
});
