import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './tmp.js';
import type { Usage } from '../src/providers/kit.js';
import { AzureSpeechTimingProvider, DEFAULT_TIMEOUT_MS, MAX_PHRASES, azureSpeechProvider, defaultTimeoutMs, mapFastTranscription, profanityFrom, toLocale, type FastTranscriptionResponse } from '../src/providers/azure-speech.js';
import { alignWords } from '../src/align/align.js';
import { UserError } from '../src/errors.js';
import { tokenizeDisplay } from '../src/text/normalize.js';

/** A fake WAV file in a fresh temp folder. */
async function wav(): Promise<string> {
  const p = join(await tempDir('overtone-az-'), 'audio.wav');
  await writeFile(p, Buffer.from('RIFF'));
  return p;
}

const RESPONSE: FastTranscriptionResponse = {
  durationMilliseconds: 4000,
  combinedPhrases: [{ text: 'Hi Maya. Hello Tom.' }],
  phrases: [
    { speaker: 1, offsetMilliseconds: 2000, durationMilliseconds: 900, text: 'Hello Tom.', locale: 'en-US', confidence: 0.9,
      words: [{ text: 'Hello', offsetMilliseconds: 2000, durationMilliseconds: 400 }, { text: 'Tom.', offsetMilliseconds: 2500, durationMilliseconds: 400 }] },
    { speaker: 0, offsetMilliseconds: 0, durationMilliseconds: 900, text: 'Hi Maya.', locale: 'en-US', confidence: 0.95,
      words: [{ text: 'Hi', offsetMilliseconds: 0, durationMilliseconds: 400 }, { text: 'Maya.', offsetMilliseconds: 500, durationMilliseconds: 400 }] },
  ],
};

describe('mapFastTranscription', () => {
  it('trims words, drops empty ones, and gives a word without duration 10 ms', () => {
    const res: FastTranscriptionResponse = {
      durationMilliseconds: 2000,
      phrases: [{
        offsetMilliseconds: 0, durationMilliseconds: 1000, text: 'uh huh', locale: 'en-US', confidence: 0.9,
        words: [
          { text: ' uh ', offsetMilliseconds: 100, durationMilliseconds: 0 },
          { text: '  ', offsetMilliseconds: 300, durationMilliseconds: 100 },
          { text: 'huh', offsetMilliseconds: 500, durationMilliseconds: 200 },
        ],
      }],
    } as FastTranscriptionResponse;
    expect(mapFastTranscription(res).words.map((w) => [w.text, w.start, w.end])).toEqual([['uh', 0.1, 0.11], ['huh', 0.5, 0.7]]);
  });

  it('maps phrases to timed words with S1/S2 in order of appearance', () => {
    expect(mapFastTranscription(RESPONSE)).toEqual({
      language: 'en-US',
      languagesHeard: { en: 1 },
      words: [
        { text: 'Hi', start: 0, end: 0.4, speaker: 'S1', confidence: 0.95 },
        { text: 'Maya.', start: 0.5, end: 0.9, speaker: 'S1', confidence: 0.95 },
        { text: 'Hello', start: 2, end: 2.4, speaker: 'S2', confidence: 0.9 },
        { text: 'Tom.', start: 2.5, end: 2.9, speaker: 'S2', confidence: 0.9 },
      ],
    });
  });

  it('handles missing speakers, words and phrases', () => {
    expect(mapFastTranscription({})).toEqual({ words: [] });
    expect(mapFastTranscription({ phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 1, text: 'x', words: [{ text: 'x', offsetMilliseconds: 0, durationMilliseconds: 1 }] }] }).words[0].speaker).toBe('S1');
  });
});

