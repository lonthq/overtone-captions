import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preflight, selectProviders } from '../src/pipeline/preflight.js';
import type { PipelineConfig } from '../src/pipeline/types.js';
import { detectorSelection } from '../src/providers/registry.js';
import { tempDir } from './tmp.js';

const GOOGLE = { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json', GOOGLE_CLOUD_PROJECT: 'p' };

describe('detect setting', () => {
  it('defaults to auto, reads none/false/a provider, and is off in local mode', async () => {
    const dir = await tempDir('overtone-detect-');
    const dirs = { cwd: dir, configDir: dir };
    expect((await resolveConfig({}, {}, dirs)).detect).toBe('auto');
    expect((await resolveConfig({}, { detect: 'none' }, dirs)).detect).toBe(false);
    expect((await resolveConfig({}, { detect: false }, dirs)).detect).toBe(false);
    expect((await resolveConfig({ detect: 'google-chirp' }, {}, dirs)).detect).toMatchObject({ provider: 'google-chirp' });
    expect((await resolveConfig({ local: true }, {}, dirs)).detect).toBe(false);
  });

  it('auto picks google-chirp only when both of its variables are set', () => {
    expect(detectorSelection('auto', GOOGLE)?.id).toBe('google-chirp:chirp_3');
    expect(detectorSelection('auto', { GOOGLE_CLOUD_PROJECT: 'p' })).toBeUndefined();
    expect(detectorSelection(false, GOOGLE)).toBeUndefined();
    expect(() => detectorSelection({ provider: 'azure-speech', id: 'azure-speech' }, GOOGLE)).toThrow(/cannot detect the language/);
  });

  it('selects no detector when the language or the text is given', async () => {
    const dir = await tempDir('overtone-detect-');
    const deps = { log: memoryLogger(), cwd: dir };
    const plain = await resolveConfig({}, {}, { cwd: dir, configDir: dir });
    expect((await selectProviders(plain, undefined, deps, GOOGLE)).detectSel?.id).toBe('google-chirp:chirp_3');
    const given = await resolveConfig({ language: 'nl' }, {}, { cwd: dir, configDir: dir });
    expect((await selectProviders(given, undefined, deps, GOOGLE)).detectSel).toBeUndefined();
    const mixed = await resolveConfig({ language: 'en,es' }, {}, { cwd: dir, configDir: dir });
    expect((await selectProviders(mixed, undefined, deps, GOOGLE)).detectSel).toBeUndefined();
  });

  it('an explicit detector without its variables stops the run in preflight; auto without them asks for none', async () => {
    const dir = await tempDir('overtone-detect-');
    const media = join(dir, 'talk.wav');
    await writeFile(media, '');
    const deps = { log: memoryLogger(), cwd: dir, checkBinaries: async () => [] };
    const missing = async (cfg: PipelineConfig) => (await preflight(media, cfg, deps, {}).catch((e: unknown) => e as Error)) as Error;
    const explicit = await resolveConfig({ detect: 'google-chirp' }, {}, { cwd: dir, configDir: dir });
    expect((await missing(explicit as PipelineConfig)).message).toMatch(/Missing environment variables[\s\S]*GOOGLE_CLOUD_PROJECT/);
    const auto = await resolveConfig({}, {}, { cwd: dir, configDir: dir });
    expect((await missing(auto as PipelineConfig)).message).not.toMatch(/GOOGLE_/);
    const withLanguage = await resolveConfig({ detect: 'google-chirp', language: 'nl' }, {}, { cwd: dir, configDir: dir });
    expect((await missing(withLanguage as PipelineConfig)).message).not.toMatch(/GOOGLE_/);
  });

  it('an unknown detector is a user error', () => {
    expect(() => detectorSelection({ provider: 'nope', id: 'nope' }, GOOGLE)).toThrow(/Unknown provider "nope"/);
  });
});
