import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/providers/types.js';
import { choose, type ChooserItem } from '../src/reconcile/choose.js';
import type { EngineWords } from '../src/reconcile/regions.js';

const engines: EngineWords[] = [{ id: 'azure-speech:fast', label: 'Azure Speech', words: [] }];
const item: ChooserItem = {
  region: {
    id: 1, cls: 'c', sub: 'replace-one-engine', first: 0, last: 0, start: 1, end: 1.5, text: 'glass',
    heard: [[{ text: 'claws', start: 1, end: 1.5 }]], around: { text: { before: '', after: '' } },
  },
  before: 'Look at the', after: 'there.', relisten: { span: 'claws', whole: 'look at the claws' },
};

async function prompts(textEngine?: string): Promise<LlmRequest> {
  let seen: LlmRequest | undefined;
  const llm = { id: 'fake', complete: async <T>(req: LlmRequest): Promise<T> => { seen = req; return { spans: [] } as T; } };
  await choose(llm, [item], engines, { language: 'en', names: [], ...(textEngine ? { textEngine } : {}) });
  return seen!;
}

describe('the chooser prompt', () => {
  it('names the text engine the caption came from, gpt-transcribe by default', async () => {
    const other = await prompts('whisper-1');
    expect(other.system).toContain('The CURRENT CAPTION comes from the strongest engine (whisper-1)');
    expect(other.user).toContain('- CURRENT CAPTION (whisper-1, whole file)');
    expect(other.user).toContain('- whisper-1 re-listen of this snippet alone');
    expect(`${other.system}${other.user}`).not.toContain('gpt-transcribe');
    const byDefault = await prompts();
    expect(byDefault.system).toContain('The CURRENT CAPTION comes from the strongest engine (gpt-transcribe)');
    expect(byDefault.user).toContain('- CURRENT CAPTION (gpt-transcribe, whole file)');
  });

  it('lets the context decide a line no hearing wrote, and says such a line is listed for review', async () => {
    const { system } = await prompts();
    expect(system).toContain('you may write the words that were said');
    expect(system).toContain('listed for a person to check by ear');
    expect(system).toContain('A number, a negation or a name may change when a hearing or the context makes clear what was said.');
    expect(system).not.toContain('never to invent words no hearing supports');
    expect(system).not.toContain('unless a hearing supports the change');
  });
});
