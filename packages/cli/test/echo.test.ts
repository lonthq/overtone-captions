import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { ECHO, findPromptEcho, promptRuns } from '../src/echo.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline, textPrompt } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import type { AudioChunk, LlmRequest, TextOptions } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/**
 * The caption benchmark's nasa-ayers clip (gpt-transcribe through Azure OpenAI, Azure Speech timing):
 * 8 s of radio call signs, then the astronaut. The text began with the --context sentence word for word.
 */
const CONTEXT = 'NASA astronaut Nichole Ayers on the International Space Station explains how schools and organizations set up a live amateur (ham) radio contact with the station through the ARISS program';
const CALL_SIGNS = 'NA1SS, this is NA2SJ. Over. NA2SJ from NA1SS for scheduled contact.';
const SPEECH = 'Hey everyone, I’m NASA astronaut Nichole Ayers, and welcome aboard the International Space Station, where we’re orbiting the Earth 16 times every single day.';
const az = (rows: Array<[string, number, number]>, speaker: string): TimedWord[] => rows.map(([text, start, end]) => ({ text, start, end, speaker }));
const CALL_WORDS = az([['NA1SS,', 0.43, 1.39], ['this', 1.39, 1.59], ['is', 1.71, 1.95], ['NA2SJ.', 2.03, 3.03], ['Over.', 3.23, 3.71], ['NA2SJ', 4.75, 5.59],
  ['from', 5.87, 6.11], ['NA1SS', 6.27, 7.23], ['for', 7.31, 7.47], ['scheduled', 7.47, 7.83], ['contact.', 7.87, 8.31]], 'S1');
const SPEECH_WORDS = az([['Hey', 9.47, 9.55], ['everyone,', 9.55, 9.83], ["I'm", 9.83, 10.03], ['NASA', 10.03, 10.23], ['astronaut', 10.23, 10.55],
  ['Nicole', 10.55, 10.91], ['Ayers,', 10.91, 11.15], ['and', 11.15, 11.31], ['welcome', 11.31, 11.67], ['aboard', 11.67, 11.91], ['the', 11.91, 11.99],
  ['International', 11.99, 12.51], ['Space', 12.51, 12.71], ['Station,', 12.71, 13.15], ['where', 13.15, 13.31], ["we're", 13.31, 13.47],
  ['orbiting', 13.47, 13.79], ['the', 13.79, 13.91], ['Earth', 13.91, 14.11], ['16', 14.11, 14.59], ['times', 14.59, 15.15], ['every', 15.31, 15.59],
  ['single', 15.59, 15.87], ['day.', 15.87, 16.11]], 'S2');
const NASA_TIMING = [...CALL_WORDS, ...SPEECH_WORDS];
const ECHOED = `${CONTEXT}. ${SPEECH}`;

/** `text` timed from `start`, one word every `step` seconds. */
const timed = (text: string, start: number, step: number, speaker = 'S1'): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: start + i * step, end: start + i * step + step * 0.8, speaker }));

describe('prompt echo', () => {
  it('finds the context sentence the text model put where the timing provider heard radio call signs (nasa-ayers)', () => {
    expect(ECHO).toEqual({ minWords: 5, minGlossaryTerms: 3, minSupport: 0.5, minConfidence: 0.75 });
    const res = findPromptEcho(ECHOED, CONTEXT, NASA_TIMING, { language: 'en' });
    expect(res.text).toBe(SPEECH);
    expect(res.echoes).toHaveLength(1);
    const [echo] = res.echoes;
    expect(echo).toMatchObject({ from: 0, to: 28, text: `${CONTEXT}.`, matched: 29 });
    expect(echo!.support).toBeLessThan(0.1);
    expect(echo!.start).toBeCloseTo(0.43, 2);
    expect(echo!.heard).toBe(CALL_SIGNS);
  });

  it('finds the echo inside the full prompt (context, glossary, style)', async () => {
    const cfg = await resolveConfig({ context: CONTEXT, numbers: 'digits' }, { glossary: ['ARISS', 'Nichole Ayers'] }, { cwd: '/', configDir: '/' });
    const prompt = textPrompt(cfg);
    expect(prompt).toContain('Names and terms: ARISS, Nichole Ayers.');
    expect(findPromptEcho(ECHOED, prompt, NASA_TIMING, { language: 'en' }).text).toBe(SPEECH);
  });

  it('keeps a title the speaker really says: the timing provider heard it too', () => {
    const title = 'Tears of Steel, a Blender Foundation science-fiction short film.';
    const words = [...timed(title, 0.5, 0.4), ...timed('Captain, we are ready for the next take.', 6, 0.35, 'S2')];
    const text = `${title} Captain, we are ready for the next take.`;
    const prompt = 'Tears of Steel, a Blender Foundation science-fiction short film set in a future Amsterdam.';
    const runs = promptRuns(text, prompt, words, { language: 'en' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ text: title, support: 1 });
    expect(findPromptEcho(text, prompt, words, { language: 'en' })).toEqual({ text, echoes: [] });
  });

  it('keeps glossary names in normal speech; only a run of whole terms in the list order counts', () => {
    const glossary = 'Names and terms: Thom, Celia, Barley, Vivienne, International Space Station, Expedition 73.';
    const said = 'Thom and Celia met Barley on the International Space Station during Expedition 73.';
    // names in speech, unsupported (no timing words at all): no run of prompt words in order
    expect(promptRuns(said, glossary, [], { language: 'en' })).toEqual([]);
    // five words in the list order but only two terms: not counted
    expect(promptRuns('the International Space Station Expedition 73 crew', glossary, [], { language: 'en' })).toEqual([]);
    // the list itself, in its order, where nothing was said: an echo
    const echo = findPromptEcho('Thom, Celia, Barley, Vivienne, International Space Station. Go!', glossary, timed('Go!', 3, 0.3), { language: 'en' });
    expect(echo.text).toBe('Go!');
    // the same names said in that order, and heard: kept
    const heard = 'Thom, Celia, Barley, Vivienne, International Space Station, ready? Go!';
    expect(findPromptEcho(heard, glossary, timed(heard, 1, 0.3), { language: 'en' }).echoes).toEqual([]);
  });

  it('finds an echo of the previous text (the prompt of a speech region)', () => {
    const before = 'You know, there is a lesson to be learned from this.';
    const words = timed('Could have gone worse.', 2, 0.3);
    expect(findPromptEcho(`${before} Could have gone worse.`, before, words, { language: 'en' }).text).toBe('Could have gone worse.');
  });
});

