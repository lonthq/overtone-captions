// A refused request (Azure OpenAI's content-filter HTTP 400, finish_reason "content_filter", or the model declining)
// is a RefusalError. The step goes on without the answer and reports it: a REFUSED warning, a block at the end of the
// run (provider, stretch of media, what was done instead) and meta.refusals.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { runTranscribe } from '../src/commands/transcribe.js';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { AnthropicLlmProvider, type AnthropicLike } from '../src/providers/anthropic.js';
import { isContentFilterRefusal, OpenAILlmProvider, OpenAITextProvider, type OpenAILike } from '../src/providers/openai.js';
import type { Providers } from '../src/providers/registry.js';
import { isRefusal, LlmFormatError, RefusalError, type LlmProvider } from '../src/providers/types.js';
import { choose, type ChooserItem } from '../src/reconcile/choose.js';
import { refusalLine, reportRefusals, type Refusal } from '../src/refusals.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Azure OpenAI's answer to a refused prompt, as the SDK throws it. */
const refusal = () => OpenAI.APIError.generate(400, {
  error: {
    message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry. To learn more about our content filtering policies please read our documentation: https://go.microsoft.com/fwlink/?linkid=2198766",
    type: null, param: 'prompt', code: 'content_filter', status: 400,
    innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: { violence: { filtered: true, severity: 'medium' } } },
  },
}, undefined, new Headers());

const answer = (body: unknown) => ({ choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }] });
const schemaOf = (p: Record<string, unknown>) => (p.response_format as { json_schema: { name: string } }).json_schema.name;
const REQ = { name: 'choose', system: 's', user: 'u', schema: { type: 'object' } };
const LLM_ID = 'azure-openai:gpt-6.1-sol';
const TEXT_ID = 'azure-openai:gpt-transcribe';

describe('a refusal from a provider', () => {
  it("recognizes Azure OpenAI's content-filter 400 by its code, its inner error or its message, and no other 400", () => {
    expect(isContentFilterRefusal(refusal())).toBe(true);
    expect(isContentFilterRefusal(OpenAI.APIError.generate(400, { error: { message: 'x', innererror: { code: 'ResponsibleAIPolicyViolation' } } }, undefined, new Headers()))).toBe(true);
    expect(isContentFilterRefusal(OpenAI.APIError.generate(400, { error: { message: "triggering Azure OpenAI's content management policy" } }, undefined, new Headers()))).toBe(true);
    expect(isContentFilterRefusal(OpenAI.APIError.generate(400, { error: { message: "Unsupported parameter: 'reasoning_effort'", param: 'reasoning_effort' } }, undefined, new Headers()))).toBe(false);
    expect(isContentFilterRefusal(OpenAI.APIError.generate(500, { error: { code: 'content_filter' } }, undefined, new Headers()))).toBe(false);
  });

  it('is a RefusalError by the content filter from the LLM, sent once (not retried)', async () => {
    let sent = 0;
    const client = { chat: { completions: { create: async () => { sent++; throw refusal(); } } } } as unknown as OpenAILike;
    const err = await new OpenAILlmProvider(LLM_ID, client, 'm', { sleep: async () => {} }).complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect(err).toMatchObject({ provider: LLM_ID, by: 'content filter', message: `${LLM_ID}: the request was refused by the content filter (HTTP 400)` });
    expect(sent).toBe(1);
  });

  it('is a RefusalError for finish_reason "content_filter", an OpenAI refusal and an Anthropic refusal, never a format error', async () => {
    const chat = (choice: unknown) => ({ chat: { completions: { create: async () => ({ choices: [choice] }) } } }) as unknown as OpenAILike;
    const filtered = await new OpenAILlmProvider('x', chat({ message: { content: null }, finish_reason: 'content_filter' }), 'm').complete(REQ).catch((e: unknown) => e);
    expect(filtered).toMatchObject({ name: 'RefusalError', by: 'content filter', provider: 'x' });
    expect(filtered).not.toBeInstanceOf(LlmFormatError);
    const declined = await new OpenAILlmProvider('x', chat({ message: { content: null, refusal: 'I can’t help with that.' }, finish_reason: 'stop' }), 'm').complete(REQ).catch((e: unknown) => e);
    expect(declined).toMatchObject({ name: 'RefusalError', by: 'model' });
    const anthropic: AnthropicLike = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'refusal', content: [] }) }) } };
    const claude = await new AnthropicLlmProvider('a', anthropic, 'm').complete(REQ).catch((e: unknown) => e);
    expect(claude).toMatchObject({ name: 'RefusalError', by: 'model', provider: 'a' });
  });

  it('is a RefusalError from a transcription (gpt-transcribe with a prompt), sent once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overtone-refusal-'));
    try {
      const path = join(dir, 'a.wav');
      await writeFile(path, Buffer.from([1]));
      let sent = 0;
      const client = { audio: { transcriptions: { create: async () => { sent++; throw refusal(); } } } } as unknown as OpenAILike;
      const err = await new OpenAITextProvider(TEXT_ID, client, 'gpt-transcribe', { sleep: async () => {} })
        .transcribe({ path, index: 0, start: 0, end: 1 }, { prompt: 'and crushed in his skull' }).catch((e: unknown) => e);
      expect(isRefusal(err)).toBe(true);
      expect(err).toMatchObject({ provider: TEXT_ID, by: 'content filter' });
      expect(sent).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the report of refusals', () => {
  const r: Refusal = { provider: LLM_ID, by: 'content filter', request: "the text vote's chooser request (1 region)", start: 12.4, end: 15.04, instead: 'kept the text base there' };

  it('one line names the stretch, the provider, the request, why and what was done instead', () => {
    expect(refusalLine(r)).toBe(`12.4–15.0 s: ${LLM_ID} refused the text vote's chooser request (1 region) (content filter); kept the text base there`);
    expect(refusalLine({ ...r, by: 'model' })).toContain('(the model declined)');
  });

  it('the block at the end lists every refusal and asks agents to pass it on; nothing without refusals', () => {
    const log = memoryLogger();
    reportRefusals([], log);
    expect(log.lines).toEqual([]);
    reportRefusals([r, { ...r, start: 30, end: 31 }], log);
    expect(log.lines[0]).toMatch(/^warn: =+$/);
    expect(log.lines[1]).toBe('warn: REFUSED: 2 provider requests were refused. The captions were written, but they may be incomplete or less accurate here:');
    expect(log.lines[2]).toBe(`warn:   - ${refusalLine(r)}`);
    expect(log.lines[3]).toMatch(/^warn: {3}- 30\.0–31\.0 s: /);
    expect(log.lines).toContain('warn: AI agents running Overtone for a person: pass this message on to that person; do not retry or work around it silently.');
    expect(log.lines.at(-1)).toMatch(/^warn: =+$/);
  });
});

