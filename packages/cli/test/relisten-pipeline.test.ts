import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseSecondOpinion, resolveConfig, validateFileConfig, type CliFlags } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { secondOpinionSelection, type Providers } from '../src/providers/registry.js';
import { ImplausibleTranscriptError } from '../src/providers/elevenlabs.js';
import type { AudioFile, LlmRequest, TimingProvider } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const said = (text: string, start: number, step = 0.3, speaker = 'S1'): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker }));

// A film-like clip: "Hello there." at 1 s, shouting the timing provider does not hear, "See you." at 20 s.
const TEXT = 'Hello there. Go now, go! See you.';
const TIMING = [...said('Hello there.', 1), ...said('See you.', 20)];
const SHOUT = said('go now go', 8, 0.4);

/** The window a fake `cutAudio` encoded in the snippet's path ("…region-7500-20980.wav"). */
const windowOf = (path: string): [number, number] => {
  const m = /region-(\d+)-(\d+)/.exec(path)!;
  return [Number(m[1]) / 1000, Number(m[2]) / 1000];
};
/** Words (absolute times) as a timing provider answers for a snippet: relative to its start, inside it. */
const answer = (path: string, words: TimedWord[]) => {
  const [start, end] = windowOf(path);
  return words.filter((w) => w.start >= start && w.end <= end).map((w) => ({ ...w, start: +(w.start - start).toFixed(3), end: +(w.end - start).toFixed(3) }));
};

function timing(id: string, snippet: (audio: AudioFile) => Promise<TimedWord[]>): TimingProvider & { calls: AudioFile[] } {
  const calls: AudioFile[] = [];
  return {
    id, calls,
    align: async (audio) => {
      calls.push(audio);
      if (audio.path.includes('region-')) return { words: await snippet(audio) };
      return { words: TIMING, language: 'en-US' };
    },
  };
}

function providers(main: TimingProvider, second?: TimingProvider): Providers {
  return {
    text: { id: 'fake:text', transcribe: async () => ({ text: TEXT, language: 'en' }) },
    timing: main,
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
    ...(second ? { secondTiming: second } : {}),
  };
}

async function setup(flags: CliFlags = {}) {
  const dir = await tempDir('overtone-relisten-');
  const file = `${dir}/film.m4a`;
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:a', 'aac', file]);
  const cfg = await resolveConfig({ export: 'json', context: 'A film.', language: 'en', ...flags }, {}, { cwd: dir, configDir: dir });
  const cuts: Array<[number, number]> = [];
  const deps = {
    cwd: dir,
    cutAudio: async (input: string, start: number, end: number) => {
      cuts.push([start, end]);
      return input.replace(/\.wav$/, `.region-${Math.round(start * 1000)}-${Math.round(end * 1000)}.wav`);
    },
  };
  return { file, cfg, cuts, deps };
}

const wordsOf = (doc: { turns: Array<{ words: Array<{ text: string; start: number; match?: string }> }> }) => doc.turns.flatMap((t) => t.words);

