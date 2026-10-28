import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import type { Usage } from '../src/providers/kit.js';
import { defaultTimeoutMs, elevenlabsProvider, ElevenLabsProvider, fromScribeLanguage, implausibleScribe, keyterms, lookupAfterMs, mapScribeResponse, MAX_KEYTERMS, SCRIBE_SANITY, timeoutFromEnv, toScribeLanguage, type ScribeResponse } from '../src/providers/elevenlabs.js';
import { tempDir } from './tmp.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./conformance/fixtures/elevenlabs/${name}`, import.meta.url), 'utf8')) as ScribeResponse;
/** A healthy recorded answer (the 18 s sample) and Scribe's HTTP 200 garbage answer for a 196.5 s audiobook clip. */
const HEALTHY = fixture('speech-to-text.json');
const GARBAGE = fixture('implausible-200.json');

describe('implausibleScribe', () => {
  it('accepts a healthy answer', () => {
    expect(implausibleScribe(HEALTHY, 18)).toBeUndefined();
  });

  it('rejects the recorded garbage: random multilingual words with a mean confidence of 0.007, two of them 108 s and 31 s long', () => {
    expect(SCRIBE_SANITY).toEqual({ minMeanConfidence: 0.5, minWords: 5, longWordSeconds: 10, maxLongWordShare: 0.25 });
    expect(implausibleScribe(GARBAGE, 196.5)).toBe('12 words; mean word confidence 0.007, 2 words longer than 10 s covering 71% of the audio');
  });

  const words = (n: number, logprob: number, seconds = 0.3) => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, type: 'word', start: i, end: i + seconds, logprob }));

  it('judges the confidence on 5 words or more, and the long words by their share of the audio', () => {
    expect(implausibleScribe({ words: words(5, Math.log(0.4)) }, 60)).toBe('5 words; mean word confidence 0.400');
    expect(implausibleScribe({ words: words(4, Math.log(0.1)) }, 60)).toBeUndefined(); // too few words to judge
    expect(implausibleScribe({ words: words(5, Math.log(0.6)) }, 60)).toBeUndefined();
    // a sung note of 12 s in a minute of song is no reason; words of 12 s covering 40 % of the audio are
    expect(implausibleScribe({ words: [...words(20, 0), { text: 'oh', type: 'word', start: 30, end: 42, logprob: 0 }] }, 60)).toBeUndefined();
    expect(implausibleScribe({ words: [...words(2, 0, 12)] }, 60)).toBe('2 words; 2 words longer than 10 s covering 40% of the audio');
    // spacing, audio events, punctuation and words without a logprob do not count
    expect(implausibleScribe({ words: [{ text: ' ', type: 'spacing', start: 0, end: 50, logprob: -9 }, { text: '...', type: 'word', start: 0, end: 1, logprob: -9 }, ...words(5, Number.NaN)] }, 60)).toBeUndefined();
    expect(implausibleScribe({}, 0)).toBeUndefined();
  });
});

