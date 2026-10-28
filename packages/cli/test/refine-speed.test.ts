import { DEFAULT_PROFILES } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { OllamaLlmProvider } from '../src/providers/ollama.js';
import type { LlmProvider, LlmRequest } from '../src/providers/types.js';
import { refine, runLimited, type RefineOptions } from '../src/refine/llm-steps.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';
import { formatUsage, UsageMeter } from '../src/usage.js';

const WORDS: SpeakerWord[] = tokenizeDisplay('Every year, one in five drivers has some kind of car damage. With DriveCover you are insured from day one.')
  .map((t, k) => ({ text: t, start: +(k * 0.4).toFixed(3), end: +(k * 0.4 + 0.35).toFixed(3), speaker: 'S1', match: 'exact', confidence: 1 }));

const OPTS: RefineOptions = {
  context: 'An ad for DriveCover',
  glossary: ['DriveCover'],
  style: { numbers: 'auto', currency: 'auto' },
  language: 'en',
  pinnedSpeakers: {},
  edits: { maxSpan: 6 },
  styling: { maxStyledRatio: 0.15, maxKeyPerCue: 1 },
  profiles: [{ id: 'horizontal', ...DEFAULT_PROFILES.horizontal }, { id: 'vertical', ...DEFAULT_PROFILES.vertical }],
  duration: 10,
  effort: DEFAULTS.effort,
};

/** Answers after `delayMs`; records each request with its start and end time. */
function slowLlm(delayMs: number, warmup = 0): LlmProvider & { log: Array<{ req: LlmRequest; start: number; end: number }> } {
  const log: Array<{ req: LlmRequest; start: number; end: number }> = [];
  return {
    id: 'slow',
    cacheWarmupMs: warmup,
    log,
    async complete<T>(req: LlmRequest): Promise<T> {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      log.push({ req, start, end: Date.now() });
      if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
      if (req.name === 'styling') return { styles: [{ first: 0, last: 1, classes: ['number'] }] } as T;
      return { cueStarts: [0], lineStarts: [] } as T;
    },
  };
}

describe('refine speed and cost', () => {
  it('sends the effort per step: corrections medium, styling and line cutting low (the defaults)', async () => {
    expect(DEFAULTS.effort).toEqual({ corrections: 'medium', styling: 'low', linebreaks: 'low' });
    const llm = slowLlm(0);
    await refine(llm, WORDS, OPTS, memoryLogger());
    expect(Object.fromEntries(llm.log.map((c) => [c.req.name, c.req.effort]))).toEqual({
      corrections: 'medium', styling: 'low', 'linebreaks-horizontal': 'low', 'linebreaks-vertical': 'low',
    });
  });

  it('gives every profile the same schema name and every later step the same shared prompt', async () => {
    const llm = slowLlm(0);
    await refine(llm, WORDS, OPTS, memoryLogger());
    const [, styling, h, v] = llm.log.map((c) => c.req).sort((a, b) => ['corrections', 'styling', 'linebreaks-horizontal', 'linebreaks-vertical'].indexOf(a.name) - ['corrections', 'styling', 'linebreaks-horizontal', 'linebreaks-vertical'].indexOf(b.name));
    expect(h!.schemaName).toBe('linebreaks');
    expect(v!.schemaName).toBe('linebreaks');
    expect(h!.system).toBe(v!.system);
    expect(styling!.system).toBe(h!.system);
    expect(h!.user).not.toBe(v!.user);
  });

  it('runs styling and the line cutting of every profile concurrently, after the corrections', async () => {
    const llm = slowLlm(60);
    const res = await refine(llm, WORDS, OPTS, memoryLogger());
    const corrections = llm.log.find((c) => c.req.name === 'corrections')!;
    const rest = llm.log.filter((c) => c.req.name !== 'corrections');
    expect(rest).toHaveLength(3);
    for (const c of rest) expect(c.start).toBeGreaterThanOrEqual(corrections.end);
    // all three overlap: each starts before any of them ended
    const firstEnd = Math.min(...rest.map((c) => c.end));
    for (const c of rest) expect(c.start).toBeLessThan(firstEnd);
    // styling and the key-per-cue limit still apply
    expect(res.words[0]!.classes).toEqual(['number']);
    expect(res.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
  });

  it('starts styling and the first profile at once, and the next profile a cache warm-up later', async () => {
    const llm = slowLlm(10, 40);
    await refine(llm, WORDS, OPTS, memoryLogger());
    const start = (name: string) => llm.log.find((c) => c.req.name === name)!.start;
    expect(Math.abs(start('linebreaks-horizontal') - start('styling'))).toBeLessThan(20);
    expect(start('linebreaks-vertical') - start('linebreaks-horizontal')).toBeGreaterThanOrEqual(35);
  });

  it('runLimited keeps at most `limit` tasks in flight and the results in order', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10 + (i % 2) * 10));
      running--;
      return i;
    });
    expect(await runLimited(tasks, 3)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(3);
  });
});

describe('effort in the Ollama provider', () => {
  const cfg = { host: 'http://x', model: 'm', numCtx: 4096, maxTokens: 1024, think: false as boolean | string | undefined, responseFormat: 'json_schema' as const, fetch };
  const req = { name: 'n', system: 's', user: 'u', schema: { type: 'object' } };

  it('thinks only for effort high, unless OLLAMA_THINK is set', () => {
    const p = new OllamaLlmProvider('ollama:m', cfg);
    expect(p.body({ ...req, effort: 'high' }).think).toBe(true);
    expect(p.body({ ...req, effort: 'medium' }).think).toBe(false);
    expect(p.body(req).think).toBe(false);
    const fromEnv = new OllamaLlmProvider('ollama:m', { ...cfg, think: 'low', thinkFromEnv: true });
    expect(fromEnv.body({ ...req, effort: 'high' }).think).toBe('low');
  });
});

describe('usage line', () => {
  it('shows cached input and reasoning tokens when the provider reports them', () => {
    const m = new UsageMeter();
    m.add({ id: 'azure-openai:x', role: 'llm', inputTokens: 3000, outputTokens: 500, cachedInputTokens: 2048, reasoningTokens: 300 });
    m.add({ id: 'azure-openai:x', role: 'llm', inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 50 });
    expect(formatUsage(m.list())).toBe('usage: llm azure-openai:x 2 requests, 4,000 in (2,048 cached) / 600 out (350 reasoning) tokens');
  });
});
