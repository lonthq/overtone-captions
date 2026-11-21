// Google Cloud Speech-to-Text v2, Chirp 3: the spoken language of a short WAV sample (the `language` role).
// API as documented on 2026-11-20 (docs.cloud.google.com/speech-to-text/docs/models/chirp-3): Speech.Recognize, sync,
// inline `content` (≤ 10 MB, best under 1 minute), `languageCodes: ["auto"]` detects the most prevalent language and
// each result carries `languageCode`. No language confidence is returned. Auth: OAuth access token from a service
// account key (JWT bearer grant), signed here with node:crypto.
import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UserError } from '../errors.js';
import { normalizeLanguageCode } from '../text/detect.js';
import { httpStatus, reportTimeouts, retryTimeoutsOnce, withDeadline, withRetry, type RetryOptions } from '../util/retry.js';
import { audioTimeoutMs, defineProvider, envEnum, envString, httpErrorFrom, type ProviderDescriptor, type UsageCallback } from './kit.js';
import type { AudioFile, LanguageProvider, LanguageResult } from './types.js';

export const CHIRP_MODEL = 'chirp_3';
export const CHIRP_REGIONS = ['eu', 'us'] as const;
export type ChirpRegion = (typeof CHIRP_REGIONS)[number];
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Token lifetime asked for (s); the maximum Google allows. */
const TOKEN_SECONDS = 3600;
/** A 30 s sample answers in a few seconds; allow for a slow service. */
const TIMEOUT = { minMs: 60_000, msPerAudioSecond: 1000 } as const;
/** Per-attempt timeout of the token request. */
const TOKEN_TIMEOUT_MS = 30_000;

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

/** The service account key file in GOOGLE_APPLICATION_CREDENTIALS; a UserError that names the fix otherwise. */
export async function readServiceAccount(path: string): Promise<ServiceAccount> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new UserError(`GOOGLE_APPLICATION_CREDENTIALS: cannot read ${path}; set it to the path of a service account JSON key file.`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new UserError(`GOOGLE_APPLICATION_CREDENTIALS: ${path} is not JSON; download a service account key (JSON) from the Google Cloud console.`);
  }
  if (json.type !== 'service_account' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
    throw new UserError(`GOOGLE_APPLICATION_CREDENTIALS: ${path} is not a service account key file (type "service_account" with client_email and private_key).`);
  }
  try {
    createPrivateKey(json.private_key);
  } catch {
    throw new UserError(`GOOGLE_APPLICATION_CREDENTIALS: ${path} has an unreadable private_key; download a new key for the service account from the Google Cloud console.`);
  }
  return { client_email: json.client_email, private_key: json.private_key, ...(typeof json.token_uri === 'string' ? { token_uri: json.token_uri } : {}) };
}

/** GOOGLE_CHIRP_REGION: eu (default) or us, any case. */
export function chirpRegion(env: NodeJS.ProcessEnv): ChirpRegion {
  return envEnum(env, 'GOOGLE_CHIRP_REGION', CHIRP_REGIONS) ?? 'eu';
}

/** GOOGLE_APPLICATION_CREDENTIALS, resolved against `cwd`; a UserError naming the variable when unset. */
function credentialsPath(env: NodeJS.ProcessEnv, cwd: string): string {
  const path = envString(env, 'GOOGLE_APPLICATION_CREDENTIALS');
  if (!path) throw new UserError('GOOGLE_APPLICATION_CREDENTIALS is not set; set it to the path of a service account JSON key file.');
  return resolve(cwd, path);
}

