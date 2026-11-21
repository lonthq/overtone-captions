import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/media/extract.js';
import { LOUDNESS_STANDARD, measureLoudness, parseEbur128 } from '../src/media/loudness.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const summary = (i: string, lra: string, sample: string, truePeak: string) => [
  '[Parsed_ebur128_0 @ 0x77ed42c900] Summary:', '',
  '  Integrated loudness:', `    I:         ${i} LUFS`, '    Threshold: -31.8 LUFS', '',
  '  Loudness range:', `    LRA:         ${lra} LU`, '    Threshold: -41.8 LUFS', '    LRA low:   -21.8 LUFS', '    LRA high:  -21.8 LUFS', '',
  '  Sample peak:', `    Peak:      ${sample} dBFS`, '',
  '  True peak:', `    Peak:      ${truePeak} dBFS`,
].join('\n');

describe('parseEbur128', () => {
  it('reads the summary', () => {
    expect(parseEbur128(`frame lines…\n${summary('-18.2', '7.1', '-1.6', '-1.3')}\n[out#0/null] video:0KiB`)).toEqual({
      standard: LOUDNESS_STANDARD, integratedLufs: -18.2, rangeLu: 7.1, truePeakDbtp: -1.3, samplePeakDbfs: -1.6,
    });
  });

  it('leaves out what silence cannot have', () => {
    expect(parseEbur128(summary('-70.0', '0.0', '-inf', '-inf'))).toEqual({ standard: LOUDNESS_STANDARD });
    // near-silence: the peaks are real, the loudness is not
    expect(parseEbur128(summary('-70.0', '0.0', '-62.3', '-62.0'))).toEqual({ standard: LOUDNESS_STANDARD, truePeakDbtp: -62, samplePeakDbfs: -62.3 });
  });

  it('uses the last summary and refuses output without one', () => {
    expect(parseEbur128(`${summary('-30.0', '1.0', '-9.0', '-9.0')}\n${summary('-20.0', '2.0', '-3.0', '-2.5')}`).integratedLufs).toBe(-20);
    expect(() => parseEbur128('Invalid data found when processing input')).toThrow(/no loudness summary/);
  });
});

describe.skipIf(!hasFfmpeg)('measureLoudness (ffmpeg)', () => {
  it('measures a generated stereo tone', async () => {
    const dir = await tempDir('overtone-loudness-');
    const file = join(dir, 'tone.m4a'); // generated at runtime, never committed
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '2', '-c:a', 'aac', file]);
    const l = await measureLoudness(file);
    expect(l.integratedLufs).toBeGreaterThan(-25);
    expect(l.integratedLufs).toBeLessThan(-18);
    expect(l.truePeakDbtp).toBeLessThan(-15);
    expect(l.samplePeakDbfs).toBeLessThan(-15);
  });

  it('stops when aborted', async () => {
    const dir = await tempDir('overtone-loudness-');
    const file = join(dir, 'long.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=600', '-c:a', 'aac', file]);
    const ac = new AbortController();
    const measuring = measureLoudness(file, ac.signal);
    ac.abort();
    await expect(measuring).rejects.toThrow();
  });
});
