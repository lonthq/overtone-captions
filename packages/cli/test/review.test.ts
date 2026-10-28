import { describe, expect, it } from 'vitest';
import { validateFileConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { localEditorWarning } from '../src/pipeline/preflight.js';
import type { TextVote } from '../src/reconcile/vote.js';
import { editReview, reportReview, voteReview } from '../src/review.js';

const vote = (v: Partial<TextVote>): TextVote => ({ start: 1, end: 2, class: 'c', from: 'a', to: 'a', result: 'kept', heard: {}, ...v });

describe('the review list', () => {
  it('takes the edits the editor was not sure about, with its note, in time order', () => {
    const items = editReview([
      { edit: { first: 4, last: 4, to: 'Telkomsel,', reason: 'brand', sure: false, note: 'an Indonesian telecom brand' }, from: 'Telecom Cell,', start: 52.1, end: 52.9 },
      { edit: { first: 1, last: 1, to: 'fifty', reason: 'correction', sure: false, note: '' }, from: 'fifteen', start: 3, end: 3.4 },
    ]);
    expect(items.map((r) => [r.kind, r.to, r.start, r.why])).toEqual([
      ['edit', 'fifty', 3, 'the editor was not sure'],
      ['edit', 'Telkomsel,', 52.1, 'the editor was not sure: an Indonesian telecom brand'],
    ]);
  });

  it('takes the vote\'s changes the chooser wrote itself, not the others', () => {
    const items = voteReview([
      vote({ result: 'changed', to: 'Halo Kick.', review: 'the chooser wrote "Halo Kick."; no engine heard it so there' }),
      vote({ result: 'changed', to: 'b' }),
      vote({ result: 'rejected:repeat', basis: 'a a (x)' }),
    ]);
    expect(items.map((r) => [r.kind, r.to])).toEqual([['vote', 'Halo Kick.']]);
  });

  it('prints a block with a line per item, and nothing for an empty list', () => {
    const log = memoryLogger();
    reportReview([], log);
    expect(log.lines).toEqual([]);
    reportReview([{ kind: 'edit', start: 72, end: 73, from: 'Telecom Cell,', to: 'Telkomsel,', why: 'the editor was not sure' }], log);
    expect(log.lines).toEqual([
      'info: review: 1 change to check by ear (also in meta.review of the .overtone.json file):',
      'info:   - 1:12 edit "Telecom Cell," → "Telkomsel,": the editor was not sure',
    ]);
  });
});

describe('a local editor', () => {
  it('gets a warning, a cloud editor none', () => {
    expect(localEditorWarning({ provider: 'ollama', id: 'ollama:qwen3:8b' })).toMatch(/the editor is a local model \(ollama:qwen3:8b\)\..*use a cloud editor/);
    expect(localEditorWarning({ provider: 'azure-openai', id: 'azure-openai:gpt-6.1-sol' })).toBeUndefined();
  });
});

describe('edits.minSimilarity', () => {
  it('is ignored with a warning', () => {
    const warnings: string[] = [];
    const cfg = validateFileConfig({ edits: { maxSpan: 4, minSimilarity: 0.5 } }, 'overtone.config.json', (m) => warnings.push(m));
    expect(cfg.edits).toEqual({ maxSpan: 4 });
    expect(warnings).toEqual([expect.stringMatching(/"edits.minSimilarity" is no longer used and is ignored/)]);
  });
});
