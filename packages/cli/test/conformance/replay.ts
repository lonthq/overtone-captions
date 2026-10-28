import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Transports for the conformance kit: a fetch that answers from a script of recorded HTTP responses, and
 * helpers for the fixture files. Nothing here reaches the network.
 */

export const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A fixture file as JSON (keys starting with "_" are notes and are kept; providers ignore unknown fields). */
export function fixture<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, path), 'utf8')) as T;
}

/** One scripted HTTP response. `body` objects are sent as JSON, strings as given (e.g. server-sent events). */
export interface Scripted { status?: number; headers?: Record<string, string>; body: unknown }

/** A request as the fake server saw it. FormData becomes an object: strings as is, files as { name, type, size }, repeated fields as arrays. */
export interface Captured { method: string; url: string; headers: Headers; body: unknown }

async function readBody(body: unknown): Promise<unknown> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of body.entries()) {
      const value = typeof v === 'string' ? v : { name: (v as File).name, type: v.type, size: v.size };
      // repeated fields (the SDK sends arrays as `languages[]`, once per item) become arrays
      out[k] = Object.hasOwn(out, k) ? [out[k], value].flat() : value;
    }
    return out;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return `[${(body as ArrayBuffer).byteLength} bytes]`;
  // a stream or Blob (multipart encoded by the SDK itself): parse it as multipart text
  const text = await new Response(body as BodyInit).text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A fetch that answers each call with the next scripted response (the last one repeats) and records the requests.
 * `route` may replace a step by one that depends on the request (a provider that makes two kinds of request per
 * call, such as openai timing: whisper-1 words and diarized segments).
 */
export function replayFetch(script: readonly Scripted[], route?: (step: Scripted, req: Captured) => Scripted): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  let n = 0;
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The OpenAI SDK probes multipart support with a `data:` request before the first upload; that is no API call.
    if (url.startsWith('data:')) return new Response('');
    const req: Captured = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body: await readBody(init?.body) };
    requests.push(req);
    const scripted = script[Math.min(n++, script.length - 1)];
    if (!scripted) throw new Error('replayFetch: empty script');
    const step = route ? route(scripted, req) : scripted;
    const isText = typeof step.body === 'string';
    return new Response(isText ? (step.body as string) : JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': isText ? 'text/event-stream' : 'application/json', ...step.headers },
    });
  }) as typeof fetch;
  return { fetch: f, requests };
}

/** An Anthropic Messages response as the server-sent events the streaming API sends (the documented order). */
export function anthropicSse(message: Record<string, unknown>): string {
  const content = (message.content as Array<{ type: string; text?: string }>) ?? [];
  const usage = (message.usage as Record<string, number>) ?? {};
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }],
  ];
  content.forEach((block, index) => {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, text: '' } }]);
    if (block.text) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? 0 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
