// Summarizes the JSON-lines HTTP log written by meter.mjs.
import { existsSync, readFileSync } from 'node:fs';

export function meterSummary(path) {
  // No log (answered from the cache): same shape, nothing counted.
  const reqs = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const kind = (r) => (/chat\/completions|\/responses$/.test(r.path) ? 'llm' : /audio\/transcriptions/.test(r.path) ? 'transcribe' : /speechtotext|transcriptions:transcribe/i.test(r.path) ? 'speech' : 'other');
  const out = { llm: { requests: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, promptChars: 0, completionChars: 0, missingUsage: 0, seconds: 0, failed: 0 }, transcribe: { requests: 0, seconds: 0, usage: [] }, speech: { requests: 0, seconds: 0 }, other: { requests: 0 } };
  for (const r of reqs) {
    const k = kind(r), o = out[k];
    o.requests++;
    if ('seconds' in o) o.seconds += (r.ms ?? 0) / 1000;
    if (k === 'llm') {
      if (r.status >= 400 || r.error) o.failed++;
      o.promptChars += r.promptChars ?? 0; o.completionChars += r.completionChars ?? 0;
      if (r.usage) {
        o.promptTokens += r.usage.prompt_tokens ?? r.usage.input_tokens ?? 0;
        o.completionTokens += r.usage.completion_tokens ?? r.usage.output_tokens ?? 0;
        o.cachedTokens += r.usage.prompt_tokens_details?.cached_tokens ?? r.usage.input_tokens_details?.cached_tokens ?? 0;
        o.cacheWriteTokens += r.usage.prompt_tokens_details?.cache_write_tokens ?? 0;
        o.reasoningTokens += r.usage.completion_tokens_details?.reasoning_tokens ?? r.usage.output_tokens_details?.reasoning_tokens ?? 0;
      } else if (r.status < 400) o.missingUsage++;
    }
    if (k === 'transcribe' && r.usage) o.usage.push(r.usage);
  }
  return out;
}
