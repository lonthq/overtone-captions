import { UserError } from '../errors.js';
import { HttpError, retryTimeoutsOnce, withDeadline, withRetry, type RetryOptions } from '../util/retry.js';
import { defineProvider, displayUrl, envInt, envString, flagValue, httpErrorFrom, jsonErrorField, LLM_TIMEOUT_MS, redact, serverTag, tokenUsage, withSettings, type ProviderDescriptor, type UsageCallback } from './kit.js';
import { jsonContent, jsonObjectSystem, responseFormatFrom, type ResponseFormat } from './json-answer.js';
import { LlmFormatError, type LlmProvider, type LlmRequest } from './types.js';

/**
 * A local LLM via Ollama's native POST /api/chat (https://docs.ollama.com/api/chat). Native, not the OpenAI-compatible
 * /v1, because only it takes `options.num_ctx` per request: Ollama's default context is 4K tokens below 24 GB VRAM
 * (https://docs.ollama.com/context-length), which the editor's prompts for a 2.4-minute interview already fill. The
 * /v1 path still works via `--llm openai:<model>` and OPENAI_BASE_URL=http://localhost:11434/v1.
 *
 * As of Ollama 0.40.6 (2026-10-17): `format` takes a JSON schema (constrained decoding) or "json"; `think: false`
 * turns thinking off; `stream: true` sends NDJSON `{ message: { content }, done: false }` and a final `{ done: true,
 * done_reason: "stop" | "length", prompt_eval_count, eval_count }`; an unknown model is 404 `{ "error": "model 'x' not
 * found" }`; GET /api/tags lists `{ models: [{ name, model, … }] }`. Streaming keeps a slow machine's connection
 * alive past the HTTP client's 5-minute header timeout.
 *
 * Timeout: LLM_TIMEOUT_MS without a piece (the first includes model loading) aborts the call; it is resent at most
 * once (`idleTimeoutMs`).
 */
export const OLLAMA_HOST = 'http://localhost:11434';
/**
 * Qwen3 8B: 5.2 GB download (`ollama pull qwen3:8b`), multilingual, 40K context, runs on a 16 GB laptop. A reasoning
 * model; thinking is off by default (OLLAMA_THINK).
 */
export const OLLAMA_DEFAULT_MODEL = 'qwen3:8b';
/** Context per call (OLLAMA_NUM_CTX): a 1200-word window plus its answer. */
export const OLLAMA_DEFAULT_NUM_CTX = 16_384;
/** Longest answer per call (OLLAMA_MAX_TOKENS); longer is reported as cut off. */
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

/** Server root; OLLAMA_BASE_URL may end in /v1 or /api. */
export function ollamaHost(env: NodeJS.ProcessEnv): string {
  return (envString(env, 'OLLAMA_BASE_URL') ?? OLLAMA_HOST).replace(/\/+$/, '').replace(/\/(v1|api)$/, '');
}

/**
 * OLLAMA_THINK → `think`: a flag (default false: 13× faster on the sample), a level "low" | "medium" | "high" (e.g.
 * gpt-oss), or "default" (not sent; the model decides).
 */
export function thinkSetting(env: NodeJS.ProcessEnv): boolean | string | undefined {
  const raw = envString(env, 'OLLAMA_THINK');
  if (raw === undefined) return false;
  const flag = flagValue(raw);
  if (flag !== undefined) return flag;
  const v = raw.toLowerCase();
  if (v === 'default') return undefined;
  if (['low', 'medium', 'high'].includes(v)) return v;
  throw new UserError(`OLLAMA_THINK must be false, true, low, medium, high or default (got "${raw}").`);
}

/** An integer ≥ 256, or `fallback` when unset. */
function tokensFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return envInt(env, name, 256) ?? fallback;
}

export interface OllamaConfig {
  host: string;
  model: string;
  apiKey?: string;
  numCtx: number;
  maxTokens: number;
  think: boolean | string | undefined;
  /** OLLAMA_THINK is set and wins over LlmRequest.effort. */
  thinkFromEnv?: boolean;
  responseFormat: ResponseFormat;
  fetch: typeof fetch;
  retry?: RetryOptions;
  usage?: UsageCallback;
  /** Max wait for the next streamed piece, in ms (default LLM_TIMEOUT_MS). */
  idleTimeoutMs?: number;
}

