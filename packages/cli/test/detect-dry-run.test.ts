import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { formatPlan, planRun } from '../src/pipeline/plan.js';
import { tempDir } from './tmp.js';

const GOOGLE = { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json', GOOGLE_CLOUD_PROJECT: 'p' };
const KEYS = { OPENAI_API_KEY: 'sk-fake-0123456789', AZURE_SPEECH_KEY: 'fake-key-0123456789', AZURE_SPEECH_REGION: 'westeurope' };

async function plan(flags: CliFlags, env: NodeJS.ProcessEnv) {
  const dir = await tempDir('overtone-detectplan-');
  const media = join(dir, 'clip.m4a');
  await writeFile(media, 'not really media'); // created by the test, never committed
  const cfg = await resolveConfig(flags, {}, { cwd: dir, configDir: dir });
  const deps = { log: memoryLogger(), cwd: dir, checkBinaries: async () => [], probeDuration: async () => 600, probeVideo: async () => undefined };
  return formatPlan(await planRun(media, cfg, deps, env));
}

describe('dry run with a language detector', () => {
  it('names the detector, where the samples go and the cost note', async () => {
    const lines = await plan({}, { ...KEYS, ...GOOGLE });
    expect(lines).toContain('language: detected from audio samples by google-chirp:chirp_3 (auto: GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT are set)');
    expect(lines.find((l) => l.startsWith('audio goes to:'))).toContain('Google Cloud Speech-to-Text (the region in GOOGLE_CHIRP_REGION, default eu) [cloud]');
    expect(lines.find((l) => l.startsWith('estimated cost:'))).toMatch(/; plus language detection: up to 90 s of audio with google-chirp:chirp_3 \(not in this estimate\)$/);
  });

  it('lists the variables an explicit --detect needs', async () => {
    const lines = await plan({ detect: 'google-chirp' }, KEYS);
    expect(lines.find((l) => l.startsWith('missing environment variables:'))).toContain('GOOGLE_APPLICATION_CREDENTIALS (google-chirp)');
    expect(lines).toContain('runnable: no');
  });

  it('says nothing about detection with --language', async () => {
    const lines = await plan({ language: 'nl' }, { ...KEYS, ...GOOGLE });
    expect(lines).toContain('language: nl (given)');
    expect(lines.join('\n')).not.toContain('Google Cloud');
  });
});
