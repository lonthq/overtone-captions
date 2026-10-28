import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TimedWord } from '../types.js';
import { mapFastTranscription, type FastTranscriptionResponse } from './azure-speech.js';
import { defineProvider, type ProviderDescriptor } from './kit.js';
import type { AudioChunk, AudioFile, LlmProvider, LlmRequest, TextProvider, TimingProvider } from './types.js';

/**
 * Replays recorded responses from a directory (tests and demos, no keys):
 * - `text.json`:   { "chunks": [ { "text": "…", "language": "en" } ] }  (by chunk index)
 * - `timing.json`: a raw Azure Fast Transcription response
 * - `llm.json`:    { "<schema name>": [ response1, response2, … ] }  (in order; the last repeats)
 */
export class RecordedProvider implements TextProvider, TimingProvider, LlmProvider {
  readonly id: string;
  /** Free, and LLM answers are consumed in order. */
  readonly uncached = true;
  private readonly calls = new Map<string, number>();

  /** `id`: `deps.id` (`recorded:<folder as selected>`); default `recorded:<dir>`. */
  constructor(private readonly dir: string, id = `recorded:${dir}`) {
    this.id = id;
  }

  private async load<T>(name: string): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T;
    } catch (err) {
      throw new Error(`recorded provider: cannot read ${join(this.dir, name)}: ${(err as Error).message}`);
    }
  }

  async transcribe(audio: AudioChunk): Promise<{ text: string; language?: string }> {
    const { chunks } = await this.load<{ chunks: Array<{ text: string; language?: string }> }>('text.json');
    const chunk = chunks[audio.index];
    if (!chunk) throw new Error(`recorded provider: text.json has no chunk ${audio.index}`);
    return chunk;
  }

  async align(_audio: AudioFile): Promise<{ words: TimedWord[]; language?: string }> {
    return mapFastTranscription(await this.load<FastTranscriptionResponse>('timing.json'));
  }

  async complete<T>(req: LlmRequest): Promise<T> {
    const all = await this.load<Record<string, unknown[]>>('llm.json');
    const list = Object.hasOwn(all, req.name) ? all[req.name] : undefined;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`recorded provider: llm.json has no responses for "${req.name}"`);
    const n = this.calls.get(req.name) ?? 0;
    this.calls.set(req.name, n + 1);
    return list[Math.min(n, list.length - 1)] as T;
  }
}

/** One instance per directory serves every role. */
export const recordedProvider: ProviderDescriptor = defineProvider({
  id: 'recorded',
  description: 'replays recorded responses from a directory (tests and demos; no keys, no network)',
  roles: ['text', 'timing', 'llm'],
  env: [],
  defaults: {},
  modelHint: 'a directory of recorded responses, e.g. recorded:examples/fixtures/recorded/sample',
  shareKey: (model, deps) => resolve(deps.cwd, model),
  create: (_env, model, deps) => new RecordedProvider(resolve(deps.cwd, model), deps.id),
});