describe('ElevenLabs provider: implausible answers', () => {
  async function setup(answers: ScribeResponse[]) {
    const dir = await tempDir('overtone-xi-');
    const path = join(dir, 'audio.wav');
    await writeFile(path, Buffer.from('RIFF0000WAVEfmt '));
    const log = memoryLogger();
    const usage: number[] = [];
    let calls = 0;
    const fetch = (async () => {
      const body = answers[Math.min(calls++, answers.length - 1)];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const provider = new ElevenLabsProvider('elevenlabs:scribe_v2', { key: 'xi-secret', baseUrl: 'https://api.elevenlabs.io', model: 'scribe_v2', fetch, log, usage: (u) => usage.push(u.audioSeconds ?? 0), retry: { sleep: async () => {} } });
    return { path, log, usage, calls: () => calls, provider };
  }

  it('requests an implausible answer once more and uses the second one (both are billed)', async () => {
    const { path, log, usage, calls, provider } = await setup([GARBAGE, HEALTHY]);
    const res = await provider.align({ path, duration: 18 }, { language: 'en' });
    expect(calls()).toBe(2);
    expect(res.words).toHaveLength(43);
    expect(usage).toEqual([18, 18]);
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toEqual([
      'warn: ElevenLabs Scribe returned an implausible transcript for audio.wav (12 words; mean word confidence 0.007, 2 words longer than 10 s covering 71% of the audio); requesting it once more',
    ]);
  });

  it('fails the call when the second answer is implausible too', async () => {
    const { path, calls, provider } = await setup([GARBAGE]);
    await expect(provider.transcribe({ path, index: 0, start: 0, end: 196.5 }, { language: 'en' }))
      .rejects.toThrow(/^ElevenLabs Scribe returned no plausible transcript for audio\.wav, twice \(12 words; mean word confidence 0\.007, 2 words longer than 10 s covering 71% of the audio\)\. This is a fault on the service's side/);
    expect(calls()).toBe(2);
  });
});

describe('ElevenLabs request timeout', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('looks for the finished transcript after 0.2 s per audio second (at least 60 s), gives up after 1 s per audio second (at least 10 minutes)', () => {
    expect(lookupAfterMs(18)).toBe(60_000);
    expect(lookupAfterMs(600)).toBe(120_000);
    expect(lookupAfterMs(7200)).toBe(1_440_000);
    expect(defaultTimeoutMs(18)).toBe(600_000);
    expect(defaultTimeoutMs(1800)).toBe(1_800_000);
    expect(defaultTimeoutMs(7200)).toBe(7_200_000);
  });

  it('reads ELEVENLABS_TIMEOUT_SECONDS: a positive number of seconds, else a UserError', () => {
    expect(timeoutFromEnv({})).toBeUndefined();
    expect(timeoutFromEnv({ ELEVENLABS_TIMEOUT_SECONDS: ' ' })).toBeUndefined();
    expect(timeoutFromEnv({ ELEVENLABS_TIMEOUT_SECONDS: '90' })).toBe(90_000);
    expect(timeoutFromEnv({ ELEVENLABS_TIMEOUT_SECONDS: '2.5' })).toBe(2500);
    for (const bad of ['0', '-5', 'ten', 'Infinity']) {
      expect(() => timeoutFromEnv({ ELEVENLABS_TIMEOUT_SECONDS: bad })).toThrow(UserError);
    }
    expect(() => timeoutFromEnv({ ELEVENLABS_TIMEOUT_SECONDS: 'ten' })).toThrow('ELEVENLABS_TIMEOUT_SECONDS must be a number of seconds above 0 (got "ten").');
  });

  /** A listed transcript: `ago` ms before the request was sent (negative: after), with this audio length. */
  interface Listed { id: string; ago: number; seconds: number }

  /**
   * A fake ElevenLabs: the POST answers HEALTHY after `answerAfterMs` (never when undefined, until it is aborted); the
   * transcript list shows `listed` from `listedAfterMs` on (relative to the POST), and GET of a listed id answers
   * HEALTHY with its audio length.
   */
  async function setup(opts: { answerAfterMs?: number; listed?: Listed[]; listedAfterMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    const dir = await tempDir('overtone-xi-');
    const path = join(dir, 'audio.wav');
    await writeFile(path, Buffer.from('RIFF0000WAVEfmt '));
    const log = memoryLogger();
    const usage: Usage[] = [];
    const requests: string[] = [];
    let postedAt = 0;
    let aborted = false;
    let posted: () => void = () => {};
    const firstPost = new Promise<void>((r) => { posted = r; });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.method === 'POST') {
        postedAt = Date.now();
        posted();
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); });
          if (opts.answerAfterMs !== undefined) setTimeout(() => resolve(json({ ...HEALTHY, transcription_id: 'answered' })), opts.answerAfterMs);
        });
      }
      const visible = Date.now() - postedAt >= (opts.listedAfterMs ?? 0) ? opts.listed ?? [] : [];
      if (path === '/v1/speech-to-text/transcripts') {
        return json({ transcripts: visible.map((t) => ({ id: t.id, gcs_path: 'gs://x', created_at: new Date(postedAt - t.ago).toISOString() })), cursor: null });
      }
      const t = visible.find((l) => path === `/v1/speech-to-text/transcripts/${l.id}`);
      return t ? json({ ...HEALTHY, audio_duration_secs: t.seconds }) : new Response('{"detail":{"message":"not found"}}', { status: 404 });
    }) as typeof globalThis.fetch;
    const retry = { sleep: async () => {} };
    const provider = opts.env
      ? elevenlabsProvider.create({ ELEVENLABS_API_KEY: 'xi-secret', ...opts.env }, 'scribe_v2', { role: 'timing', id: 'elevenlabs:scribe_v2', cwd: dir, fetch, retry, log, usage: (u) => usage.push(u) }) as ElevenLabsProvider
      : new ElevenLabsProvider('elevenlabs:scribe_v2', { key: 'xi-secret', baseUrl: 'https://api.elevenlabs.io', model: 'scribe_v2', fetch, log, usage: (u) => usage.push(u), retry });
    return { path, log, usage, requests, aborted: () => aborted, firstPost, provider };
  }

  const posts = (requests: string[]) => requests.filter((r) => r.startsWith('POST'));
  const infos = (log: ReturnType<typeof memoryLogger>) => log.lines.filter((l) => l.startsWith('info:'));

  it('keeps waiting for a late answer and never sends the request twice', async () => {
    vi.useFakeTimers();
    const { path, log, usage, requests, firstPost, provider } = await setup({ answerAfterMs: 300_000 });
    const result = provider.align({ path, duration: 225 }, { language: 'en' });
    await firstPost;
    await vi.advanceTimersByTimeAsync(300_000);
    const res = await result;
    expect(res.words).toHaveLength(43);
    expect(posts(requests)).toHaveLength(1);
    // from 60 s on, the list is looked at every 15 s as well: at 60, 75, … 285 s
    expect(requests.filter((r) => r === 'GET /v1/speech-to-text/transcripts')).toHaveLength(16);
    expect(usage).toEqual([{ audioSeconds: 225 }]);
    expect(infos(log)).toEqual(['info: ElevenLabs has not answered within 60 s for audio.wav; waiting up to 10 min and looking for the finished transcript meanwhile']);
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toEqual([]);
  });

  it('takes the finished transcript from the transcript list and stops waiting for the answer', async () => {
    vi.useFakeTimers();
    const listed: Listed[] = [
      { id: 'mine', ago: -40_000, seconds: 225.0021 },
      { id: 'other-length', ago: -30_000, seconds: 18.0053 },
      { id: 'before-the-request', ago: 120_000, seconds: 225.0021 },
    ];
    const { path, log, usage, requests, aborted, firstPost, provider } = await setup({ listed, listedAfterMs: 70_000 });
    const result = provider.transcribe({ path, index: 0, start: 0, end: 225 }, { language: 'en' });
    await firstPost;
    await vi.advanceTimersByTimeAsync(75_000);
    const res = await result;
    expect(res.words).toHaveLength(43);
    expect(posts(requests)).toHaveLength(1);
    expect(aborted()).toBe(true);
    // the transcript that finished before the request was sent is never fetched
    expect(requests.filter((r) => r.startsWith('GET /v1/speech-to-text/transcripts/'))).toEqual(['GET /v1/speech-to-text/transcripts/mine']);
    expect(usage).toEqual([{ audioSeconds: 225 }]);
    expect(infos(log)).toEqual([
      'info: ElevenLabs has not answered within 60 s for audio.wav; waiting up to 10 min and looking for the finished transcript meanwhile',
      'info: ElevenLabs: took the finished transcript mine of audio.wav from the transcript list',
    ]);
  });

  it('gives up with a clear error when neither the answer nor the transcript comes, and counts the request as possibly billed', async () => {
    vi.useFakeTimers();
    const { path, usage, requests, firstPost, provider } = await setup({ listed: [{ id: 'other-length', ago: -1000, seconds: 18 }] });
    const result = provider.align({ path, duration: 225 }, { language: 'en' });
    const outcome = expect(result).rejects.toThrow(/^ElevenLabs did not answer within 10 min for audio\.wav, and its transcript did not show up in the transcript list\. The request may still finish \(and be billed\) at ElevenLabs\. This is usually a slowdown on the service's side: run the command again later, raise ELEVENLABS_TIMEOUT_SECONDS, or use another provider\.$/);
    await firstPost;
    await vi.advanceTimersByTimeAsync(600_000);
    await outcome;
    expect(posts(requests)).toHaveLength(1);
    // the transcript of another length is fetched once, then skipped
    expect(requests.filter((r) => r.startsWith('GET /v1/speech-to-text/transcripts/'))).toEqual(['GET /v1/speech-to-text/transcripts/other-length']);
    expect(usage).toEqual([{ audioSeconds: 225, timedOut: true }]);
  });

  it('gives a long file more time: looks after 0.2 s and gives up after 1 s per audio second', async () => {
    vi.useFakeTimers();
    const { path, requests, firstPost, provider } = await setup();
    const result = provider.align({ path, duration: 1800 }, {});
    const outcome = expect(result).rejects.toThrow(/within 30 min for audio\.wav/);
    await firstPost;
    await vi.advanceTimersByTimeAsync(359_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toEqual(['POST /v1/speech-to-text', 'GET /v1/speech-to-text/transcripts']);
    await vi.advanceTimersByTimeAsync(1_800_000 - 360_000);
    await outcome;
    expect(posts(requests)).toHaveLength(1);
  });

  it('ELEVENLABS_TIMEOUT_SECONDS replaces the time before giving up (and the lookup starts no later)', async () => {
    vi.useFakeTimers();
    const { path, requests, firstPost, provider } = await setup({ env: { ELEVENLABS_TIMEOUT_SECONDS: '5' } });
    const result = provider.align({ path, duration: 225 }, {});
    const outcome = expect(result).rejects.toThrow(/^ElevenLabs did not answer within 5 s for audio\.wav/);
    await firstPost;
    await vi.advanceTimersByTimeAsync(5000);
    await outcome;
    expect(posts(requests)).toHaveLength(1);
  });

  it('checks ELEVENLABS_TIMEOUT_SECONDS before any work', async () => {
    await expect(elevenlabsProvider.preflight!({ ELEVENLABS_TIMEOUT_SECONDS: 'soon' }, 'scribe_v2', { role: 'timing', id: 'elevenlabs:scribe_v2', cwd: '.' })).rejects.toThrow(UserError);
    await expect(elevenlabsProvider.preflight!({ ELEVENLABS_TIMEOUT_SECONDS: '120' }, 'scribe_v2', { role: 'timing', id: 'elevenlabs:scribe_v2', cwd: '.' })).resolves.toBeUndefined();
  });
});

