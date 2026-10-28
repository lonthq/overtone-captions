import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/providers/types.js';
import { choose, type ChooserItem } from '../src/reconcile/choose.js';
import type { EngineWords } from '../src/reconcile/regions.js';
import { VOTE } from '../src/reconcile/vote.js';

const engines: EngineWords[] = [{ id: 'azure-speech:fast', label: 'Azure Speech', words: [] }];
const item: ChooserItem = {
  region: {
    id: 1, cls: 'c', sub: 'replace-one-engine', first: 0, last: 0, start: 1, end: 1.5, text: 'glass',
    heard: [[{ text: 'claws', start: 1, end: 1.5 }]], around: { text: { before: '', after: '' } },
  },
  before: 'Look at the', after: 'there.', relisten: { span: 'claws', whole: 'look at the claws' },
};

describe('the chooser prompt names the re-listen window', () => {
  it('takes it from VOTE.pad, byte-identical to the earlier hard-coded text', async () => {
    let seen: LlmRequest | undefined;
    const llm = { id: 'fake', complete: async <T>(req: LlmRequest): Promise<T> => { seen = req; return { spans: [] } as T; } };
    await choose(llm, [item], engines, { language: 'en', names: [] });
    expect(seen!.user).toContain(`re-listen of this snippet alone (±${VOTE.pad} s):`);
    // Cached chooser answers are keyed on the prompt: for the current pad the text must not change.
    expect(VOTE.pad).toBe(2.5);
    expect(seen!.user).toContain('- gpt-transcribe re-listen of this snippet alone (±2.5 s): stretch "claws"');
  });
});
