import { createVerify, generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageReport } from '../../src/providers/kit.js';
import { countWords, mapChirpResults } from '../../src/providers/google-chirp.js';
import { createProvider, preflightRole, resolveSelection } from '../../src/providers/registry.js';
import type { LanguageProvider } from '../../src/providers/types.js';
import { tempDir } from '../tmp.js';
import { fixture, replayFetch, type Scripted } from './replay.js';

const TOKEN = 'ya29.fake-access-token-0123456789abcdef';
const token: Scripted = { body: fixture('google/token.json') };
const nl: Scripted = { body: fixture('google/recognize-nl.json') };
const noSleep = { sleep: async () => {} };

/** A service account file with a key generated for this test (never committed). */
async function account() {
  const dir = await tempDir('overtone-chirp-');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = join(dir, 'sa.json');
  await writeFile(file, JSON.stringify({
    type: 'service_account', project_id: 'fake-project', client_email: 'overtone@fake-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token',
  }));
  const wav = join(dir, 'sample.wav');
  await writeFile(wav, Buffer.from('RIFF0000WAVEfmt fake sample'));
  return { dir, file, wav, publicKey, env: { GOOGLE_APPLICATION_CREDENTIALS: file, GOOGLE_CLOUD_PROJECT: 'fake-project' } as NodeJS.ProcessEnv };
}

function build(env: NodeJS.ProcessEnv, steps: Scripted[]) {
  const r = replayFetch(steps);
  const usage: UsageReport[] = [];
  const sel = resolveSelection({ provider: 'google-chirp', id: 'google-chirp' }, 'language');
  const provider = createProvider('language', sel, env, { cwd: '/', deps: { fetch: r.fetch, retry: noSleep }, onUsage: (u) => usage.push(u) }) as LanguageProvider;
  return { provider, requests: () => r.requests, usage, sel };
}