/** For `httpErrorFrom`: an OAuth error body's `error_description`, else its `error`. */
function oauthError(body: string): string | undefined {
  const j = JSON.parse(body) as { error?: unknown; error_description?: unknown } | null;
  if (typeof j?.error_description === 'string') return j.error_description;
  return typeof j?.error === 'string' ? j.error : undefined;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** The signed JWT for the token request (RS256). */
export function signJwt(sa: ServiceAccount, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? DEFAULT_TOKEN_URI, iat: nowSeconds, exp: nowSeconds + TOKEN_SECONDS }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Words in `text`, by Intl.Segmenter (scripts without spaces count per word, not per line). */
export function countWords(text: string): number {
  let n = 0;
  for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (s.isWordLike) n++;
  return n;
}

interface RecognizeResponse { results?: Array<{ alternatives?: Array<{ transcript?: string }>; languageCode?: string }> }

/** Words per primary language code over the results; results without a known language are left out. */
export function mapChirpResults(json: RecognizeResponse): LanguageResult {
  const words: Record<string, number> = {};
  for (const r of json.results ?? []) {
    const code = normalizeLanguageCode(r.languageCode);
    const n = countWords(r.alternatives?.[0]?.transcript ?? '');
    if (code && n > 0) words[code] = (words[code] ?? 0) + n;
  }
  return { words };
}

export interface ChirpConfig {
  id: string;
  credentials: string;
  project: string;
  region: ChirpRegion;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  usage?: UsageCallback;
  now?: () => number;
}

export class ChirpLanguageProvider implements LanguageProvider {
  readonly id: string;
  /** In the cache key: another region is another service. */
  readonly settings: Record<string, unknown>;
  private token?: { value: string; expires: number };
  /** The token request in flight, so concurrent first calls share one. */
  private pending?: Promise<string>;

  constructor(private readonly cfg: ChirpConfig) {
    this.id = cfg.id;
    this.settings = { region: cfg.region };
  }

  private accessToken(): Promise<string> {
    const now = (this.cfg.now ?? Date.now)();
    if (this.token && this.token.expires - 60_000 > now) return Promise.resolve(this.token.value);
    this.pending ??= this.fetchToken(now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchToken(now: number): Promise<string> {
    const sa = await readServiceAccount(this.cfg.credentials);
    const doFetch = this.cfg.fetch ?? fetch;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, Math.floor(now / 1000)) }).toString();
    // not billed: a timed-out token request is not reported as usage
    const json = await withRetry(() => withDeadline(TOKEN_TIMEOUT_MS, async (signal) => {
      const res = await doFetch(sa.token_uri ?? DEFAULT_TOKEN_URI, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal });
      if (!res.ok) throw await httpErrorFrom(res, 'Google OAuth', [], oauthError);
      return (await res.json()) as { access_token?: string; expires_in?: number };
    }), retryTimeoutsOnce(this.cfg.retry));
    if (typeof json.access_token !== 'string') throw new Error('Google OAuth answered without an access_token');
    this.token = { value: json.access_token, expires: now + (json.expires_in ?? TOKEN_SECONDS) * 1000 };
    return this.token.value;
  }

  async detect(audio: AudioFile): Promise<LanguageResult> {
    const { region, project } = this.cfg;
    const url = `https://${region}-speech.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${region}/recognizers/_:recognize`;
    const content = (await readFile(audio.path)).toString('base64');
    const body = JSON.stringify({ config: { autoDecodingConfig: {}, languageCodes: ['auto'], model: CHIRP_MODEL }, content });
    const doFetch = this.cfg.fetch ?? fetch;
    const timeoutMs = audioTimeoutMs(audio.duration, TIMEOUT);
    // the token is fetched outside the retry loop, so a retried recognize request never resends the token request
    const recognize = (token: string) => withRetry(reportTimeouts(() => withDeadline(timeoutMs, async (signal) => {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) throw await httpErrorFrom(res, 'Google Speech-to-Text', [token]);
      return (await res.json()) as RecognizeResponse;
    }), () => this.cfg.usage?.({ audioSeconds: audio.duration, timedOut: true })), retryTimeoutsOnce(this.cfg.retry));
    let json: RecognizeResponse;
    try {
      json = await recognize(await this.accessToken());
    } catch (err) {
      // a revoked or expired token: fetch a new one and send the request once more
      if (httpStatus(err) !== 401) throw err;
      this.token = undefined;
      json = await recognize(await this.accessToken());
    }
    this.cfg.usage?.({ audioSeconds: audio.duration });
    return mapChirpResults(json);
  }
}

export const googleChirpProvider: ProviderDescriptor = defineProvider({
  id: 'google-chirp',
  description: 'Google Cloud Speech-to-Text v2, Chirp 3: the spoken language of audio samples (--detect)',
  roles: ['language'],
  env: [
    { name: 'GOOGLE_APPLICATION_CREDENTIALS', description: 'path to a service account JSON key file, e.g. /secrets/overtone-speech.json', required: true },
    { name: 'GOOGLE_CLOUD_PROJECT', description: 'Google Cloud project id with the Speech-to-Text API enabled, e.g. my-project', required: true },
    { name: 'GOOGLE_CHIRP_REGION', description: 'eu (default) or us' },
  ],
  defaults: { language: CHIRP_MODEL },
  normalizeModel(model) {
    if (model.toLowerCase() !== CHIRP_MODEL) throw new UserError(`Unknown google-chirp model "${model}"; supported: ${CHIRP_MODEL}.`);
    return CHIRP_MODEL;
  },
  async preflight(env, _model, deps) {
    chirpRegion(env);
    await readServiceAccount(credentialsPath(env, deps.cwd));
  },
  create(env, _model, deps) {
    return new ChirpLanguageProvider({
      id: deps.id,
      credentials: credentialsPath(env, deps.cwd),
      project: envString(env, 'GOOGLE_CLOUD_PROJECT')!,
      region: chirpRegion(env),
      fetch: deps.fetch,
      retry: deps.retry,
      usage: deps.usage,
    });
  },
});
