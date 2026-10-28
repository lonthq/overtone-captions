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

function requestBody(body: unknown): unknown {
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
    let body: unknown = r(text);
    if ((headers['content-type'] ?? '').includes('json')) {
      try {
        body = JSON.parse(r(text)) as unknown;
      } catch {
        // keep the text
      }
    }
    const reqBody = requestBody(init?.body);
    const exchange: RecordedExchange = {
      request: { method: init?.method ?? 'GET', url: r(url), ...(reqBody !== undefined ? { body: typeof reqBody === 'string' ? r(reqBody) : JSON.parse(r(JSON.stringify(reqBody))) as unknown } : {}) },
      response: { status: res.status, headers, body },
    };
    const n = (recorded.get(dir) ?? 0) + 1;
    recorded.set(dir, n);
    const file = join(dir, `${String(n).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(exchange, null, 2)}\n`, 'utf8');
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