describe.skipIf(!hasFfmpeg)('pipeline: re-listening for timing', () => {
  it('sends an unheard stretch to the timing provider again and takes the times it hears; cached with the timing stage', async () => {
    const { file, cfg, cuts, deps } = await setup();
    const main = timing('fake:timing', async (a) => answer(a.path, SHOUT));
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main) });
    // the gap between "there." and "See", with the words around it, padded (0.50–21.04 s), widened to the 0.25 s grid
    expect(cuts).toEqual([[0.5, 21.25]]);
    expect(main.calls.map((c) => c.duration)).toEqual([expect.any(Number), 20.75]);
    const words = wordsOf(res.doc);
    expect(words.filter((w) => ['Go', 'now,', 'go!'].includes(w.text)).map((w) => [w.text, w.start, w.match])).toEqual([['Go', 8, 'exact'], ['now,', 8.4, 'exact'], ['go!', 8.8, 'exact']]);
    expect(res.doc.meta?.timingRetries).toEqual([{ start: 1.54, end: 20, words: 3, provider: 'fake:timing', heard: 3, result: 'heard' }]);
    expect(log.lines).toContain('info:   timing: 3 words in 1.54–20.00 s ("Go now, go!") have no timing words; asking fake:timing (timing provider) for 0.50–21.04 s');

    // a second run with --from-stage align re-aligns but reuses the snippet's answer
    const again = await resolveConfig({ export: 'json', context: 'A film.', language: 'en', fromStage: 'align' }, {}, { cwd: deps.cwd, configDir: deps.cwd });
    main.calls.length = 0;
    await runPipeline(file, again, { ...deps, log: memoryLogger(), providers: providers(main) });
    expect(main.calls.filter((c) => c.path.includes('region-'))).toEqual([]);
  });

  it("times a stretch the timing provider did not hear from the second hearing's whole-file words, with no request", async () => {
    const { file, cfg, cuts, deps } = await setup();
    const main = timing('fake:timing', async () => []);
    const second: TimingProvider & { calls: AudioFile[] } = {
      id: 'fake:second', calls: [],
      align: async (audio) => { second.calls.push(audio); return { words: audio.path.includes('region-') ? [] : [...TIMING, ...SHOUT].sort((x, y) => x.start - y.start) }; },
    };
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: providers(main, second) });
    expect(cuts).toEqual([]);
    expect(res.doc.meta).not.toHaveProperty('timingRetries');
    expect(res.doc.meta?.models).toMatchObject({ second: 'fake:second' });
    expect(wordsOf(res.doc).find((w) => w.text === 'Go')).toMatchObject({ start: 8, match: 'exact' });
  });

  it('sends a snippet to the engine that gives the times first (the second hearing), then to the timing provider', async () => {
    const { file, cfg, deps } = await setup();
    const main = timing('fake:timing', async (a) => answer(a.path, SHOUT));
    const second = timing('fake:second', async () => []);
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main, second) });
    expect(res.doc.meta?.timingRetries).toEqual([
      { start: 1.54, end: 20, words: 3, provider: 'fake:second', heard: 0, result: 'none' },
      { start: 1.54, end: 20, words: 3, provider: 'fake:timing', heard: 3, result: 'heard' },
    ]);
    expect(wordsOf(res.doc).find((w) => w.text === 'Go')).toMatchObject({ start: 8, match: 'exact' });
    expect(log.lines).toContain('info:   timing: asking fake:timing (timing provider) for 0.50–21.04 s');
  });

  it('goes on without the second hearing when its whole-file request fails', async () => {
    const { file, cfg, deps } = await setup();
    const main = timing('fake:timing', async (a) => answer(a.path, SHOUT));
    const second: TimingProvider = { id: 'fake:second', align: async () => { throw new Error('HTTP 503'); } };
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main, second) });
    expect(log.lines).toContain('warn: fake:second failed (HTTP 503); going on without the second hearing. Run the command again to retry it.');
    expect(res.doc.meta?.models).not.toHaveProperty('second');
    expect(wordsOf(res.doc).find((w) => w.text === 'Go')).toMatchObject({ start: 8, match: 'exact' });
  });

  it('takes the times from the timing provider when the whole-file second hearing is implausible (no words)', async () => {
    const { file, cfg, deps } = await setup();
    const main = timing('fake:timing', async (a) => answer(a.path, SHOUT));
    const second: TimingProvider = {
      id: 'fake:second',
      align: async (audio) => {
        if (audio.path.includes('region-')) return { words: [] };
        throw new ImplausibleTranscriptError('ElevenLabs Scribe returned no plausible transcript for x.wav, twice');
      },
    };
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main, second) });
    expect(log.lines).toContain('info:   fake:second returned no plausible transcript for the file; taking it as no words heard');
    expect(log.lines.some((l) => l.includes('times from fake:timing'))).toBe(true);
    const words = wordsOf(res.doc);
    expect(words.filter((w) => ['Hello', 'there.', 'See', 'you.'].includes(w.text)).map((w) => [w.text, w.start, w.match])).toEqual([
      ['Hello', 1, 'exact'], ['there.', 1.3, 'exact'], ['See', 20, 'exact'], ['you.', 20.3, 'exact'],
    ]);
    // only the stretch the timing provider did not hear is re-listened, not the whole text
    const retries = (res.doc.meta?.timingRetries ?? []) as Array<{ start: number; end: number }>;
    expect(retries.every((r) => r.start >= 1.5 && r.end <= 20)).toBe(true);
  });

  it('keeps an unknown time for what no engine heard (interpolated, confidence 0)', async () => {
    const { file, cfg, deps } = await setup();
    const main = timing('fake:timing', async () => []);
    const res = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: providers(main) });
    expect(res.doc.meta?.timingRetries).toEqual([{ start: 1.54, end: 20, words: 3, provider: 'fake:timing', heard: 0, result: 'none' }]);
    const go = wordsOf(res.doc).find((w) => w.text === 'Go')!;
    expect(go).toMatchObject({ match: 'interpolated', confidence: 0 });
  });

  it('keeps going when a provider call fails, and does not cache the failed request', async () => {
    const { file, cfg, deps } = await setup();
    let fail = true;
    const main = timing('fake:timing', async (a) => { if (fail) throw new Error('HTTP 503'); return answer(a.path, SHOUT); });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main) });
    expect(log.lines).toContain('warn: fake:timing failed for 0.50–21.04 s (HTTP 503); keeping the estimated times there. The failed request is not cached: run the command again to retry.');
    expect(wordsOf(res.doc).find((w) => w.text === 'Go')?.match).toBe('interpolated');
    // the next run tries again
    fail = false;
    const next = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: providers(main) });
    expect(wordsOf(next.doc).find((w) => w.text === 'Go')).toMatchObject({ start: 8, match: 'exact' });
  });

  it('takes an implausible answer (Scribe on a window of music) as no words, and caches it', async () => {
    const { file, cfg, deps } = await setup();
    const main = timing('fake:timing', async () => []);
    const second = timing('fake:second', async () => { throw new ImplausibleTranscriptError('ElevenLabs Scribe returned no plausible transcript for x.wav, twice'); });
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { ...deps, log, providers: providers(main, second) });
    expect(log.lines).toContain('info:   timing: fake:second returned no plausible transcript for 0.50–21.04 s; taking it as no words heard');
    expect(res.doc.meta?.timingRetries).toContainEqual({ start: 1.54, end: 20, words: 3, provider: 'fake:second', heard: 0, result: 'none' });
    const again = await resolveConfig({ export: 'json', context: 'A film.', language: 'en', fromStage: 'align' }, {}, { cwd: deps.cwd, configDir: deps.cwd });
    second.calls.length = 0;
    await runPipeline(file, again, { ...deps, log: memoryLogger(), providers: providers(main, second) });
    expect(second.calls).toEqual([]);
  });
});