/** The whole body as text; `onData` runs per piece. */
async function readBody(res: Response, onData: () => void): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    onData();
    text += decoder.decode(value, { stream: true });
  }
}

interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** One NDJSON line. Anything else (e.g. a proxy's HTML page) means a wrong address, not a bad answer. */
function parseChunk(line: string, host: string): ChatChunk {
  try {
    const chunk = JSON.parse(line) as unknown;
    if (chunk && typeof chunk === 'object' && !Array.isArray(chunk)) return chunk as ChatChunk;
  } catch {
    // below
  }
  throw new UserError(`The server at ${displayUrl(host)} did not answer like Ollama (POST /api/chat sent something other than JSON lines). Is OLLAMA_BASE_URL the Ollama server (default ${OLLAMA_HOST})?`);
}

export class OllamaLlmProvider implements LlmProvider {
  constructor(readonly id: string, private readonly cfg: OllamaConfig) {}

  /**
   * OLLAMA_THINK if set; else on for effort 'high' only (thinking makes a local model many times slower); else off.
   */
  think(req: LlmRequest): boolean | string | undefined {
    if (this.cfg.thinkFromEnv || !req.effort) return this.cfg.think;
    return req.effort === 'high';
  }

  body(req: LlmRequest): Record<string, unknown> {
    const jsonObject = this.cfg.responseFormat === 'json_object';
    const think = this.think(req);
    return {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: jsonObject ? jsonObjectSystem(req.system, req.schema) : req.system },
        { role: 'user', content: req.user },
      ],
      format: jsonObject ? 'json' : req.schema,
      stream: true,
      ...(think !== undefined ? { think } : {}),
      options: { num_ctx: this.cfg.numCtx, num_predict: this.cfg.maxTokens },
    };
  }

  async complete<T>(req: LlmRequest): Promise<T> {
    const secrets = this.cfg.apiKey ? [this.cfg.apiKey] : [];
    const { content, last } = await withRetry(() => withDeadline(this.cfg.idleTimeoutMs ?? LLM_TIMEOUT_MS, async (signal, extend) => {
      const res = await this.cfg.fetch(`${this.cfg.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify(this.body(req)),
        signal,
      });
      if (!res.ok) {
        const err = await httpErrorFrom(res, 'Ollama', secrets, jsonErrorField);
        if (res.status === 404) err.message += ` (pull it: ollama pull ${this.cfg.model})`;
        throw err;
      }
      // collect the content; the last chunk has the counts
      let text = '';
      let final: ChatChunk = {};
      // each piece restarts the clock: a slow machine may take long in total but keeps sending
      for (const line of (await readBody(res, extend)).split('\n')) {
        if (!line.trim()) continue;
        const chunk = parseChunk(line, this.cfg.host);
        // mid-stream error (runner crashed or out of memory): retry like a 503
        if (chunk.error) throw new HttpError(503, `Ollama: ${redact(chunk.error, secrets)}`);
        text += chunk.message?.content ?? '';
        final = chunk;
      }
      return { content: text, last: final };
    }), retryTimeoutsOnce(this.cfg.retry));
    this.cfg.usage?.(tokenUsage(last.prompt_eval_count, last.eval_count));
    if (last.done_reason === 'length') throw new LlmFormatError('response was cut off (max tokens; raise OLLAMA_MAX_TOKENS)', { truncated: true });
    if ((last.prompt_eval_count ?? 0) + (last.eval_count ?? 0) >= this.cfg.numCtx) {
      throw new LlmFormatError(`the prompt and the answer filled the whole context window (${this.cfg.numCtx} tokens), so the prompt was cut; raise OLLAMA_NUM_CTX`, { truncated: true });
    }
    const json = jsonContent(content);
    if (!json) throw new LlmFormatError('empty response');
    try {
      return JSON.parse(json) as T;
    } catch {
      throw new LlmFormatError('response is not valid JSON');
    }
  }
}

/** Ollama answers a bare name with its `:latest` tag. */
const sameModel = (have: string, want: string) => have === want || have === `${want}:latest` || `${have}:latest` === want;

export const ollamaProvider: ProviderDescriptor = defineProvider({
  id: 'ollama',
  description: 'a local LLM via Ollama (free, offline; native API, JSON-schema constrained output)',
  roles: ['llm'],
  env: [
    { name: 'OLLAMA_BASE_URL', description: `the server (default ${OLLAMA_HOST})` },
    { name: 'OLLAMA_API_KEY', description: 'only for Ollama\'s cloud (https://ollama.com); a local server needs none', secret: true },
    { name: 'OLLAMA_NUM_CTX', description: `context window per call in tokens (default ${OLLAMA_DEFAULT_NUM_CTX}); more needs more memory` },
    { name: 'OLLAMA_MAX_TOKENS', description: `longest answer per call in tokens (default ${OLLAMA_DEFAULT_MAX_TOKENS})` },
    { name: 'OLLAMA_THINK', description: 'false, true, low, medium, high, or default (the model decides); unset: off, except for steps with effort "high"' },
    { name: 'OLLAMA_RESPONSE_FORMAT', description: 'json_schema (default) or json_object (format "json" plus the schema in the prompt)' },
  ],
  defaults: { llm: OLLAMA_DEFAULT_MODEL },
  modelHint: 'an Ollama model tag, e.g. ollama:qwen3:8b or ollama:llama3.1:8b',
  /** Settings are valid, the server answers and has the model (GET /api/tags; local, free). */
  async preflight(env, model, deps) {
    responseFormatFrom(env, 'OLLAMA_RESPONSE_FORMAT');
    thinkSetting(env);
    tokensFrom(env, 'OLLAMA_NUM_CTX', OLLAMA_DEFAULT_NUM_CTX);
    tokensFrom(env, 'OLLAMA_MAX_TOKENS', OLLAMA_DEFAULT_MAX_TOKENS);
    const host = ollamaHost(env);
    // the address may carry credentials: never print it as given
    const shown = displayUrl(host);
    const apiKey = envString(env, 'OLLAMA_API_KEY');
    let body: { models?: Array<{ name?: string; model?: string }> };
    try {
      const res = await (deps.fetch ?? fetch)(`${host}/api/tags`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new UserError(`Ollama at ${shown} answered HTTP ${res.status} to GET /api/tags; is OLLAMA_BASE_URL right?`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError([
        `Ollama is not reachable at ${shown}.`,
        'Install it from https://ollama.com/download (macOS: brew install ollama), start it (the Ollama app, or `ollama serve`),',
        `and pull the model: ollama pull ${model}`,
      ].join('\n'));
    }
    const ids = (body.models ?? []).map((m) => m.name ?? m.model ?? '');
    if (!ids.some((id) => sameModel(id, model))) {
      throw new UserError(`Ollama has no model "${model}" yet. Pull it first: ollama pull ${model}${ids.length > 0 ? `\n(installed: ${ids.join(', ')})` : ''}`);
    }
  },
  create(env, model, deps) {
    const cfg = {
      host: ollamaHost(env),
      numCtx: tokensFrom(env, 'OLLAMA_NUM_CTX', OLLAMA_DEFAULT_NUM_CTX),
      maxTokens: tokensFrom(env, 'OLLAMA_MAX_TOKENS', OLLAMA_DEFAULT_MAX_TOKENS),
      think: thinkSetting(env),
      thinkFromEnv: envString(env, 'OLLAMA_THINK') !== undefined,
      responseFormat: responseFormatFrom(env, 'OLLAMA_RESPONSE_FORMAT'),
    };
    const provider = new OllamaLlmProvider(deps.id, {
      ...cfg,
      model,
      apiKey: envString(env, 'OLLAMA_API_KEY'),
      fetch: deps.fetch ?? fetch,
      retry: deps.retry,
      usage: deps.usage,
    });
    // cache key: every setting that shapes the request or answer (host as a fingerprint)
    return withSettings(provider, { server: serverTag(cfg.host), numCtx: cfg.numCtx, maxTokens: cfg.maxTokens, think: cfg.thinkFromEnv ? (cfg.think ?? 'default') : undefined, responseFormat: cfg.responseFormat });
  },
});
