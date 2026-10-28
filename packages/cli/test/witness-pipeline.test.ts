import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { LlmRequest } from '../src/providers/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Text "Hello there. Hi Mara!", while the timing side heard "maya"; the LLM proposes "Maya!" (a name change). */
function providers(prompts: LlmRequest[] = []): Providers {
  return {
    text: { id: 'fake:text', transcribe: async () => ({ text: 'Hello there. Hi Mara! Bye then.', language: 'en' }) },
    timing: {
      id: 'fake:timing',
      align: async () => ({
        words: ['hello', 'there', 'hi', 'maya', 'bye', 'zap'].map((text, i) => ({ text, start: 0.5 + i * 0.6, end: 0.9 + i * 0.6, speaker: 'S1' })),
      }),
    },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        prompts.push(req);
        if (req.name === 'corrections') return { edits: [{ first: 3, last: 3, to: 'Maya!', reason: 'correction', sure: true, note: '' }], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
}

describe.skipIf(!hasFfmpeg)('pipeline: the editor sees what the timing side heard', () => {
  it('passes what the timing side heard from align to the editor\'s prompt, and applies the edit', async () => {
    const dir = await tempDir('overtone-witness-');
    const file = join(dir, 'clip.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-c:a', 'aac', file]);
    const cfg = await resolveConfig({ export: 'json,txt', context: 'A greeting.' }, {}, { cwd: dir, configDir: dir });
    const log = memoryLogger();
    const prompts: LlmRequest[] = [];
    const res = await runPipeline(file, { ...cfg, markUncertain: true }, { log, cwd: dir, providers: providers(prompts), checkBinaries: async () => [] });
    expect(res.doc.edits).toEqual([{ words: [3, 3], from: 'Mara!', to: 'Maya!', reason: 'correction' }]);
    expect(prompts.find((p) => p.name === 'corrections')!.user).toContain('3: Mara! → maya');
    // "then" was heard as "zap": unresolved, so the transcript marks it; the JSON keeps the text model's word
    const words = res.doc.turns.flatMap((t) => t.words);
    expect(words[5]).toMatchObject({ text: 'then.', match: 'fuzzy' });
    expect(await readFile(join(dir, 'clip.txt'), 'utf8')).toContain('Bye then (??).');
  });
});