describe('the second timing opinion', () => {
  const azure = { provider: 'azure-speech', model: 'fast', id: 'azure-speech:fast' };
  it('auto: elevenlabs when ELEVENLABS_API_KEY is set and it is not the timing provider, else none', () => {
    expect(secondOpinionSelection('auto', azure, {})).toBeUndefined();
    expect(secondOpinionSelection('auto', azure, { ELEVENLABS_API_KEY: '  ' })).toBeUndefined();
    expect(secondOpinionSelection('auto', azure, { ELEVENLABS_API_KEY: 'fake-key' })).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', id: 'elevenlabs:scribe_v2' });
    const scribe = { provider: 'elevenlabs', model: 'scribe_v2', id: 'elevenlabs:scribe_v2' };
    expect(secondOpinionSelection('auto', scribe, { ELEVENLABS_API_KEY: 'fake-key' })).toBeUndefined();
  });

  it('none, or a named provider other than the timing provider', () => {
    expect(secondOpinionSelection(false, azure, { ELEVENLABS_API_KEY: 'fake-key' })).toBeUndefined();
    expect(secondOpinionSelection({ provider: 'elevenlabs', id: 'elevenlabs' }, azure, {})).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', id: 'elevenlabs:scribe_v2' });
    expect(() => secondOpinionSelection({ provider: 'azure-speech', id: 'azure-speech' }, azure, {})).toThrow(UserError);
    expect(() => secondOpinionSelection({ provider: 'anthropic', id: 'anthropic' }, azure, {})).toThrow(/cannot be used for --timing/);
  });

  it('is set with --timing-second-opinion or timingSecondOpinion; --local makes auto none', async () => {
    const dirs = { cwd: '/tmp', configDir: '/tmp' };
    expect((await resolveConfig({}, {}, dirs)).timingSecondOpinion).toBe('auto');
    expect((await resolveConfig({ timingSecondOpinion: 'none' }, {}, dirs)).timingSecondOpinion).toBe(false);
    expect((await resolveConfig({}, { timingSecondOpinion: false }, dirs)).timingSecondOpinion).toBe(false);
    expect((await resolveConfig({ timingSecondOpinion: 'elevenlabs' }, { timingSecondOpinion: 'none' }, dirs)).timingSecondOpinion).toEqual({ provider: 'elevenlabs', id: 'elevenlabs' });
    expect((await resolveConfig({ local: true }, {}, dirs)).timingSecondOpinion).toBe(false);
    expect((await resolveConfig({}, { local: true }, dirs)).timingSecondOpinion).toBe(false);
    // a provider named explicitly is used even with --local
    expect((await resolveConfig({ local: true, timingSecondOpinion: 'elevenlabs' }, {}, dirs)).timingSecondOpinion).toEqual({ provider: 'elevenlabs', id: 'elevenlabs' });
    expect(parseSecondOpinion('AUTO', 'x')).toBe('auto');
    expect(parseSecondOpinion('off', 'x')).toBe(false);
    expect(() => parseSecondOpinion('same', '--timing-second-opinion')).toThrow(UserError);
    expect(() => validateFileConfig({ timingSecondOpinion: true })).toThrow(/timingSecondOpinion/);
  });
});
