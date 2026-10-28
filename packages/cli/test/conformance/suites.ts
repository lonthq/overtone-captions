import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageReport } from '../../src/providers/kit.js';
import { withSchemaValidation } from '../../src/providers/structured.js';
import { isRefusal, LlmFormatError, type AudioChunk, type LlmProvider, type LlmRequest, type TextProvider, type TimingProvider } from '../../src/providers/types.js';
import type { TimedWord } from '../../src/types.js';
import { tempDir } from '../tmp.js';

/**
 * The provider conformance kit: one suite per role that any provider can be run through, with recorded
 * responses instead of live calls. A provider supplies a harness: how to build it with a fake transport that
 * answers from a script of steps (HTTP responses, or runs of a fake binary), and where its requests carry the
 * prompt, language and audio. See docs/contributing/providers.md, "Conformance tests".
 *
 * `S` is one scripted step of the transport, `C` one captured request.
 */
export interface Built<P, C> { provider: P; requests: () => C[]; usage: UsageReport[] }

interface CommonHarness<S, C> {
  /** Shown in the test names, e.g. "openai (text)". */
  name: string;
  /** A failure the provider retries (429, 503). Leave out for providers without a retry layer (local binaries). */
  transient?: S;
  /** A failure that must not be retried (401, a crashing binary). */
  fatal: S;
  /** The secret the provider was built with; the fatal step echoes it, and no error may contain it. */
  secret?: string;
  /** Cases that must fail with a UserError (a missing binary, a bad setting), each building its own provider. */
  userErrors?: Array<{ name: string; run: () => Promise<unknown> }>;
  /** Language sent to the service for `requested` ('nl'), or undefined when it sent none. */
  languageOf(c: C): string | undefined;
}

export interface TextHarness<S, C> extends CommonHarness<S, C> {
  make(steps: S[]): Promise<Built<TextProvider, C>>;
  ok: S;
  expectedText: string;
  expectedLanguage?: string;
  promptOf(c: C): string | undefined;
  /** File name of the audio the request carried. */
  audioOf(c: C): string;
  /** Usage the provider reports for one `ok` call besides the audio seconds. */
  tokens?: { inputTokens?: number; outputTokens?: number };
  /** The provider returns word timings (`--timing same`). */
  wordTimings?: boolean;
  /**
   * The service takes no free-text prompt (ElevenLabs Scribe): the prompt checks are skipped. The glossary still
   * arrives as `keywords`; test that the provider sends it as the service's term list in the harness.
   */
  promptless?: boolean;
}

export interface TimingHarness<S, C> extends CommonHarness<S, C> {
  make(steps: S[]): Promise<Built<TimingProvider, C>>;
  ok: S;
  expectedSpeakers: number;
  expectedWords: number;
  /** The glossary terms the request carried. */
  phrasesOf(c: C): string;
  /**
   * Providers that make several requests per file (openai: words + diarization): the usage each successful
   * request reports besides id, role and audioSeconds, in order. Default `[{}]`: one request, audio seconds only.
   */
  usagePerFile?: Array<Record<string, number>>;
}

