import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log.js';
import { OpenAILlmProvider, type OpenAILike } from '../src/providers/openai.js';
import { HttpError } from '../src/util/retry.js';

describe('OpenAILlmProvider: a model that rejects reasoning_effort', () => {
  it('retries every concurrent request without it, not only the first one to fail', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let waiting: Array<() => void> = [];
    const client = {
      audio: { transcriptions: { create: async () => ({}) } },
      chat: {
        completions: {
          create: async (p: Record<string, unknown>) => {
            calls.push(p);
            if ('reasoning_effort' in p) {
              // hold the rejections until all three requests were sent with the effort
              await new Promise<void>((done) => { waiting.push(done); if (waiting.length === 3) { waiting.forEach((w) => w()); waiting = []; } });
              throw new HttpError(400, "400 Unsupported parameter: 'reasoning_effort' is not supported with this model.");
            }
            return { choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] };
          },
        },
      },
    } as unknown as OpenAILike;
    const log = memoryLogger();
    const p = new OpenAILlmProvider('openai:gpt-4.1', client, 'gpt-4.1', {}, { reasoningEffort: true, log });
    const req = { name: 'corrections', system: 's', user: 'u', schema: { type: 'object' }, effort: 'low' as const };
    expect(await Promise.all([p.complete(req), p.complete(req), p.complete(req)])).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
    expect(calls.map((c) => 'reasoning_effort' in c)).toEqual([true, true, true, false, false, false]);
    expect(log.lines).toEqual(['info:   openai:gpt-4.1 takes no reasoning_effort (a model without reasoning); sending its requests without it']);
  });
});
