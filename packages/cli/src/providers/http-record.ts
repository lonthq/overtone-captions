import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './kit.js';

/**
 * One HTTP exchange written by `recordingFetch` and replayed by the conformance kit (test/conformance/replay.ts).
 * Request headers are never recorded: they hold the keys.
 */
export interface RecordedExchange {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

/** Response headers to keep: content type and what the retry logic reads. */
const KEEP_HEADERS = ['content-type', 'retry-after', 'retry-after-ms', 'x-should-retry'];

/**
 * Credential fields of token exchanges (OAuth 2.0: RFC 6749, RFC 7523 JWT bearer grants, OpenID Connect): their values
 * are replaced in recorded JSON and form bodies, request and response, as they are no env variable to redact.
 */
export const CREDENTIAL_FIELDS: readonly string[] = ['access_token', 'refresh_token', 'id_token', 'assertion', 'client_secret'];
const REDACTED_FIELD = 'REDACTED';

/** A JSON value with every CREDENTIAL_FIELDS value replaced, at any depth. */
export function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CREDENTIAL_FIELDS.includes(k) ? REDACTED_FIELD : redactCredentialFields(v)]));
}

/** An application/x-www-form-urlencoded body with every CREDENTIAL_FIELDS value replaced. */
export function redactCredentialForm(body: string): string {
  const form = new URLSearchParams(body);
  if (!CREDENTIAL_FIELDS.some((f) => form.has(f))) return body;
  for (const f of CREDENTIAL_FIELDS) if (form.has(f)) form.set(f, REDACTED_FIELD);
  return form.toString();
}

const isForm = (contentType: string | null | undefined) => (contentType ?? '').toLowerCase().includes('application/x-www-form-urlencoded');

function requestBody(body: unknown): unknown {
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body !== 'string') return body === undefined || body === null ? undefined : '[binary or multipart body not recorded]';
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** Exchange count per folder, shared by all recorders: a run creates a provider twice (preflight, run). */
const recorded = new Map<string, number>();

/**
 * A fetch that saves each exchange to `<dir>/<NNN>-<label>.json`, secrets redacted everywhere. Enabled by
 * OVERTONE_RECORD_HTTP=<dir> (docs/contributing/providers.md, "Record fixtures"). Streams are read in full before
 * they are passed on, so record with short media.
 */
export function recordingFetch(dir: string, label: string, secrets: readonly string[], inner: typeof fetch = fetch): typeof fetch {
  mkdirSync(dir, { recursive: true });
  const r = (s: string) => redact(s, secrets);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await inner(input, init);
    if (url.startsWith('data:')) return res; // the OpenAI SDK's multipart probe
    const text = await res.text();
    const headers: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    let body: unknown = isForm(headers['content-type']) ? redactCredentialForm(r(text)) : r(text);
    if ((headers['content-type'] ?? '').includes('json')) {
      try {
        body = redactCredentialFields(JSON.parse(r(text)));
      } catch {
        // keep the text
      }
    }
    const reqBody = requestBody(init?.body);
    const formRequest = init?.body instanceof URLSearchParams || isForm(new Headers(init?.headers).get('content-type'));
    const recordedReqBody = reqBody === undefined ? undefined : typeof reqBody === 'string'
      ? (formRequest ? redactCredentialForm(r(reqBody)) : r(reqBody))
      : redactCredentialFields(JSON.parse(r(JSON.stringify(reqBody))));
    const exchange: RecordedExchange = {
      request: { method: init?.method ?? 'GET', url: r(url), ...(reqBody !== undefined ? { body: recordedReqBody } : {}) },
      response: { status: res.status, headers, body },
    };
    const n = (recorded.get(dir) ?? 0) + 1;
    recorded.set(dir, n);
    const file = join(dir, `${String(n).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(exchange, null, 2)}\n`, 'utf8');
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