interface Call { path: string; start: number; opts: TextOptions }

function nasaProviders(answers: { first: string; region: (start: number) => string; timing?: TimedWord[] }) {
  const calls: Call[] = [];
  const providers: Providers = {
    text: {
      id: 'fake:text',
      transcribe: async (chunk: AudioChunk, opts: TextOptions) => {
        calls.push({ path: chunk.path, start: chunk.start, opts });
        if (chunk.path.includes('.region-')) return { text: answers.region(chunk.start) };
        if (chunk.path.endsWith('.loud.mp3')) return { text: answers.first };
        return { text: answers.first, language: 'en' };
      },
    },
    timing: { id: 'fake:timing', align: async () => ({ words: answers.timing ?? NASA_TIMING, language: 'en-US' }) },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        if (req.name === 'choose') {
          // the chooser puts back what the timing provider heard where the caption has no words
          const ids = [...req.user.matchAll(/^### (\d+) /gm)].map((m) => m[1]!);
          return { spans: ids.map((id) => ({ id, decision: 'change', text: CALL_SIGNS, basis: 'the timing provider heard the call signs' })) } as T;
        }
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
  return { providers, calls };
}

async function setup(flags: CliFlags = {}, glossary?: string[]) {
  const dir = await tempDir('overtone-echo-');
  const file = `${dir}/clip.m4a`;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:a', 'aac', file]);
  const cfg = await resolveConfig({ export: 'json', context: CONTEXT, language: 'en', ...flags }, glossary ? { glossary } : {}, { cwd: dir, configDir: dir });
  const cuts: Array<{ start: number; end: number }> = [];
  const normalized: string[] = [];
  const deps = {
    cwd: dir,
    normalizeLoudness: async (path: string) => { normalized.push(path); return path.replace(/\.mp3$/, '.loud.mp3'); },
    cutAudio: async (input: string, start: number, end: number) => {
      cuts.push({ start, end });
      return input.replace(/\.(mp3|wav)$/, `.region-${Math.round(start * 1000)}-${Math.round(end * 1000)}.$1`);
    },
  };
  return { file, cfg, cuts, normalized, deps };
}

const textOf = (doc: { turns: Array<{ words: Array<{ text: string }> }> }) => doc.turns.flatMap((t) => t.words.map((w) => w.text)).join(' ');

describe.skipIf(!hasFfmpeg)('pipeline: prompt echo', () => {
  it('removes the echoed context; the text vote puts back what the engines heard there (nasa-ayers)', async () => {
    const { file, cfg, cuts, normalized, deps } = await setup();
    const { providers, calls } = nasaProviders({ first: ECHOED, region: () => CALL_SIGNS });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers });
    // the rest of the text was complete: no retry; the vote re-listens the call signs' snippet with only the text
    // before it as prompt (none here)
    expect(normalized).toEqual([]);
    expect(cuts.length).toBeGreaterThan(0);
    const snippet = calls.find((c) => c.path.includes('.region-'))!;
    expect(snippet.opts.prompt).toBeUndefined();
    expect(textOf(res.doc)).toBe(`${CALL_SIGNS} ${SPEECH}`);
    expect(res.doc.meta).not.toHaveProperty('fallbacks');
    expect(res.doc.meta?.textRetries).toEqual([{ start: 0, end: expect.closeTo(20, 0), echo: `${CONTEXT}.`, result: 'removed', reason: 'the text provider echoed its prompt' }]);
    expect(res.doc.meta?.textVotes).toEqual([expect.objectContaining({ class: 'c', from: '', to: CALL_SIGNS, result: 'changed' })]);
    expect(log.lines).toContain(`warn: chunk 1/1 (0:00:00–0:00:20): the text provider echoed its prompt: "${CONTEXT}." (29 words at 0.43–9.47 s, where the engines heard "${CALL_SIGNS}"); removing it`);
  });

  it('only removes an echo where the engines heard nothing', async () => {
    const { file, cfg, cuts, normalized, deps } = await setup();
    const { providers, calls } = nasaProviders({ first: ECHOED, region: () => '', timing: SPEECH_WORDS });
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(calls).toHaveLength(1);
    expect([cuts, normalized]).toEqual([[], []]);
    expect(textOf(res.doc)).toBe(SPEECH);
    expect(res.doc.meta?.textRetries).toEqual([expect.objectContaining({ echo: `${CONTEXT}.`, result: 'removed' })]);
  });

  it('keeps the context sentence when the speaker says it', async () => {
    const { file, cfg, deps } = await setup();
    const said = [...timed(`${CONTEXT}.`, 0.4, 0.3), ...SPEECH_WORDS];
    const { providers, calls } = nasaProviders({ first: ECHOED, region: () => '', timing: said });
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers });
    expect(calls).toHaveLength(1);
    expect(textOf(res.doc)).toBe(ECHOED);
    expect(res.doc.meta).not.toHaveProperty('textRetries');
  });
});
