import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModelSpec } from '../src/config.js';
import { run, WAV_ARGS } from '../src/media/extract.js';
import type { Usage } from '../src/providers/kit.js';
import {
  fromWhisperLanguage,
  glossaryPrompt,
  mergeSpeakers,
  OpenAITextProvider,
  OpenAITimingProvider,
  parseTimingModel,
  whisperWords,
  type OpenAILike,
} from '../src/providers/openai.js';
import { resolveSelection, resolveSelections } from '../src/providers/registry.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const spec = parseModelSpec;

/** A fake client: `answer` gives the response per request (by its params). */
function fakeClient(answer: (p: Record<string, unknown>) => unknown): OpenAILike & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    audio: { transcriptions: { create: async (p) => { calls.push(p); return answer(p); } } },
    chat: { completions: { create: async () => { throw new Error('no chat'); } } },
  };
}

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe('timing model part', () => {
  it.each([
    ['openai', 'openai:whisper-1+gpt-4o-transcribe-diarize'],
    ['openai:diarize', 'openai:whisper-1+gpt-4o-transcribe-diarize'],
    ['openai:WORDS', 'openai:whisper-1'],
    ['openai:whisper-1', 'openai:whisper-1'],
    ['openai:my-whisper+my-diarizer', 'openai:my-whisper+my-diarizer'],
  ])('%s → %s', (input, id) => {
    expect(resolveSelection(spec(input), 'timing').id).toBe(id);
  });

  it.each(['a+b+c', 'whisper-1+', '+x', 'bad model'])('rejects "%s"', (m) => {
    expect(() => parseTimingModel(m)).toThrow(/Invalid OpenAI timing model/);
  });

  it('--text openai:whisper-1 --timing same resolves; gpt-transcribe has no word timings', () => {
    const sel = resolveSelections({ text: spec('openai:whisper-1'), timing: spec('same'), llm: spec('openai') });
    expect(sel.timing).toMatchObject({ id: 'openai:whisper-1', same: true });
    expect(() => resolveSelections({ text: spec('openai'), timing: spec('same'), llm: spec('openai') })).toThrow(/no word timings/);
  });
});

describe('whisperWords', () => {
  it('puts back punctuation and casing from the text, keeps words without a match, enforces start < end', () => {
    const words = whisperWords({
      text: 'Hello, world. It costs €12 — really!',
      words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'world', start: 0.4, end: 0.4 }, { word: 'It', start: 1, end: 1.2 }, { word: 'costs', start: 1.2, end: 1.5 }, { word: '12', start: 1.5, end: 1.9 }, { word: 'really', start: 2, end: 2.4 }, { word: ' ', start: 3, end: 3 }],
    });
    expect(words.map((x) => x.text)).toEqual(['Hello,', 'world.', 'It', 'costs', '€12', 'really!']);
    expect(words[1]).toEqual({ text: 'world.', start: 0.4, end: 0.41 });
  });

  it('maps whisper language names to codes', () => {
    expect(fromWhisperLanguage('english')).toBe('en');
    expect(fromWhisperLanguage('Dutch')).toBe('nl');
    expect(fromWhisperLanguage('nl')).toBe('nl');
    expect(fromWhisperLanguage('klingon')).toBeUndefined();
  });

  it('glossary prompt: deduplicated, cut to whisper-1\'s prompt limit', () => {
    expect(glossaryPrompt(['DriveCover', ' Lumora ', 'DriveCover'])).toBe('Glossary: DriveCover, Lumora.');
    expect(glossaryPrompt([])).toBeUndefined();
    expect(glossaryPrompt(Array.from({ length: 200 }, (_, i) => `term number ${i}`))!.length).toBeLessThanOrEqual(620);
  });
});

describe('mergeSpeakers', () => {
  it('takes the most-overlapping span, else the nearest one, and numbers speakers in order of appearance', () => {
    const spans = [{ speaker: 'B', start: 0, end: 2 }, { speaker: 'A', start: 2.2, end: 4 }, { speaker: 'B', start: 6, end: 7 }];
    const out = mergeSpeakers([w('one', 0.1, 0.5), w('two', 1.9, 2.5), w('gap', 4.5, 4.8), w('late', 5.6, 5.9), w('three', 6.2, 6.5)], spans);
    // "two" overlaps B by 0.1 s and A by 0.3 s → A; "gap" is 0.5 s from A, 1.2 s from B → A; "late" is nearest B
    expect(out.map((x) => x.speaker)).toEqual(['S1', 'S2', 'S2', 'S1', 'S1']);
  });

  it('no spans: everyone is S1', () => {
    expect(mergeSpeakers([w('a', 0, 1)], []).map((x) => x.speaker)).toEqual(['S1']);
  });
});