describe('mapScribeResponse', () => {
  it('keeps words, skips spacing and audio events, numbers speakers in order of appearance', () => {
    const res = mapScribeResponse({
      language_code: 'eng',
      words: [
        { text: 'Hi', type: 'word', start: 0.1, end: 0.3, speaker_id: 'speaker_3', logprob: 0 },
        { text: ' ', type: 'spacing', start: 0.3, end: 0.4, speaker_id: 'speaker_3' },
        { text: '(laughter)', type: 'audio_event', start: 0.4, end: 0.9, speaker_id: 'speaker_3' },
        { text: ' ', type: 'spacing', start: 0.9, end: 1.0, speaker_id: 'speaker_3' },
        { text: 'Maya.', type: 'word', start: 1.0, end: 1.4, speaker_id: 'speaker_3', logprob: Math.log(0.5) },
        { text: ' ', type: 'spacing', start: 1.4, end: 2.0 },
        { text: 'Hello.', type: 'word', start: 2.0, end: 2.4, speaker_id: 'speaker_0', logprob: -0.1 },
      ],
    });
    expect(res.text).toBe('Hi Maya. Hello.');
    expect(res.language).toBe('en');
    expect(res.words).toEqual([
      { text: 'Hi', start: 0.1, end: 0.3, speaker: 'S1', confidence: 1 },
      { text: 'Maya.', start: 1, end: 1.4, speaker: 'S1', confidence: 0.5 },
      { text: 'Hello.', start: 2, end: 2.4, speaker: 'S2', confidence: 0.905 },
    ]);
  });

  it('gives zero-length words 10 ms, drops untimed words, keeps the previous speaker for a missing one', () => {
    const res = mapScribeResponse({
      words: [
        { text: 'a', type: 'word', start: 1, end: 1, speaker_id: 'speaker_1' },
        { text: 'b', type: 'word', start: null, end: null, speaker_id: 'speaker_0' },
        { text: 'c', type: 'word', start: 1.5, end: 1.7, speaker_id: null },
      ],
    });
    expect(res.words).toEqual([
      { text: 'a', start: 1, end: 1.01, speaker: 'S1' },
      { text: 'c', start: 1.5, end: 1.7, speaker: 'S1' },
    ]);
  });

  it('attaches a punctuation-only token to the previous word, in the words and in the text', () => {
    const res = mapScribeResponse({
      words: [
        { text: '...', type: 'word', start: 0, end: 0.1, speaker_id: 'speaker_0' },
        { text: 'Mm', type: 'word', start: 0.2, end: 0.4, speaker_id: 'speaker_0' },
        { text: ' ', type: 'spacing', start: 0.4, end: 0.5 },
        { text: '...', type: 'word', start: 0.5, end: 0.9, speaker_id: 'speaker_1' },
        { text: ' ', type: 'spacing', start: 0.9, end: 1.0 },
        { text: 'and', type: 'word', start: 1.0, end: 1.2, speaker_id: 'speaker_1' },
      ],
    });
    expect(res.words).toEqual([
      { text: 'Mm...', start: 0.2, end: 0.4, speaker: 'S1' },
      { text: 'and', start: 1, end: 1.2, speaker: 'S2' },
    ]);
    expect(res.text).toBe('Mm... and');
  });

  it('sorts by start and numbers speakers in the sorted order', () => {
    const res = mapScribeResponse({
      words: [
        { text: 'later', type: 'word', start: 2, end: 2.5, speaker_id: 'speaker_0' },
        { text: 'first', type: 'word', start: 0, end: 0.5, speaker_id: 'speaker_1' },
      ],
    });
    expect(res.words.map((w) => [w.text, w.speaker])).toEqual([['first', 'S1'], ['later', 'S2']]);
  });
});