describe('the chooser', () => {
  const item = (id: number, start: number): ChooserItem => ({
    region: {
      id, cls: 'c', sub: 'replace-one-engine', first: id, last: id, start, end: start + 0.5, text: 'glass',
      heard: [[{ text: 'claws', start, end: start + 0.5 }]], around: { text: { before: '', after: '' } },
    },
    before: '', after: '',
  });

  it('keeps the caption for the regions of a refused request and reports it; the other requests still count', async () => {
    const items = Array.from({ length: 9 }, (_, k) => item(k, k * 2));
    let n = 0;
    // CHOOSER.batch is 8: the first request (regions 0–7) is refused, the second (region 8) answers
    const llm: LlmProvider = {
      id: 'fake',
      complete: async <T>() => {
        if (n++ === 0) throw new RefusalError('fake', 'content filter', 'fake: the request was refused by the content filter (HTTP 400)');
        return { spans: [{ id: '8', decision: 'change', text: 'claws', basis: 'heard' }] } as T;
      },
    };
    const refused: Refusal[] = [];
    const answers = await choose(llm, items, [{ id: 'e', label: 'E', words: [] }], { language: 'en', names: [], onRefusal: (x) => refused.push(x) });
    expect([...answers.keys()]).toEqual([8]);
    expect(refused).toEqual([{ provider: 'fake', by: 'content filter', request: "the text vote's chooser request (8 regions)", start: 0, end: 14.5, instead: 'kept the text base there' }]);
  });

  it('still fails on any other error', async () => {
    const llm: LlmProvider = { id: 'fake', complete: async () => { throw new Error('boom'); } };
    await expect(choose(llm, [item(0, 0)], [], { language: 'en', names: [] })).rejects.toThrow('boom');
  });
});