describe('OpenAITimingProvider', () => {
  const verbose = { text: 'Hi there. Yes.', language: 'english', words: [{ word: 'Hi', start: 0.1, end: 0.3 }, { word: 'there', start: 0.3, end: 0.6 }, { word: 'Yes', start: 1.2, end: 1.5 }] };
  const diarized = { segments: [{ speaker: 'A', start: 0, end: 0.7 }, { speaker: 'B', start: 1.1, end: 1.6 }], usage: { input_tokens: 10, output_tokens: 20 } };
  const answer = (p: Record<string, unknown>) => (p.model === 'whisper-1' ? verbose : diarized);

  async function fakeWav(): Promise<string> {
    const dir = await tempDir('overtone-oai-');
    const path = join(dir, 'audio.wav');
    await writeFile(path, Buffer.from('RIFF0000WAVEfmt '));
    return path;
  }

  it('words mode: one request, every word S1, no diarization', async () => {
    const client = fakeClient(answer);
    const usage: Usage[] = [];
    const p = new OpenAITimingProvider('openai:whisper-1', client, { words: 'whisper-1', usage: (u) => usage.push(u) });
    const res = await p.align({ path: await fakeWav(), duration: 2 }, { language: 'nl-BE' });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ language: 'nl' });
    expect(res.words.map((x) => `${x.text}/${x.speaker}`)).toEqual(['Hi/S1', 'there./S1', 'Yes./S1']);
    expect(res.language).toBe('nl');
    expect(usage).toEqual([{ audioSeconds: 2 }]);
  });

  it('a failed diarization still reports the billed words request, then throws', async () => {
    const client = fakeClient((p) => { if (p.model !== 'whisper-1') throw Object.assign(new Error('bad request'), { status: 400 }); return verbose; });
    const usage: Usage[] = [];
    const p = new OpenAITimingProvider('x', client, { words: 'whisper-1', diarize: 'd', usage: (u) => usage.push(u), retry: { sleep: async () => {} } });
    await expect(p.align({ path: await fakeWav(), duration: 2 }, {})).rejects.toThrow('bad request');
    expect(usage).toEqual([{ audioSeconds: 2 }]);
  });

  it.skipIf(!hasFfmpeg)('cuts a long file into pieces and keeps speaker ids across them with known-speaker references', async () => {
    const dir = await tempDir('overtone-oai-');
    const wav = join(dir, 'audio.wav');
    // 8 s of tone (no silences): two pieces, cut at 4.085 s (the planner keeps 5 % below the 4.3 s limit)
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', ...WAV_ARGS, wav]);
    let piece = 0;
    const client = fakeClient((p) => {
      if (p.model === 'whisper-1') return { text: 'Hello there. Hi.', words: [{ word: 'Hello', start: 0.2, end: 0.6 }, { word: 'there', start: 0.6, end: 1 }, { word: 'Hi', start: 3, end: 3.4 }] };
      // piece 1: A then B; piece 2: the known speaker B first (by its name), then a new speaker "A"
      return piece++ === 0
        ? { segments: [{ speaker: 'A', start: 0, end: 2.5 }, { speaker: 'B', start: 2.8, end: 3.6 }] }
        : { segments: [{ speaker: String((p.known_speaker_names as string[])[0]), start: 0.1, end: 1.1 }, { speaker: 'A', start: 2.9, end: 3.5 }] };
    });
    const usage: Usage[] = [];
    const p = new OpenAITimingProvider('t', client, { words: 'whisper-1', diarize: 'd', maxSeconds: 4.3, usage: (u) => usage.push(u) });
    const res = await p.align({ path: wav, duration: 8 }, {});
    const dia = client.calls.filter((c) => c.model === 'd');
    expect(dia).toHaveLength(2);
    expect(dia[0]!.known_speaker_names).toBeUndefined();
    // speaker_1 (A, 2.5 s) spoke longer than speaker_2 (B, 0.8 s, too short for a reference clip): only speaker_1 is sent
    expect(dia[1]!.known_speaker_names).toEqual(['speaker_1']);
    expect(String((dia[1]!.known_speaker_references as string[])[0])).toMatch(/^data:audio\/wav;base64,UklGR/);
    expect(res.words.map((x) => x.start)).toEqual([0.2, 0.6, 3, 4.285, 4.685, 7.085]);
    expect(res.words.map((x) => x.speaker)).toEqual(['S1', 'S1', 'S2', 'S1', 'S1', 'S3']);
    expect(usage.map((u) => Math.round(u.audioSeconds! * 1000) / 1000)).toEqual([4.085, 4.085, 3.915, 3.915]);
  });
});

describe('whisper-1 as the text provider (--timing same)', () => {
  it('asks for word timestamps and returns the words with punctuation, relative to the chunk', async () => {
    const client = fakeClient(() => ({ text: 'Hi there.', language: 'english', words: [{ word: 'Hi', start: 0.1, end: 0.3 }, { word: 'there', start: 0.3, end: 0.6 }] }));
    const dir = await tempDir('overtone-oai-');
    await writeFile(join(dir, 'chunk-0.mp3'), Buffer.from([1]));
    const res = await new OpenAITextProvider('openai:whisper-1', client, 'whisper-1').transcribe({ path: join(dir, 'chunk-0.mp3'), index: 0, start: 10, end: 11 }, {});
    expect(client.calls[0]).toMatchObject({ response_format: 'verbose_json', timestamp_granularities: ['word'] });
    expect(res).toEqual({ text: 'Hi there.', language: 'en', words: [{ text: 'Hi', start: 0.1, end: 0.3, speaker: 'S1' }, { text: 'there.', start: 0.3, end: 0.6, speaker: 'S1' }] });
  });
});
