import Anthropic from '@anthropic-ai/sdk';
import { reportTimeouts, retryTimeoutsOnce, withRetry, type RetryOptions } from '../util/retry.js';
import { defineProvider, envString, LLM_TIMEOUT_MS, serverTag, tokenUsage, withSettings, type ProviderDescriptor, type UsageCallback } from './kit.js';
import { LlmFormatError, RefusalError, type Effort, type LlmProvider, type LlmRequest } from './types.js';

/** LlmRequest.effort → output_config.effort (same values). Unset: 'medium'. */
export function anthropicEffort(effort: Effort | undefined): Effort {
  return effort ?? 'medium';
}

/** A cache entry is readable once the first response has started; stagger shared-prefix requests by this much. */
export const ANTHROPIC_CACHE_WARMUP_MS = 3000;

interface AnthropicMessage {
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null;
    /** Thinking tokens within output_tokens (reported by current models, e.g. Claude Opus 5.5). */
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  };
}

/** The part of the Anthropic SDK client we use (tests pass fakes). */
export interface AnthropicLike {
  messages: { stream(params: Record<string, unknown>, options?: { timeout?: number }): { finalMessage(): Promise<AnthropicMessage> } };
}

/** Default server when ANTHROPIC_BASE_URL is unset. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * No SDK retries (withRetry does them). LLM_TIMEOUT_MS bounds the wait for the stream to start; a timed-out request is
 * resent at most once. A stalled stream is ended by Node's fetch after 5 minutes without data. Server and credentials
 * are passed explicitly: otherwise the SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from process.env (set by
 * gateways and Claude Code), sending requests to an undeclared server with an extra Authorization header and sharing
 * cache entries with api.anthropic.com.
 */
export function createAnthropicClient(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): AnthropicLike {
  return new Anthropic({
    apiKey: envString(env, 'ANTHROPIC_API_KEY'),
    authToken: null,
    baseURL: envString(env, 'ANTHROPIC_BASE_URL') ?? ANTHROPIC_API_URL,
    maxRetries: 0,
    timeout: LLM_TIMEOUT_MS,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }) as unknown as AnthropicLike;
}

/**
 * Structured output via `output_config.format`. Forced tool use is not an option: current models (Claude Opus 5.5,
 * Sonnet 5.5) answer 400 to it. Streaming avoids HTTP timeouts on long edit lists.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly cacheWarmupMs = ANTHROPIC_CACHE_WARMUP_MS;
  constructor(
    readonly id: string,
    private readonly client: AnthropicLike,
    private readonly model: string,
    private readonly retry: RetryOptions = {},
    private readonly usage?: UsageCallback,
  ) {}

  async complete<T>(req: LlmRequest): Promise<T> {
    const msg = await withRetry(
      reportTimeouts(() =>
        this.client.messages
          .stream({
            model: this.model,
            max_tokens: 64_000,
            // the system prompt is the stable, shared part (instructions + transcript): cache it
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: req.user }],
            // without an effort hint 'medium' explicitly, so the result does not depend on the model's default
            output_config: { effort: anthropicEffort(req.effort), format: { type: 'json_schema', schema: req.schema } },
          }, { timeout: LLM_TIMEOUT_MS })
          .finalMessage(), () => this.usage?.({ timedOut: true })),
      retryTimeoutsOnce(this.retry),
    );
    const u = msg.usage;
    // everything the model read: uncached + cache writes + cache reads
    const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined;
    const thinking = u?.output_tokens_details?.thinking_tokens;
    this.usage?.(u ? {
      ...tokenUsage(input, u.output_tokens),
      ...(typeof u.cache_read_input_tokens === 'number' ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
      ...(typeof thinking === 'number' ? { reasoningTokens: thinking } : {}),
    } : {});
    if (msg.stop_reason === 'refusal') throw new RefusalError(this.id, 'model', `${this.id}: the model declined the request`);
    if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') throw new LlmFormatError('response was cut off (max tokens)', { truncated: true });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmFormatError('response is not valid JSON');
    }
  }
}

/** Anthropic Messages API. Default model verified 2026-10-07. */
export const anthropicProvider: ProviderDescriptor = defineProvider({
  id: 'anthropic',
  description: 'Anthropic Claude (Messages API, structured output via output_config.format)',
  roles: ['llm'],
  env: [
    { name: 'ANTHROPIC_API_KEY', description: 'API key (sk-ant-…)', required: true, secret: true },
    { name: 'ANTHROPIC_BASE_URL', description: 'another server for the Messages API, e.g. a gateway (default https://api.anthropic.com)' },
  ],
  defaults: { llm: 'claude-opus-5-5' },
  create(env, model, deps) {
    const client = (deps.anthropic ?? ((e) => createAnthropicClient(e, deps.fetch)))(env);
    // another server may answer differently under the same model name: cache it separately
    return withSettings(new AnthropicLlmProvider(deps.id, client, model, deps.retry, deps.usage), { server: serverTag(envString(env, 'ANTHROPIC_BASE_URL')) });
  },
});