describe('Scribe language codes', () => {
  it('sends ISO 639-3 codes for Overtone languages and locales; unknown ones are left to detection', () => {
    expect(toScribeLanguage('en')).toBe('eng');
    expect(toScribeLanguage('nl-BE')).toBe('nld');
    expect(toScribeLanguage('pt_BR')).toBe('por');
    expect(toScribeLanguage('yue')).toBe('yue');
    expect(toScribeLanguage('nld')).toBe('nld');
    expect(toScribeLanguage('xx')).toBeUndefined();
    expect(toScribeLanguage(undefined)).toBeUndefined();
  });

  it('maps the reported code back to ISO 639-1 where there is one', () => {
    expect(fromScribeLanguage('eng')).toBe('en');
    expect(fromScribeLanguage('nld')).toBe('nl');
    expect(fromScribeLanguage('cmn')).toBe('zh');
    expect(fromScribeLanguage('yue')).toBe('yue');
    expect(fromScribeLanguage('')).toBeUndefined();
  });
});

describe('keyterms', () => {
  it('dedupes and drops terms outside the documented limits', () => {
    const { keep, dropped } = keyterms([' DriveCover ', 'drivecover', 'Lumora  Insurance', 'a b c d e f', 'x'.repeat(50), '[tag]', '']);
    expect(keep).toEqual(['DriveCover', 'Lumora Insurance']);
    expect(dropped).toEqual(['a b c d e f', 'x'.repeat(50), '[tag]']);
  });

  it(`keeps at most ${MAX_KEYTERMS}`, () => {
    const { keep, dropped } = keyterms(Array.from({ length: MAX_KEYTERMS + 3 }, (_, i) => `term${i}`));
    expect(keep).toHaveLength(MAX_KEYTERMS);
    expect(dropped).toHaveLength(3);
  });
});
