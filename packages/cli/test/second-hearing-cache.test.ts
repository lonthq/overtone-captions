import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import type { ExtractResult } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { ImplausibleTranscriptError } from '../src/providers/elevenlabs.js';
import type { Providers } from '../src/providers/registry.js';
import type { AudioFile, LlmRequest } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const WORDS = ['hello', 'there', 'this', 'is', 'a', 'test'];
const timed: TimedWord[] = WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5, speaker: 'S1' }));

describe('the whole-file second hearing', () => {
  it('does not cache "no plausible transcript": a later run asks the service again', async () => {
    const dir = await tempDir('overtone-second-');
    const media = join(dir, 'clip.mp4');
    await writeFile(media, 'not really media'); // created by the test, never committed
    const wav = join(dir, 'audio.wav');
    await writeFile(wav, 'fake wav bytes'); // a readable file, so the request cache keys it by its bytes
    const cfg = await resolveConfig({ export: 'json', context: 'A test.', language: 'en', llmLinebreaks: false }, {}, { cwd: dir, configDir: dir });
    const wholeFile: AudioFile[] = [];
    let timingCalls = 0;
    const providers: Providers = {
      text: { id: 'fake:text', transcribe: async () => ({ text: 'Hello there, this is a test.', language: 'en' }) },
      timing: { id: 'fake:timing', align: async () => { timingCalls++; return { words: timed }; } },
      secondTiming: {
        id: 'fake:second',
        align: async (audio) => {
          if (audio.path === wav) wholeFile.push(audio);
          throw new ImplausibleTranscriptError('ElevenLabs Scribe returned no plausible transcript for audio.wav, twice');
        },
      },
      llm: {
        id: 'fake:llm',
        async complete<T>(req: LlmRequest): Promise<T> {
          if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
          if (req.name === 'styling') return { styles: [] } as T;
          return { cueStarts: [], lineStarts: [] } as T;
        },
      },
    };
    const extractAudio = async (): Promise<ExtractResult> => ({ duration: 4, wav, chunks: [{ path: wav, index: 0, start: 0, end: 4 }] });
    const deps = { cwd: dir, providers, extractAudio, checkBinaries: async () => [], probeDuration: async () => 4, probeVideo: async () => undefined };
    await runPipeline(media, cfg, { ...deps, log: memoryLogger() });
    const log = memoryLogger();
    await runPipeline(media, cfg, { ...deps, log });
    // the timing provider's answer comes from the cache; the second hearing's fault does not
    expect(timingCalls).toBe(1);
    expect(wholeFile).toHaveLength(2);
    expect(log.lines).toContain('info:   fake:second returned no plausible transcript for the file; taking it as no words heard');
  });
});