export interface LlmHarness<S, C> extends CommonHarness<S, C> {
  make(steps: S[]): Promise<Built<LlmProvider, C>>;
  reply(value: unknown): S;
  /** An answer cut off at the token limit. */
  truncated: S;
  /** An answer that is not JSON. */
  invalidJson: S;
  /** The model refuses. Leave out for services that have no refusal signal (Ollama: a refusal is just text). */
  refusal?: S;
  /** A content-filter block, for services that have one. */
  contentFilter?: S;
  /** The JSON schema the request asked for. */
  schemaOf(c: C): unknown;
  /** System and user prompt text, as sent. */
  promptsOf(c: C): { system: string; user: string };
  /** Usage reported for one `reply` call. */
  tokens: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
}

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Every rule a list of timed words must follow (the timing contract). Returns the speakers in order of first appearance. */
export function expectTimedWords(words: readonly TimedWord[], opts: { duration?: number } = {}): string[] {
  expect(words.length).toBeGreaterThan(0);
  const speakers: string[] = [];
  let prevStart = -Infinity;
  for (const [i, w] of words.entries()) {
    const at = `word ${i} ${JSON.stringify(w)}`;
    expect(typeof w.text, at).toBe('string');
    expect(w.text, at).toBe(w.text.trim());
    expect(w.text.length, at).toBeGreaterThan(0);
    expect(Number.isFinite(w.start) && Number.isFinite(w.end), at).toBe(true);
    expect(w.start, at).toBeGreaterThanOrEqual(0);
    expect(w.end, at).toBeGreaterThan(w.start);
    expect(w.start, `${at}: starts must not decrease`).toBeGreaterThanOrEqual(prevStart);
    if (opts.duration !== undefined) expect(w.end, at).toBeLessThanOrEqual(opts.duration + 0.5);
    prevStart = w.start;
    if (w.speaker !== undefined) {
      expect(w.speaker, at).toMatch(/^S[1-9]\d*$/);
      if (!speakers.includes(w.speaker)) {
        // S1, S2, … in order of first appearance
        expect(w.speaker, `${at}: speakers are numbered in order of appearance`).toBe(`S${speakers.length + 1}`);
        speakers.push(w.speaker);
      }
    }
    if (w.confidence !== undefined) {
      expect(w.confidence, at).toBeGreaterThanOrEqual(0);
      expect(w.confidence, at).toBeLessThanOrEqual(1);
    }
  }
  return speakers;
}

export function expectLanguageTag(language: string | undefined): void {
  if (language !== undefined) expect(language).toMatch(LANGUAGE_TAG);
}

