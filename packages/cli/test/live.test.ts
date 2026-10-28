import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertValid, flattenWords } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';
import { runTranscribe } from '../src/commands/transcribe.js';
import { consoleLogger } from '../src/log.js';
import { normalizeText } from '../src/text/normalize.js';
import { similarity } from '../src/text/similarity.js';

/**
 * Real API run, only with `npm run test:live` (OVERTONE_LIVE=1) and keys in the repo-root .env. Providers:
 * OVERTONE_LIVE_TEXT / _TIMING / _LLM (e.g. `azure-openai:<deployment>`), else the CLI defaults. It runs in a fresh
 * temp folder, so no stale cache or repo config can change the result.
 */
const LIVE = process.env.OVERTONE_LIVE === '1';
const ROOT = resolve(import.meta.dirname, '../../..');
const SAMPLE = join(ROOT, 'examples/media/sample-16x9.mp4');
const GLOSSARY = join(ROOT, 'examples/fixtures/sample-glossary.txt');
const SCRIPT =
  "Every year, one in five drivers has some kind of car damage. With DriveCover from Lumora, you're insured from day one, for just $12 a month. And the best part? You can claim directly in the app. So remember: DriveCover. Drive worry-free.";
const FILES = ['sample-16x9.overtone.json', 'sample-16x9.horizontal.vtt', 'sample-16x9.vertical.vtt', 'sample-16x9.horizontal.srt', 'sample-16x9.vertical.srt', 'sample-16x9.txt'];

const choice = (name: string): string | undefined => process.env[name]?.trim() || undefined;

describe.skipIf(!LIVE)('live APIs', () => {
  it('transcribes the generated sample video', async () => {
    if (!existsSync(SAMPLE)) throw new Error('examples/media/sample-16x9.mp4 is missing: run bash examples/media/make-sample.sh first (macOS)');
    loadEnv(ROOT); // the repo-root .env; variables already in the environment win
    const dir = await mkdtemp(join(tmpdir(), 'overtone-live-'));
    const out = join(dir, 'out');
    let passed = false;
    try {
      const code = await runTranscribe(
        SAMPLE,
        {
          out,
          export: 'json,vtt,srt,txt',
          profiles: 'horizontal,vertical',
          context: 'Promotional video for DriveCover, a car insurance product by Lumora Insurance. Two speakers: Maya (host) and Tom.',
          glossary: GLOSSARY,
          language: 'en',
          cache: false,
          text: choice('OVERTONE_LIVE_TEXT'),
          timing: choice('OVERTONE_LIVE_TIMING'),
          llm: choice('OVERTONE_LIVE_LLM'),
        },
        consoleLogger,
        { cwd: dir },
      );
      consoleLogger.info(`live output: ${out}`);
      expect(code).toBe(0);
      for (const f of FILES) expect(existsSync(join(out, f)), f).toBe(true);
      const doc = assertValid(JSON.parse(await readFile(join(out, 'sample-16x9.overtone.json'), 'utf8')));
      expect(doc.language).toBe('en');
      expect(doc.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
      for (const p of doc.profiles) expect(p.cues.length, `${p.id} cues`).toBeGreaterThan(0);
      const text = flattenWords(doc).map((w) => w.text).join(' ');
      expect(similarity(normalizeText(text, 'en'), normalizeText(SCRIPT, 'en'))).toBeGreaterThan(0.9);
      expect(doc.speakers.length).toBe(2);
      expect(text).toContain('DriveCover');
      expect(text).toContain('Lumora');
      passed = true;
    } finally {
      if (passed) await rm(dir, { recursive: true, force: true });
      else consoleLogger.info(`live test failed: kept ${dir} for inspection`);
    }
  }, 600_000);
});
