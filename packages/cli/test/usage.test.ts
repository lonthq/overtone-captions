import { describe, expect, it } from 'vitest';
import { formatUsage, UsageMeter } from '../src/usage.js';

describe('timed-out requests in the usage', () => {
  it('counts them as requests, with their audio, and names them on the usage line', () => {
    const m = new UsageMeter();
    m.add({ id: 'azure-openai:gpt-transcribe', role: 'text', audioSeconds: 60, timedOut: true });
    m.add({ id: 'azure-openai:gpt-transcribe', role: 'text', audioSeconds: 60 });
    m.add({ id: 'azure-openai:gpt-transcribe', role: 'text', audioSeconds: 18.2 });
    m.add({ id: 'azure-openai:gpt-6.1-sol', role: 'llm', timedOut: true });
    m.add({ id: 'azure-openai:gpt-6.1-sol', role: 'llm', inputTokens: 5210, outputTokens: 1032 });
    expect(m.list()).toEqual([
      { id: 'azure-openai:gpt-transcribe', role: 'text', requests: 3, audioSeconds: 138.2, timedOut: 1, timedOutAudioSeconds: 60 },
      { id: 'azure-openai:gpt-6.1-sol', role: 'llm', requests: 2, timedOut: 1, inputTokens: 5210, outputTokens: 1032 },
    ]);
    expect(formatUsage(m.list())).toBe(
      'usage: text azure-openai:gpt-transcribe 3 requests (1 timed out with 60.0 s audio, may be billed), 138.2 s audio'
        + ' · llm azure-openai:gpt-6.1-sol 2 requests (1 timed out, may be billed), 5,210 in / 1,032 out tokens',
    );
  });

  it('leaves the line as it was without them', () => {
    const m = new UsageMeter();
    m.add({ id: 'whisper-cpp:base', role: 'text', audioSeconds: 18 });
    expect(formatUsage(m.list())).toBe('usage: text whisper-cpp:base 1 request, 18.0 s audio');
  });
});