describe('candidate languages (--language en,es)', () => {
  it('reports the share of phrase time per language, case-insensitively', () => {
    const res = mapFastTranscription({ phrases: [
      { offsetMilliseconds: 0, durationMilliseconds: 800, text: 'Hello.', locale: 'en-us', words: [{ text: 'Hello.', offsetMilliseconds: 0, durationMilliseconds: 800 }] },
      { offsetMilliseconds: 1000, durationMilliseconds: 200, text: 'Hola.', locale: 'es-ES', words: [{ text: 'Hola.', offsetMilliseconds: 1000, durationMilliseconds: 200 }] },
    ] });
    expect(res.languagesHeard).toEqual({ en: 0.8, es: 0.2 });
  });

  it('leaves locales out when the multi-lingual model covers every candidate', () => {
    const warnings: string[] = [];
    const def = AzureSpeechTimingProvider.definition({ language: 'en', languages: ['en', 'es'] }, (m) => warnings.push(m));
    expect(def).not.toHaveProperty('locales');
    expect(warnings).toEqual([]);
  });

  it('sends every candidate as locales otherwise, and warns that Azure picks one main language', () => {
    const warnings: string[] = [];
    const def = AzureSpeechTimingProvider.definition({ language: 'nl', languages: ['nl', 'en', 'xx'] }, (m) => warnings.push(m));
    expect(def).toHaveProperty('locales', ['nl-NL', 'en-US']);
    expect(warnings[0]).toMatch(/no Azure locale known for 'xx'/);
    expect(warnings[1]).toMatch(/picks one main language from nl-NL, en-US/);
  });
});

describe('toLocale', () => {
  it.each([
    ['en', 'en-US'], ['nl', 'nl-NL'], ['en-GB', 'en-GB'], ['uk', 'uk-UA'], ['cs', 'cs-CZ'], ['el', 'el-GR'],
    ['he', 'he-IL'], ['hi', 'hi-IN'], ['vi', 'vi-VN'], ['ar', 'ar-SA'], ['ca', 'ca-ES'], ['no', 'nb-NO'], ['nb', 'nb-NO'],
    ['da', 'da-DK'], ['sv', 'sv-SE'], ['fi', 'fi-FI'], ['pl', 'pl-PL'], ['tr', 'tr-TR'], ['id', 'id-ID'], ['ms', 'ms-MY'],
    ['th', 'th-TH'], ['ro', 'ro-RO'], ['hu', 'hu-HU'], ['sk', 'sk-SK'], ['bg', 'bg-BG'], ['hr', 'hr-HR'], ['de', 'de-DE'],
    ['fr', 'fr-FR'], ['es', 'es-ES'], ['it', 'it-IT'], ['pt', 'pt-BR'], ['ja', 'ja-JP'], ['ko', 'ko-KR'], ['zh', 'zh-CN'],
    ['NL', 'nl-NL'], ['pt-PT', 'pt-PT'],
  ])('%s → %s', (a, b) => expect(toLocale(a)).toBe(b));
});

describe('toLocale for languages beyond the first table', () => {
  it.each([
    ['et', 'et-EE'], ['sl', 'sl-SI'], ['fa', 'fa-IR'], ['sr', 'sr-RS'], ['af', 'af-ZA'], ['ga', 'ga-IE'], ['gu', 'gu-IN'], ['ur', 'ur-PK'],
    ['lt', 'lt-LT'], ['lv', 'lv-LV'], ['mt', 'mt-MT'], ['is', 'is-IS'], ['sw', 'sw-KE'], ['ta', 'ta-IN'], ['te', 'te-IN'], ['mr', 'mr-IN'],
    ['bn', 'bn-IN'], ['kn', 'kn-IN'], ['ml', 'ml-IN'], ['ne', 'ne-NP'], ['ka', 'ka-GE'], ['hy', 'hy-AM'], ['az', 'az-AZ'], ['kk', 'kk-KZ'],
    ['uz', 'uz-UZ'], ['mk', 'mk-MK'], ['sq', 'sq-AL'], ['bs', 'bs-BA'], ['cy', 'cy-GB'], ['eu', 'eu-ES'], ['gl', 'gl-ES'], ['km', 'km-KH'],
    ['lo', 'lo-LA'], ['my', 'my-MM'], ['mn', 'mn-MN'], ['ps', 'ps-AF'], ['si', 'si-LK'], ['so', 'so-SO'], ['zu', 'zu-ZA'], ['am', 'am-ET'],
    ['jv', 'jv-ID'], ['ET', 'et-EE'],
  ])('%s → %s', (a, b) => expect(toLocale(a)).toBe(b));

  it('has no locale for an unmapped code, and passes codes with a region through', () => {
    expect(toLocale('xx')).toBeUndefined();
    expect(toLocale('fil')).toBeUndefined();
    expect(toLocale('xx-YY')).toBe('xx-YY');
  });
});