async function audioChunks(): Promise<[AudioChunk, AudioChunk]> {
  const dir = await tempDir('overtone-conf-');
  const a = join(dir, 'chunk-0.mp3');
  const b = join(dir, 'chunk-1.mp3');
  await writeFile(a, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  await writeFile(b, Buffer.from([0xff, 0xfb, 0x90, 0x01]));
  return [{ path: a, index: 0, start: 0, end: 12.5 }, { path: b, index: 1, start: 12.5, end: 20 }];
}

/** A fake 18 s WAV file in a fresh temp folder. */
export async function wavFile(): Promise<{ path: string; duration: number }> {
  const dir = await tempDir('overtone-conf-');
  const path = join(dir, 'audio.wav');
  await writeFile(path, Buffer.from('RIFF0000WAVEfmt '));
  return { path, duration: 18 };
}

/** `calls`: requests one successful call makes (several requests may run in parallel and all fail at once). */
function errorSuite<S, C, P>(h: CommonHarness<S, C> & { make(steps: S[]): Promise<Built<P, C>> }, call: (p: P) => Promise<unknown>, ok: S, calls = 1): void {
  if (h.transient !== undefined) {
    it('retries a transient failure, then succeeds', async () => {
      const b = await h.make([h.transient!, ok]);
      await expect(call(b.provider)).resolves.toBeDefined();
      expect(b.requests()).toHaveLength(calls + 1);
    });
  }

  it('does not retry a fatal failure, and its error holds no secret', async () => {
    const b = await h.make([h.fatal]);
    const err = (await call(b.provider).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    if (calls === 1) expect(b.requests()).toHaveLength(1);
    else {
      expect(b.requests().length).toBeGreaterThanOrEqual(1);
      expect(b.requests().length).toBeLessThanOrEqual(calls);
    }
    if (h.secret) {
      expect(err.message).not.toContain(h.secret);
      expect(String(err.stack)).not.toContain(h.secret);
    }
  });

  for (const c of h.userErrors ?? []) {
    it(`fails with a UserError: ${c.name}`, async () => {
      await expect(c.run()).rejects.toMatchObject({ name: 'UserError' });
    });
  }
}

/** The text-role contract. */
export function textConformance<S, C>(h: TextHarness<S, C>): void {
  describe(`conformance: ${h.name}`, () => {
    it('returns the text (and the language, if the service reports one)', async () => {
      const [chunk] = await audioChunks();
      const b = await h.make([h.ok]);
      const res = await b.provider.transcribe(chunk, {});
      expect(res.text).toBe(h.expectedText);
      expect(res.language).toBe(h.expectedLanguage);
      expectLanguageTag(res.language);
    });

    it('sends the prompt and the language as given', async () => {
      const [chunk] = await audioChunks();
      const b = await h.make([h.ok]);
      await b.provider.transcribe(chunk, { language: 'nl', prompt: 'Ad for DriveCover.', keywords: ['DriveCover'] });
      const [req] = b.requests();
      if (!h.promptless) expect(h.promptOf(req!)).toBe('Ad for DriveCover.');
      expect(h.languageOf(req!)).toBe('nl');
    });

    it('sends no language when none is forced (the service detects it)', async () => {
      const [chunk] = await audioChunks();
      const b = await h.make([h.ok]);
      await b.provider.transcribe(chunk, {});
      expect([undefined, 'auto']).toContain(h.languageOf(b.requests()[0]!));
      if (!h.promptless) expect(h.promptOf(b.requests()[0]!)).toBeUndefined();
    });

    it('makes one call per chunk with that chunk\'s audio, and reports its seconds', async () => {
      const chunks = await audioChunks();
      const b = await h.make([h.ok, h.ok]);
      for (const c of chunks) await b.provider.transcribe(c, {});
      expect(b.requests().map((r) => h.audioOf(r))).toEqual(chunks.map((c) => basename(c.path)));
      expect(b.usage).toEqual(chunks.map((c) => ({ id: b.provider.id, role: 'text', audioSeconds: c.end - c.start, ...h.tokens })));
    });

    if (h.wordTimings) {
      it('returns word timings that follow the timing contract and spell the text', async () => {
        const [chunk] = await audioChunks();
        const b = await h.make([h.ok]);
        const res = await b.provider.transcribe(chunk, {});
        expectTimedWords(res.words ?? []);
        expect(res.words!.map((w) => w.text).join(' ')).toBe(res.text);
      });
    }

    errorSuite(h, async (p) => p.transcribe((await audioChunks())[0], {}), h.ok);
  });
}

/** The timing-role contract. */
export function timingConformance<S, C>(h: TimingHarness<S, C>): void {
  describe(`conformance: ${h.name}`, () => {
    it('returns timed words: monotonic starts, start < end, speakers S1, S2, … in order', async () => {
      const wav = await wavFile();
      const b = await h.make([h.ok]);
      const res = await b.provider.align(wav, {});
      expect(res.words).toHaveLength(h.expectedWords);
      expect(expectTimedWords(res.words, { duration: wav.duration })).toHaveLength(h.expectedSpeakers);
      expectLanguageTag(res.language);
    });

    it('sends the language and the glossary', async () => {
      const wav = await wavFile();
      const b = await h.make([h.ok]);
      await b.provider.align(wav, { language: 'nl', phrases: ['DriveCover', 'Lumora'] });
      const [req] = b.requests();
      expect(h.languageOf(req!)).toMatch(/^nl\b/);
      expect(h.phrasesOf(req!)).toContain('DriveCover');
      expect(h.phrasesOf(req!)).toContain('Lumora');
    });

    it('reports the audio seconds of the file', async () => {
      const wav = await wavFile();
      const b = await h.make([h.ok]);
      await b.provider.align(wav, {});
      expect(b.usage).toEqual((h.usagePerFile ?? [{}]).map((extra) => ({ id: b.provider.id, role: 'timing', audioSeconds: wav.duration, ...extra })));
    });

    errorSuite(h, async (p) => p.align(await wavFile(), {}), h.ok, h.usagePerFile?.length ?? 1);
  });
}

const SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { first: { type: 'integer' }, last: { type: 'integer' }, to: { type: 'string' }, reason: { type: 'string', enum: ['brand', 'spelling'] } },
        required: ['first', 'last', 'to', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['edits'],
  additionalProperties: false,
};
const REQUEST: LlmRequest = { name: 'corrections', system: 'You fix transcripts.', user: 'Words: 0 Hi 1 Maja', schema: SCHEMA };
const VALID = { edits: [{ first: 3, last: 3, to: 'Maya!', reason: 'brand' }] };

/** The llm-role contract. */
export function llmConformance<S, C>(h: LlmHarness<S, C>): void {
  describe(`conformance: ${h.name}`, () => {
    it('sends the prompts and the schema, and parses the structured answer', async () => {
      const b = await h.make([h.reply(VALID)]);
      expect(await b.provider.complete(REQUEST)).toEqual(VALID);
      const [req] = b.requests();
      expect(h.schemaOf(req!)).toEqual(SCHEMA);
      const { system, user } = h.promptsOf(req!);
      expect(system).toContain(REQUEST.system);
      expect(user).toBe(REQUEST.user);
    });

    it('reports token usage', async () => {
      const b = await h.make([h.reply(VALID)]);
      await b.provider.complete(REQUEST);
      expect(b.usage).toEqual([{ id: b.provider.id, role: 'llm', ...h.tokens }]);
    });

    it('a cut-off answer is an LlmFormatError with truncated = true', async () => {
      const b = await h.make([h.truncated]);
      const err = await b.provider.complete(REQUEST).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmFormatError);
      expect(err).toMatchObject({ truncated: true });
    });

    it('an answer that is not JSON is an LlmFormatError with truncated = false', async () => {
      const b = await h.make([h.invalidJson]);
      const err = await b.provider.complete(REQUEST).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmFormatError);
      expect(err).toMatchObject({ truncated: false });
    });

    if (h.refusal !== undefined) {
      it('a refusal is a RefusalError by the model (not retried as a format error) that says so', async () => {
        const b = await h.make([h.refusal!]);
        const err = await b.provider.complete(REQUEST).catch((e: unknown) => e);
        expect(isRefusal(err)).toBe(true);
        expect(err).toMatchObject({ by: 'model', provider: b.provider.id });
        expect(err).not.toBeInstanceOf(LlmFormatError);
        expect((err as Error).message).toMatch(/refus|declin/i);
      });
    }

    if (h.contentFilter !== undefined) {
      it('a content-filter block is a RefusalError by the content filter that says so', async () => {
        const b = await h.make([h.contentFilter!]);
        const err = await b.provider.complete(REQUEST).catch((e: unknown) => e);
        expect(isRefusal(err)).toBe(true);
        expect(err).toMatchObject({ by: 'content filter', provider: b.provider.id });
        expect(err).not.toBeInstanceOf(LlmFormatError);
        expect((err as Error).message).toMatch(/content filter/i);
      });
    }

    it('with withSchemaValidation: a schema mismatch is retried once with the issues appended', async () => {
      const b = await h.make([h.reply({ edits: [{ first: 'three' }] }), h.reply(VALID)]);
      expect(await withSchemaValidation(b.provider).complete(REQUEST)).toEqual(VALID);
      const reqs = b.requests();
      expect(reqs).toHaveLength(2);
      expect(h.promptsOf(reqs[1]!).user).toMatch(/previous answer was invalid: .*\$\.edits\[0\]\.first: expected integer/);
    });

    it('with withSchemaValidation: a cut-off answer stops at once', async () => {
      const b = await h.make([h.truncated]);
      await expect(withSchemaValidation(b.provider).complete(REQUEST)).rejects.toThrow(/token limit/);
      expect(b.requests()).toHaveLength(1);
    });

    errorSuite(h, (p) => p.complete(REQUEST), h.reply(VALID));
  });
}
