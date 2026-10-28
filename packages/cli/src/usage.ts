import type { Role, UsageReport } from './providers/kit.js';

/** Usage of one provider in one role, summed over the run. */
export interface UsageTotal {
  id: string;
  role: Role;
  /** Requests sent in this run, timed-out ones included. */
  requests: number;
  /** Of `requests`: those that timed out; the service may still bill them. */
  timedOut?: number;
  /** Of `audioSeconds`: the timed-out requests' audio. */
  timedOutAudioSeconds?: number;
  /** Requests answered from the request cache (not sent, not billed). */
  cachedRequests?: number;
  audioSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Sums the usage providers report in one run and counts cache hits (which report nothing). Shown on the `usage:` line
 * and returned in PipelineResult.usage; never part of a cache key or the document.
 */
export class UsageMeter {
  private readonly totals = new Map<string, UsageTotal>();

  private total(id: string, role: Role): UsageTotal {
    const key = `${role}\0${id}`;
    let t = this.totals.get(key);
    if (!t) {
      t = { id, role, requests: 0 };
      this.totals.set(key, t);
    }
    return t;
  }

  /** A request of `id` in `role` answered from the request cache. */
  readonly cached = (r: { id: string; role: Role }): void => {
    const t = this.total(r.id, r.role);
    t.cachedRequests = (t.cachedRequests ?? 0) + 1;
  };

  readonly add = (r: UsageReport): void => {
    const t = this.total(r.id, r.role);
    t.requests += 1;
    const sum = (field: 'audioSeconds' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens') => {
      const v = r[field];
      if (typeof v === 'number' && Number.isFinite(v)) t[field] = (t[field] ?? 0) + v;
    };
    sum('audioSeconds');
    sum('inputTokens');
    sum('outputTokens');
    sum('cachedInputTokens');
    sum('reasoningTokens');
    if (r.timedOut) {
      t.timedOut = (t.timedOut ?? 0) + 1;
      if (typeof r.audioSeconds === 'number' && Number.isFinite(r.audioSeconds)) t.timedOutAudioSeconds = (t.timedOutAudioSeconds ?? 0) + r.audioSeconds;
    }
  };

  /** Totals in role order (text, timing, llm), then by id. */
  list(): UsageTotal[] {
    const order: Role[] = ['text', 'timing', 'llm'];
    return [...this.totals.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.id.localeCompare(b.id));
  }
}

const int = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * "usage: text openai:gpt-transcribe 1 request, 18.2 s audio · llm openai:gpt-6.1-sol 4 requests, 5,210 in (3,072
 * cached) / 1,032 out (640 reasoning) tokens"; undefined when no provider was asked anything. Timed-out requests are
 * counted with their audio, since they may be billed: "2 requests (1 timed out with 60.0 s audio, may be billed)".
 * Cache hits come last ("…, 3 from the cache"), or alone when nothing was sent.
 */
export function formatUsage(totals: readonly UsageTotal[]): string | undefined {
  if (totals.length === 0) return undefined;
  const plural = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
  const parts = totals.map((t) => {
    if (t.requests === 0) return `${t.role} ${t.id} ${plural(t.cachedRequests ?? 0)} from the cache`;
    const timedOut = t.timedOut
      ? ` (${t.timedOut} timed out${t.timedOutAudioSeconds !== undefined ? ` with ${t.timedOutAudioSeconds.toFixed(1)} s audio` : ''}, may be billed)`
      : '';
    const bits = [plural(t.requests) + timedOut];
    if (t.audioSeconds !== undefined) bits.push(`${t.audioSeconds.toFixed(1)} s audio`);
    if (t.inputTokens !== undefined || t.outputTokens !== undefined) {
      const cached = t.cachedInputTokens !== undefined ? ` (${int(t.cachedInputTokens)} cached)` : '';
      const reasoning = t.reasoningTokens !== undefined ? ` (${int(t.reasoningTokens)} reasoning)` : '';
      bits.push(`${int(t.inputTokens ?? 0)} in${cached} / ${int(t.outputTokens ?? 0)} out${reasoning} tokens`);
    }
    if (t.cachedRequests) bits.push(`${t.cachedRequests} from the cache`);
    return `${t.role} ${t.id} ${bits.join(', ')}`;
  });
  return `usage: ${parts.join(' · ')}`;
}