describe('AzureSpeechTimingProvider', () => {

  it('builds the definition', () => {
    expect(AzureSpeechTimingProvider.definition({})).toEqual({ diarization: { enabled: true, maxSpeakers: 10 } });
    expect(AzureSpeechTimingProvider.definition({ language: 'nl', phrases: ['DriveCover'] })).toEqual({
      locales: ['nl-NL'], diarization: { enabled: true, maxSpeakers: 10 }, phraseList: { phrases: ['DriveCover'] },
    });
  });

  it('omits locales for a language without a known Azure locale and warns once per request', async () => {
    expect(AzureSpeechTimingProvider.definition({ language: 'xx' })).toEqual({ diarization: { enabled: true, maxSpeakers: 10 } });
    const warnings: string[] = [];
    expect(AzureSpeechTimingProvider.definition({ language: 'xx' }, (m) => warnings.push(m))).not.toHaveProperty('locales');
    expect(warnings).toEqual(["no Azure locale known for 'xx'; letting Azure detect the language"]);
    expect(AzureSpeechTimingProvider.definition({ language: 'nl' }, (m) => warnings.push(m))).toHaveProperty('locales', ['nl-NL']);
    expect(warnings).toHaveLength(1);

    const bodies: unknown[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse((init.body as FormData).get('definition') as string)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const viaProvider: string[] = [];
    await new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f, warn: (m) => viaProvider.push(m) }).align({ path: await wav(), duration: 1 }, { language: 'qq' });
    expect(bodies[0]).not.toHaveProperty('locales');
    expect(viaProvider).toEqual(["no Azure locale known for 'qq'; letting Azure detect the language"]);
  });

  it('posts multipart audio + definition and maps the result', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const p = new AzureSpeechTimingProvider({ key: 'secret', region: 'westeurope', fetch: fakeFetch });
    const res = await p.align({ path: await wav(), duration: 4 }, { language: 'en' });
    expect(res.words).toHaveLength(4);
    expect(seen[0].url).toBe('https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    expect(seen[0].init.headers).toEqual({ 'Ocp-Apim-Subscription-Key': 'secret' });
    const form = seen[0].init.body as FormData;
    expect(JSON.parse(form.get('definition') as string)).toEqual({ locales: ['en-US'], diarization: { enabled: true, maxSpeakers: 10 }, profanityFilterMode: 'None' });
    expect((form.get('audio') as File).name).toBe('audio.wav');
  });

  it('retries 503 and fails clearly on 401', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      return n === 1 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify({ phrases: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: flaky, retry: { sleep: async () => {} } });
    expect(await p.align({ path: await wav(), duration: 1 }, {})).toEqual({ words: [] });
    expect(n).toBe(2);

    const denied = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const q = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: denied, retry: { sleep: async () => {} } });
    await expect(q.align({ path: await wav(), duration: 1 }, {})).rejects.toThrow('Azure Speech returned HTTP 401: {"error":"bad key"}');
  });

  it('uses a custom endpoint when given', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(url); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await new AzureSpeechTimingProvider({ key: 'k', region: 'r', endpoint: 'https://my.cognitiveservices.azure.com/', fetch: f }).align({ path: await wav(), duration: 1 }, {});
    expect(urls[0]).toBe('https://my.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
  });

  it('honours Retry-After on a 429', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(JSON.stringify({ phrases: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const delays: number[] = [];
    const p = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f, retry: { sleep: async (ms) => { delays.push(ms); }, random: () => 0 } });
    await p.align({ path: await wav(), duration: 1 }, {});
    expect(n).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
  });

  it('sends a timeout signal and retries a TimeoutError', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    let n = 0;
    const f = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      n++;
      if (n === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(JSON.stringify({ phrases: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const p = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f, timeoutMs: 5000, retry: { sleep: async () => {} } });
    try {
      expect(await p.align({ path: await wav(), duration: 1 }, {})).toEqual({ words: [] });
      expect(spy).toHaveBeenCalledWith(5000);
    } finally {
      spy.mockRestore();
    }
    expect(n).toBe(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('reports each timed-out attempt as usage that may be billed, besides the answered one', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new DOMException('timeout', 'TimeoutError');
      return new Response(JSON.stringify({ phrases: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const usage: Usage[] = [];
    const p = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f, usage: (u) => usage.push(u), retry: { sleep: async () => {} } });
    await p.align({ path: await wav(), duration: 30 }, {});
    expect(usage).toEqual([{ audioSeconds: 30, timedOut: true }, { audioSeconds: 30 }]);
  });

  it('defaults the request timeout to 10 minutes', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it('never puts the API key in an error message', async () => {
    const f = (async () => new Response('invalid key SECRET-KEY-123 for resource', { status: 401 })) as unknown as typeof fetch;
    const p = new AzureSpeechTimingProvider({ key: 'SECRET-KEY-123', region: 'r', fetch: f, retry: { sleep: async () => {} } });
    const err = await p.align({ path: await wav(), duration: 1 }, {}).catch((e: Error) => e);
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).not.toContain('SECRET-KEY-123');
  });

  it('scales the default timeout with the audio length', () => {
    expect(defaultTimeoutMs(undefined)).toBe(600_000);
    expect(defaultTimeoutMs(60)).toBe(600_000);
    expect(defaultTimeoutMs(7200)).toBe(7200 * 500 + 120_000);
  });

  it('uses the scaled timeout for the request, and timeoutMs overrides it', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const f = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
      await new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f }).align({ path: await wav(), duration: 7200 }, {});
      expect(spy).toHaveBeenLastCalledWith(3_720_000);
      await new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f, timeoutMs: 1234 }).align({ path: await wav(), duration: 7200 }, {});
      expect(spy).toHaveBeenLastCalledWith(1234);
    } finally {
      spy.mockRestore();
    }
  });

  it('retries a TimeoutError at most once, other errors keep the default retries', async () => {
    let n = 0;
    const timeouts = (async () => { n++; throw new DOMException('timeout', 'TimeoutError'); }) as unknown as typeof fetch;
    const p = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: timeouts, retry: { sleep: async () => {} } });
    await expect(p.align({ path: await wav(), duration: 1 }, {})).rejects.toThrow('timeout');
    expect(n).toBe(2);

    let m = 0;
    const busy = (async () => { m++; return new Response('busy', { status: 503 }); }) as unknown as typeof fetch;
    const q = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: busy, retry: { sleep: async () => {} } });
    await expect(q.align({ path: await wav(), duration: 1 }, {})).rejects.toThrow('HTTP 503');
    expect(m).toBe(5);

    // A timeout followed by a 503 still counts the timeout only once.
    let k = 0;
    const mixed = (async () => {
      k++;
      if (k === 1) throw new DOMException('timeout', 'TimeoutError');
      return k === 2 ? new Response('busy', { status: 503 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: mixed, retry: { sleep: async () => {} } });
    expect(await r.align({ path: await wav(), duration: 1 }, {})).toEqual({ words: [] });
    expect(k).toBe(3);
  });

  it('redacts the key before truncating the body to 500 characters', async () => {
    const key = 'SECRET-KEY-1234567890';
    const body = 'x'.repeat(490) + key + 'y'.repeat(100);
    const f = (async () => new Response(body, { status: 400 })) as unknown as typeof fetch;
    const p = new AzureSpeechTimingProvider({ key, region: 'r', fetch: f });
    const err = (await p.align({ path: await wav(), duration: 1 }, {}).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain('SECRET');
    expect(err.message).toContain('[redacted]');
    expect(err.message.length).toBeLessThanOrEqual('Azure Speech returned HTTP 400: '.length + 500);
  });

  it('streams the WAV from disk as a Blob with the right size and type', async () => {
    const seen: FormData[] = [];
    const f = (async (_u: string, init: RequestInit) => { seen.push(init.body as FormData); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await new AzureSpeechTimingProvider({ key: 'k', region: 'r', fetch: f }).align({ path: await wav(), duration: 1 }, {});
    const audio = seen[0].get('audio') as File;
    expect(audio).toBeInstanceOf(Blob);
    expect(audio.type).toBe('audio/wav');
    expect(audio.size).toBe(4);
    expect(await audio.text()).toBe('RIFF');
  });

  it('cleans the phrase list: trim, drop empties, dedupe case-insensitively, cap', () => {
    expect(AzureSpeechTimingProvider.definition({ phrases: ['  Foo ', '', 'foo', 'Bar', '   ', 'FOO'] }).phraseList).toEqual({ phrases: ['Foo', 'Bar'] });
    expect(AzureSpeechTimingProvider.definition({ phrases: ['', '  '] })).toEqual({ diarization: { enabled: true, maxSpeakers: 10 } });
    const many = Array.from({ length: MAX_PHRASES + 50 }, (_, i) => `term${i}`);
    expect((AzureSpeechTimingProvider.definition({ phrases: many }).phraseList as { phrases: string[] }).phrases).toHaveLength(2000);
  });
});

describe('profanity', () => {
  /** Recorded shape of Cosmos Laundromat 4:33 with profanityFilterMode None (the words as spoken). */
  const RAW: FastTranscriptionResponse = {
    phrases: [{ speaker: 0, offsetMilliseconds: 273000, durationMilliseconds: 1800, text: 'Get off my fucking hoofs!', locale: 'en-US', confidence: 0.82,
      words: [
        { text: 'Get', offsetMilliseconds: 273000, durationMilliseconds: 240 },
        { text: 'off', offsetMilliseconds: 273280, durationMilliseconds: 200 },
        { text: 'my', offsetMilliseconds: 273520, durationMilliseconds: 160 },
        { text: 'fucking', offsetMilliseconds: 273720, durationMilliseconds: 480 },
        { text: 'hoofs!', offsetMilliseconds: 274240, durationMilliseconds: 560 },
      ] }],
  };

  it('asks Azure for the words as spoken by default, and takes AZURE_SPEECH_PROFANITY', async () => {
    expect(profanityFrom({})).toBe('none');
    expect(profanityFrom({ AZURE_SPEECH_PROFANITY: ' Masked ' })).toBe('masked');
    expect(profanityFrom({ AZURE_SPEECH_PROFANITY: 'removed' })).toBe('removed');
    expect(() => profanityFrom({ AZURE_SPEECH_PROFANITY: 'tags' })).toThrow(UserError);
    expect(() => profanityFrom({ AZURE_SPEECH_PROFANITY: 'tags' })).toThrow('AZURE_SPEECH_PROFANITY must be one of none, masked, removed (got "tags").');
    expect(AzureSpeechTimingProvider.definition({}, undefined, 'masked')).toMatchObject({ profanityFilterMode: 'Masked' });
    expect(AzureSpeechTimingProvider.definition({}, undefined, 'removed')).toMatchObject({ profanityFilterMode: 'Removed' });

    const bodies: Array<Record<string, unknown>> = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse((init.body as FormData).get('definition') as string)); return new Response(JSON.stringify(RAW), { status: 200 }); }) as unknown as typeof fetch;
    const env = { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'r' };
    const plain = azureSpeechProvider.create(env, 'fast', { role: 'timing', id: 'azure-speech:fast', fetch: f } as never) as AzureSpeechTimingProvider;
    const masked = azureSpeechProvider.create({ ...env, AZURE_SPEECH_PROFANITY: 'masked' }, 'fast', { role: 'timing', id: 'azure-speech:fast', fetch: f } as never) as AzureSpeechTimingProvider;
    await plain.align({ path: await wav(), duration: 1 }, {});
    await masked.align({ path: await wav(), duration: 1 }, {});
    expect(bodies.map((b) => b.profanityFilterMode)).toEqual(['None', 'Masked']);
    // the mode is part of the timing cache key
    expect(plain.settings).toEqual({ profanity: 'none' });
    expect(masked.settings).toEqual({ profanity: 'masked' });
  });

  it("matches the raw words exactly with the text model's words", () => {
    const { words } = mapFastTranscription(RAW);
    const aligned = alignWords(tokenizeDisplay('Get off my fucking hoofs!'), words, { language: 'en' });
    expect(aligned.map((w) => [w.text, w.match, w.start])).toEqual([
      ['Get', 'exact', 273], ['off', 'exact', 273.28], ['my', 'exact', 273.52], ['fucking', 'exact', 273.72], ['hoofs!', 'exact', 274.24],
    ]);
  });
});