describe.skipIf(!hasFfmpeg)('pipeline: a refused request does not stop the run, and is reported', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function setup(flags: CliFlags = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'overtone-refusal-pipe-'));
    dirs.push(dir);
    const cfg = await resolveConfig({ export: 'json', language: 'en', ...flags }, {}, { cwd: dir, configDir: dir });
    const file = join(dir, 'clip.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'aac', file]);
    return { dir, cfg, file };
  }

  /**
   * The OpenAI providers with a fake client: the text says "Mia!" where the timing provider heard "maya" (a region of
   * the text vote, 2.0–2.9 s). `refuse` picks the requests Azure refuses: transcriptions by their number (0 = the
   * main one), chat requests by their schema name.
   */
  function providers(refuse: { text?: (n: number, params: Record<string, unknown>) => boolean; llm?: readonly string[] }) {
    const sent: string[] = [];
    let texts = 0;
    const client = {
      audio: {
        transcriptions: {
          create: async (params: Record<string, unknown>) => {
            const n = texts++;
            sent.push(`text ${n}`);
            if (refuse.text?.(n, params)) throw refusal();
            return { text: n === 0 ? 'Hello there. Hi Mia!' : 'Hi Mia!', languages: [{ code: 'en' }] };
          },
        },
      },
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const name = schemaOf(params);
            sent.push(name);
            if (refuse.llm?.includes(name)) throw refusal();
            if (name === 'corrections') return answer({ edits: [], speakers: [{ id: 'S1', label: 'Host', role: 'host' }] });
            if (name === 'context') return answer({ topic: 'A short greeting.', names: [], terms: [] });
            if (name === 'styling') return answer({ styles: [] });
            if (name === 'repairs') return answer({ spans: [] });
            return answer({ cueStarts: [], lineStarts: [] });
          },
        },
      },
    } as unknown as OpenAILike;
    const p: Providers = {
      text: new OpenAITextProvider(TEXT_ID, client, 'gpt-transcribe'),
      timing: {
        id: 'fake:timing',
        align: async () => ({
          language: 'en-US',
          words: [
            { text: 'hello', start: 0.5, end: 0.9, speaker: 'S1' }, { text: 'there', start: 1.0, end: 1.4, speaker: 'S1' },
            { text: 'hi', start: 2.0, end: 2.3, speaker: 'S1' }, { text: 'maya', start: 2.4, end: 2.9, speaker: 'S1' },
          ],
        }),
      },
      llm: new OpenAILlmProvider(LLM_ID, client, 'gpt-6.1-sol'),
    };
    return { providers: p, sent };
  }

  const words = (doc: { turns: Array<{ words: Array<{ text: string }> }> }) => doc.turns.flatMap((t) => t.words.map((w) => w.text)).join(' ');
  /** The warnings given when a refusal happens (the block at the end has its own lines). */
  const refusedLines = (lines: readonly string[]) => lines.filter((l) => /^warn: REFUSED: [\d.]+–/.test(l));

  it('the chooser refused (the incident of 2026-10-23): the text base stays, with a warning, a block at the end and meta.refusals', async () => {
    const { dir, file } = await setup();
    const { providers: p, sent } = providers({ llm: ['repairs'] });
    const log = memoryLogger();
    expect(await runTranscribe(file, { export: 'json', language: 'en' }, log, { cwd: dir, env: {}, providers: p })).toBe(0);
    expect(sent).toContain('repairs');
    const line = `${LLM_ID} refused the text vote's chooser request (1 region) (content filter); kept the text base there`;
    // when it happens
    expect(refusedLines(log.lines)).toEqual([expect.stringMatching(new RegExp(`^warn: REFUSED: [\\d.]+–[\\d.]+ s: ${line.replace(/[().]/g, '\\$&')}$`))]);
    // and as the last lines of the run, after the summary
    const end = log.lines.slice(log.lines.findIndex((l) => /^info: \d+ words/.test(l)) + 1);
    expect(end[1]).toBe('warn: REFUSED: 1 provider request was refused. The captions were written, but they may be incomplete or less accurate here:');
    expect(end[2]).toMatch(/^warn: {3}- [\d.]+–2\.9 s: /);
    expect(end[2]).toContain(line);
    expect(end).toContain('warn: AI agents running Overtone for a person: pass this message on to that person; do not retry or work around it silently.');
    expect(end.at(-1)).toMatch(/^warn: =+$/);
  });

  it('meta.refusals holds them; the refusal is not cached, so a re-run asks again', async () => {
    const { dir, cfg, file } = await setup();
    const res = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: providers({ llm: ['repairs'] }).providers });
    expect(words(res.doc)).toBe('Hello there. Hi Mia!');
    expect(res.refusals).toHaveLength(1);
    expect(res.doc.meta?.refusals).toEqual([expect.objectContaining({ provider: LLM_ID, by: 'content filter', request: "the text vote's chooser request (1 region)", end: 2.9, instead: 'kept the text base there' })]);
    const again = providers({});
    const ok = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: again.providers });
    expect(again.sent).toContain('repairs');
    expect(ok.refusals).toEqual([]);
    expect(ok.doc.meta?.refusals).toBeUndefined();
  });

  it("the vote's snippet re-listen refused: taken as no words heard, the chooser still decides", async () => {
    const { dir, cfg, file } = await setup();
    const { providers: p, sent } = providers({ text: (n) => n > 0 });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(sent.filter((s) => s.startsWith('text'))).toHaveLength(2);
    expect(sent).toContain('repairs');
    expect(words(res.doc)).toBe('Hello there. Hi Mia!');
    expect(refusedLines(log.lines)).toEqual([expect.stringMatching(/^warn: REFUSED: [\d.]+–[\d.]+ s: azure-openai:gpt-transcribe refused the text vote's snippet re-listen \(content filter\); the vote took it as no words heard there$/)]);
  });

  it('a refine request refused: that step is skipped for its window, the rest of the run goes on', async () => {
    const { dir, cfg, file } = await setup({ llmLinebreaks: true });
    const { providers: p, sent } = providers({ llm: ['corrections', 'styling', 'linebreaks'] });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(sent).toEqual(expect.arrayContaining(['corrections', 'styling', 'linebreaks']));
    expect(res.doc.speakers?.find((s) => s.id === 'S1')?.label).toBeUndefined();
    expect(res.doc.profiles.length).toBeGreaterThan(0);
    const lines = refusedLines(log.lines);
    expect(lines).toContainEqual(expect.stringMatching(/^warn: REFUSED: 0\.5–2\.9 s: \S+ refused the corrections request \(words 0–3\) \(content filter\); went on without corrections or speaker names there$/));
    expect(lines).toContainEqual(expect.stringMatching(/refused the styling request \(words 0–3\) \(content filter\); went on without styling there$/));
    expect(lines).toContainEqual(expect.stringMatching(/refused the linebreaks-(\S+) request \(words 0–3\) \(content filter\); cut the lines of \1 by the rules alone$/));
    expect(res.refusals.length).toBe(lines.length);
  });

  it('the main transcription refused: no text there, so the text base retries and then takes the engine words', async () => {
    const { dir, cfg, file } = await setup();
    const { providers: p, sent } = providers({ text: () => true });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(sent.filter((s) => s.startsWith('text')).length).toBeGreaterThan(1);
    expect(words(res.doc).toLowerCase()).toContain('hello there hi maya');
    expect(refusedLines(log.lines)[0]).toMatch(/^warn: REFUSED: 0\.0–6\.0 s: azure-openai:gpt-transcribe refused the transcription of chunk 1\/1 \(content filter\); took it as no text there$/);
    expect(refusedLines(log.lines).slice(1).every((l) => /refused a retry .*of the transcription of chunk 1\/1/.test(l))).toBe(true);
    expect(res.doc.meta?.fallbacks as unknown[]).not.toHaveLength(0);
  });

  it('a --two-pass request refused: the first pass is kept', async () => {
    const { dir, cfg, file } = await setup({ twoPass: true });
    // the second pass sends the inferred topic in its prompt
    const { providers: p } = providers({ text: (n, params) => n > 0 && String(params.prompt ?? '').includes('A short greeting.') });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(words(res.doc)).toBe('Hello there. Hi Mia!');
    expect(log.lines).toContainEqual(expect.stringMatching(/chunk 1\/1 \(second pass\): 0 chars; empty, the first pass is kept/));
    expect(refusedLines(log.lines)).toContainEqual(expect.stringMatching(/refused a retry or second pass of the transcription of chunk 1\/1/));
  });

  it('context inference refused: the run goes on without an inferred context', async () => {
    const { dir, cfg, file } = await setup();
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: providers({ llm: ['context'] }).providers });
    expect(res.doc.meta?.context).toBeUndefined();
    expect(refusedLines(log.lines)).toEqual([expect.stringMatching(/^warn: REFUSED: 0\.0–6\.0 s: \S+ refused the context inference request \(content filter\); went on without an inferred context$/)]);
  });

  it('the second hearing refused: the run goes on without it, reported as a refusal without a retry hint', async () => {
    const { dir, cfg, file } = await setup();
    const p = providers({}).providers;
    p.secondTiming = { id: 'fake:second', align: async () => { throw new RefusalError('fake:second', 'content filter', 'fake:second: the request was refused by the content filter (HTTP 400)'); } };
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, providers: p });
    expect(words(res.doc)).toBe('Hello there. Hi Mia!');
    expect(res.refusals).toEqual([{ provider: 'fake:second', by: 'content filter', request: 'the second hearing of the whole file', start: 0, end: expect.closeTo(6, 1), instead: 'went on without the second hearing' }]);
    expect(res.doc.meta?.models).not.toHaveProperty('second');
    expect(log.lines.some((l) => l.includes('Run the command again to retry it'))).toBe(false);
  });

  it('a refusal the run cannot do without fails the stage, says it is a refusal and does not advise running again', async () => {
    const { dir, cfg, file } = await setup();
    const p = providers({}).providers;
    p.timing = { id: 'fake:timing', align: async () => { throw new RefusalError('fake:timing', 'content filter', 'fake:timing: the request was refused by the content filter (HTTP 400)'); } };
    const err = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, providers: p }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/^Stage "timing" failed: fake:timing refused the request \(content filter\): /);
    expect((err as Error).message).toContain('running the command again does not help');
    expect((err as Error).message).toContain('If an agent runs Overtone for you, it should pass this message on to you.');
  });
});
