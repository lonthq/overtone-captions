import { describe, expect, it } from 'vitest';
import { runLimited } from '../src/refine/llm-steps.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runLimited after a failure', () => {
  it('starts no queued task, waits for the running ones and rejects with the first error', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const boom = new Error('LLM request failed');
    const tasks = Array.from({ length: 8 }, (_, i) => async () => {
      started.push(i);
      if (i === 1) {
        await sleep(5);
        throw boom;
      }
      await sleep(i === 0 || i === 2 ? 30 : 5);
      finished.push(i);
      return i;
    });
    const err = await runLimited(tasks, 3).catch((e: unknown) => e);
    expect(err).toBe(boom);
    // 0, 1 and 2 were in flight; the failure of 1 stops 3..7 from starting
    expect(started.sort()).toEqual([0, 1, 2]);
    // the in-flight tasks were settled before the rejection, not abandoned
    expect(finished.sort()).toEqual([0, 2]);
  });

  it('keeps the first error when a running task fails later too', async () => {
    const first = new Error('first');
    const tasks = [
      async () => { await sleep(5); throw first; },
      async () => { await sleep(20); throw new Error('second'); },
      async () => 3,
    ];
    await expect(runLimited(tasks, 2)).rejects.toBe(first);
  });

  it('does not start a task still waiting for its delay when another fails', async () => {
    const started: number[] = [];
    const tasks = [
      async () => { started.push(0); throw new Error('fails at once'); },
      async () => { started.push(1); return 1; },
    ];
    await expect(runLimited(tasks, 2, [0, 30])).rejects.toThrow('fails at once');
    expect(started).toEqual([0]);
  });
});
