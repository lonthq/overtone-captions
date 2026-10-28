import { describe, expect, it } from 'vitest';
import { resolveConfig, type CliFlags, type FileConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { selectProviders } from '../src/pipeline/preflight.js';
import { secondOpinionSelection } from '../src/providers/registry.js';

const dirs = { cwd: '/w', configDir: '/w' };
const env = { ELEVENLABS_API_KEY: 'fake-key' };

/** The second hearing a run would use, with an ElevenLabs key set (the automatic choice when there is one). */
async function second(flags: CliFlags, file: FileConfig): Promise<string | undefined> {
  const cfg = await resolveConfig(flags, file, dirs);
  return secondOpinionSelection(cfg.timingSecondOpinion, cfg.timing, env)?.id;
}

describe('local mode and the second opinion', () => {
  it('"local": true never picks an automatic cloud second opinion, also with a timing provider named', async () => {
    expect(await second({}, { local: true, timing: 'same' })).toBeUndefined();
    expect(await second({}, { local: true, timing: 'whisper-cpp' })).toBeUndefined();
    expect(await second({ timing: 'whisper-cpp' }, { local: true })).toBeUndefined();
    expect(await second({ timing: 'azure-speech' }, { local: true })).toBeUndefined();
    expect(await second({ local: true, timing: 'azure-speech' }, {})).toBeUndefined();
    // without local mode the key still picks it
    expect(await second({}, { timing: 'azure-speech' })).toBe('elevenlabs:scribe_v2');
  });

  it('still honors a named timing provider and a named second opinion', async () => {
    expect((await resolveConfig({}, { local: true, timing: 'azure-speech' }, dirs)).timing.id).toBe('azure-speech');
    expect(await second({}, { local: true, timing: 'azure-speech', timingSecondOpinion: 'elevenlabs' })).toBe('elevenlabs:scribe_v2');
    expect(await second({ timingSecondOpinion: 'elevenlabs' }, { local: true, timing: 'same' })).toBe('elevenlabs:scribe_v2');
  });
});

describe('the automatic second hearing when the text comes from ElevenLabs Scribe', () => {
  const select = async (flags: CliFlags) => {
    const cfg = await resolveConfig(flags, {}, dirs);
    return (await selectProviders(cfg, undefined, { log: memoryLogger(), cwd: '/w' }, env)).secondSel?.id;
  };

  it('is skipped: Scribe\'s text answer already is its hearing of the file', async () => {
    expect(await select({ text: 'elevenlabs', timing: 'azure-speech' })).toBeUndefined();
  });

  it('is still ElevenLabs Scribe for another text provider, and a named one is still used', async () => {
    expect(await select({ text: 'openai', timing: 'azure-speech' })).toBe('elevenlabs:scribe_v2');
    expect(await select({ text: 'elevenlabs', timing: 'azure-speech', timingSecondOpinion: 'elevenlabs' })).toBe('elevenlabs:scribe_v2');
  });
});

describe('--local and a second opinion from the config file', () => {
  const resolveWithNotes = async (flags: CliFlags, file: FileConfig) => {
    const notes: string[] = [];
    const cfg = await resolveConfig(flags, file, dirs, (m) => notes.push(m));
    return { second: secondOpinionSelection(cfg.timingSecondOpinion, cfg.timing, env)?.id, notes };
  };

  it('turns off a cloud second opinion that only the config file names, with a note', async () => {
    const r = await resolveWithNotes({ local: true }, { timingSecondOpinion: 'elevenlabs' });
    expect(r.second).toBeUndefined();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('--local: ignoring "timingSecondOpinion": "elevenlabs" from the config file');
    expect(r.notes[0]).toContain('--timing-second-opinion elevenlabs');
  });

  it('still uses a second opinion given on the command line, without a note', async () => {
    const r = await resolveWithNotes({ local: true, timingSecondOpinion: 'elevenlabs' }, { timingSecondOpinion: 'azure-speech' });
    expect(r.second).toBe('elevenlabs:scribe_v2');
    expect(r.notes).toEqual([]);
  });

  it('keeps a local second opinion from the config file, and leaves runs without --local alone', async () => {
    const local = await resolveConfig({ local: true }, { timingSecondOpinion: 'whisper-cpp' }, dirs);
    expect(local.timingSecondOpinion).toMatchObject({ provider: 'whisper-cpp' });
    const r = await resolveWithNotes({}, { timingSecondOpinion: 'elevenlabs' });
    expect(r.second).toBe('elevenlabs:scribe_v2');
    expect(r.notes).toEqual([]);
  });

  it('says nothing when the config file already turns the second opinion off', async () => {
    const notes: string[] = [];
    await resolveConfig({ local: true }, { timingSecondOpinion: 'none' }, dirs, (m) => notes.push(m));
    expect(notes).toEqual([]);
  });
});
