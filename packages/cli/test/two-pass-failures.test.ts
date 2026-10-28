import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import type { Run } from '../src/pipeline/run.js';
import { twoPassStep, type TwoPassInput } from '../src/pipeline/two-pass.js';
import type { TranscribeChunk } from '../src/pipeline/types.js';
import type { AudioChunk } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { tempDir } from './tmp.js';

const pieces: AudioChunk[] = [0, 1, 2].map((i) => ({ path: `/tmp/chunk-${i}.mp3`, index: i, start: i * 10, end: (i + 1) * 10 }));
const first = (texts: string[]): TranscribeChunk[] => texts.map((text, i) => ({ index: i, start: i * 10, end: (i + 1) * 10, text }));
const word = (text: string, start: number): TimedWord => ({ text, start, end: start + 0.4, speaker: 'S1' });

async function setup(firstTexts: string[], engineWords: TimedWord[], answer: (piece: AudioChunk) => string | Error, same = false) {
  const dir = await tempDir('overtone-two-pass-');
  const cfg = { ...(await resolveConfig({ export: 'json' }, {}, { cwd: dir, configDir: dir })), twoPass: true };
  const log = memoryLogger();
  const sent: number[] = [];
  const run = { cfg, deps: { cwd: dir, log }, log, step: async <T>(_p: string, _n: string, f: () => Promise<T>) => f() } as unknown as Run;
  const input: TwoPassInput = {
    plan: { sel: { timing: { same } } } as unknown as TwoPassInput['plan'],
    calls: {
      pieces,
      transcribe: async (_at, piece) => {
        sent.push(piece.index);
        const a = answer(piece);
        if (a instanceof Error) throw a;
        return { index: piece.index, start: piece.start, end: piece.end, text: a };
      },
    },
    covered: { chunks: first(firstTexts), fallbacks: [], retries: [] } as unknown as TwoPassInput['covered'],
    hearings: { language: 'en', timing: { words: engineWords }, engines: [{ id: 'fake:timing', words: engineWords }] } as unknown as TwoPassInput['hearings'],
    context: { inferred: { topic: 'A talk.' }, inferredTerms: [] } as unknown as TwoPassInput['context'],
  };
  return { run, input, log, sent };
}

describe('--two-pass: a failed or pointless second pass keeps the first pass', () => {
  it('keeps the first pass of a chunk whose second-pass request fails (5xx, timeout) and goes on with the others', async () => {
    const words = [word('one', 1), word('two', 11), word('three', 21)];
    const { run, input, log } = await setup(['one', 'two', 'three'], words, (p) => (p.index === 1 ? new Error('HTTP 503 after 3 retries') : `second ${p.index}`));
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['second 0', 'two', 'second 2']);
    expect(log.lines).toContain('warn: --two-pass: chunk 2/3 (0:00:10–0:00:20) failed (HTTP 503 after 3 retries); keeping the first pass there. The failed request is not cached: run the command again to retry.');
  });

  it('still stops on an error the user must fix', async () => {
    const { run, input } = await setup(['one', 'two', 'three'], [word('one', 1)], () => new UserError('bad key'));
    await expect(twoPassStep(run, input)).rejects.toThrow('bad key');
  });

  it('keeps an empty first pass where no engine heard words (music, silence), with no second request', async () => {
    const words = [word('one', 1), word('three', 21)];
    const { run, input, log, sent } = await setup(['one', '', 'three'], words, (p) => `made up ${p.index}`);
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['made up 0', '', 'made up 2']);
    expect(sent).toEqual([0, 2]);
    expect(log.lines).toContain('info:   chunk 2/3 (second pass): skipped; the first pass and every engine heard no words there');
  });

  it('still takes a second answer for an empty first pass where an engine heard words', async () => {
    const words = [word('one', 1), word('two', 11), word('three', 21)];
    const { run, input, sent } = await setup(['one', '', 'three'], words, (p) => `second ${p.index}`);
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['second 0', 'second 1', 'second 2']);
    expect(sent).toEqual([0, 1, 2]);
  });

  it('with --timing same, still sends an empty chunk again and takes the answer (the text provider is the only engine)', async () => {
    const words = [word('one', 1), word('three', 21)];
    const { run, input, sent } = await setup(['one', '', 'three'], words, (p) => `second ${p.index}`, true);
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['second 0', 'second 1', 'second 2']);
    expect(sent).toEqual([0, 1, 2]);
  });

  it('still sends an empty chunk again when no engine heard any words in the file (timing failed)', async () => {
    const { run, input, sent } = await setup(['one', '', 'three'], [], (p) => `second ${p.index}`);
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['second 0', 'second 1', 'second 2']);
    expect(sent).toEqual([0, 1, 2]);
  });
});