describe('google-chirp', () => {
  it('signs in with the service account and asks Chirp 3 to detect the language', async () => {
    const a = await account();
    const b = build(a.env, [token, nl]);
    expect(b.sel.id).toBe('google-chirp:chirp_3');
    const res = await b.provider.detect({ path: a.wav, duration: 30 });
    expect(res).toEqual({ words: { nl: 15, en: 2 } });

    const [tokenReq, recognize] = b.requests();
    expect(tokenReq!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(tokenReq!.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'overtone@fake-project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token' });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(a.publicKey, Buffer.from(s!, 'base64url'))).toBe(true);

    expect(recognize!.url).toBe('https://eu-speech.googleapis.com/v2/projects/fake-project/locations/eu/recognizers/_:recognize');
    expect(recognize!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = recognize!.body as { config: Record<string, unknown>; content: string };
    expect(body.config).toEqual({ autoDecodingConfig: {}, languageCodes: ['auto'], model: 'chirp_3' });
    expect(Buffer.from(body.content, 'base64').toString()).toBe('RIFF0000WAVEfmt fake sample');
    expect(b.usage).toEqual([expect.objectContaining({ role: 'language', id: 'google-chirp:chirp_3', audioSeconds: 30 })]);
  });

  it('uses GOOGLE_CHIRP_REGION and fetches the token once for several samples', async () => {
    const a = await account();
    const b = build({ ...a.env, GOOGLE_CHIRP_REGION: 'US' }, [token, nl, nl]);
    await b.provider.detect({ path: a.wav, duration: 30 });
    await b.provider.detect({ path: a.wav, duration: 30 });
    expect(b.requests().map((r) => new URL(r.url).host)).toEqual(['oauth2.googleapis.com', 'us-speech.googleapis.com', 'us-speech.googleapis.com']);
  });

  it('retries a 503 but not a 403, and never shows the token', async () => {
    const a = await account();
    const retried = build(a.env, [token, { status: 503, body: { error: { message: 'unavailable' } } }, nl]);
    await expect(retried.provider.detect({ path: a.wav, duration: 30 })).resolves.toEqual({ words: { nl: 15, en: 2 } });
    const denied = build(a.env, [token, { status: 403, body: { error: { message: `permission denied for ${TOKEN}` } } }]);
    const err = (await denied.provider.detect({ path: a.wav, duration: 30 }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/403|permission/i);
    expect(err.message).not.toContain(TOKEN);
    expect(denied.requests()).toHaveLength(2);
  });

  it('refuses a missing credentials file and an unknown region before any request', async () => {
    const a = await account();
    const sel = resolveSelection({ provider: 'google-chirp', id: 'google-chirp' }, 'language');
    await expect(preflightRole('language', sel, { ...a.env, GOOGLE_APPLICATION_CREDENTIALS: join(a.dir, 'missing.json') }, { cwd: '/' }))
      .rejects.toMatchObject({ name: 'UserError', message: expect.stringContaining('GOOGLE_APPLICATION_CREDENTIALS') });
    await writeFile(join(a.dir, 'bad.json'), '{"type":"authorized_user"}');
    await expect(preflightRole('language', sel, { ...a.env, GOOGLE_APPLICATION_CREDENTIALS: join(a.dir, 'bad.json') }, { cwd: '/' }))
      .rejects.toMatchObject({ name: 'UserError', message: expect.stringContaining('service account') });
    await expect(preflightRole('language', sel, { ...a.env, GOOGLE_CHIRP_REGION: 'asia' }, { cwd: '/' }))
      .rejects.toMatchObject({ name: 'UserError', message: expect.stringContaining('GOOGLE_CHIRP_REGION') });
    await expect(preflightRole('language', sel, a.env, { cwd: '/' })).resolves.toBeUndefined();
  });
});

describe('google-chirp tokens and keys', () => {
  it('fetches one token for concurrent first calls', async () => {
    const a = await account();
    const b = build(a.env, [token, nl, nl]);
    await Promise.all([b.provider.detect({ path: a.wav, duration: 30 }), b.provider.detect({ path: a.wav, duration: 30 })]);
    expect(b.requests().map((r) => new URL(r.url).host)).toEqual(['oauth2.googleapis.com', 'eu-speech.googleapis.com', 'eu-speech.googleapis.com']);
  });

  it('does not resend the token request when the recognize request is retried', async () => {
    const a = await account();
    const unavailable: Scripted = { status: 503, body: { error: { message: 'unavailable' } } };
    const b = build(a.env, [token, unavailable, unavailable, nl]);
    await b.provider.detect({ path: a.wav, duration: 30 });
    expect(b.requests().map((r) => new URL(r.url).host)).toEqual(['oauth2.googleapis.com', 'eu-speech.googleapis.com', 'eu-speech.googleapis.com', 'eu-speech.googleapis.com']);
  });

  it('fetches a new token once after a 401', async () => {
    const a = await account();
    const b = build(a.env, [token, { status: 401, body: { error: { message: 'invalid credentials' } } }, token, nl]);
    await expect(b.provider.detect({ path: a.wav, duration: 30 })).resolves.toEqual({ words: { nl: 15, en: 2 } });
    expect(b.requests().map((r) => new URL(r.url).host)).toEqual(['oauth2.googleapis.com', 'eu-speech.googleapis.com', 'oauth2.googleapis.com', 'eu-speech.googleapis.com']);
  });

  it('shows the OAuth error_description when the token request fails', async () => {
    const a = await account();
    const b = build(a.env, [{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }]);
    await expect(b.provider.detect({ path: a.wav, duration: 30 })).rejects.toThrow(/Google OAuth returned HTTP 400: Invalid JWT Signature\./);
  });

  it('refuses a service account file whose private_key cannot be read', async () => {
    const a = await account();
    const bad = join(a.dir, 'bad-key.json');
    await writeFile(bad, JSON.stringify({ type: 'service_account', client_email: 'x@fake-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n' }));
    const sel = resolveSelection({ provider: 'google-chirp', id: 'google-chirp' }, 'language');
    await expect(preflightRole('language', sel, { ...a.env, GOOGLE_APPLICATION_CREDENTIALS: bad }, { cwd: '/' }))
      .rejects.toMatchObject({ name: 'UserError', message: expect.stringMatching(/GOOGLE_APPLICATION_CREDENTIALS.*unreadable private_key/) });
  });
});

describe('mapChirpResults and countWords', () => {
  it('counts words per primary code and handles scripts without spaces', () => {
    expect(countWords('goedemorgen allemaal, en welkom!')).toBe(4);
    expect(countWords('今日は良い天気です')).toBeGreaterThan(1);
    expect(mapChirpResults({ results: [{ alternatives: [{ transcript: 'hola a todos' }], languageCode: 'es-ES' }, { alternatives: [] }] })).toEqual({ words: { es: 3 } });
    expect(mapChirpResults({})).toEqual({ words: {} });
  });
});
