import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, WAV_ARGS } from '../src/media/extract.js';
import { OpenAITimingProvider, type OpenAILike } from '../src/providers/openai.js';
import { WhisperCppProvider } from '../src/providers/whisper-cpp.js';
import { stopForSignal } from '../src/util/interrupt.js';
import { makeTempDir } from '../src/util/temp-file.js';
import { alive } from './helpers.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

afterEach(() => vi.unstubAllEnvs());

const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 250 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('makeTempDir', () => {
  it('is removed by a stop signal, and remove() forgets that cleanup', async () => {
    vi.stubEnv('TMPDIR', await tempDir('ot-tmproot-'));
    const dir = await makeTempDir('overtone-test-');
    await writeFile(join(dir.path, 'piece-0.wav'), 'x');
    stopForSignal('SIGTERM', () => {});
    expect(existsSync(dir.path)).toBe(false);

    const kept = await makeTempDir('overtone-test-');
    await kept.remove();
    expect(existsSync(kept.path)).toBe(false);
    // the cleanup is gone: a later stop leaves a folder at the same path alone
    await mkdir(kept.path);
    stopForSignal('SIGTERM', () => {});
    expect(existsSync(kept.path)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('a stop signal while whisper-cli runs', () => {
  it('kills whisper-cli and removes its output folder', async () => {
    const dir = await tempDir('ot-fakewhisper-');
    vi.stubEnv('TMPDIR', dir);
    const fake = join(dir, 'whisper-cli');
    const seen = join(dir, 'seen');
    // a "whisper-cli" that writes its pid and arguments, then keeps running
    await writeFile(fake, `#!/bin/sh\necho "$$ $*" > '${seen}'\nexec sleep 30\n`);
    await chmod(fake, 0o755);
    const p = new WhisperCppProvider('whisper-cpp:base', { bin: fake, modelPath: join(dir, 'ggml-base.bin'), modelName: 'base', tdrz: false, extraArgs: [] });
    const running = p.transcribe({ path: join(dir, 'audio.wav'), index: 0, start: 0, end: 1 }, {}).catch((e: unknown) => e);
    await until(async () => existsSync(seen) && (await readFile(seen, 'utf8')).includes('\n'));
    const [pid, ...args] = (await readFile(seen, 'utf8')).trim().split(' ');
    const outDir = dirname(args[args.indexOf('-of') + 1]!);
    expect(existsSync(outDir)).toBe(true);

    const codes: number[] = [];
    stopForSignal('SIGINT', (code) => codes.push(code));
    expect(codes).toEqual([130]);
    expect(existsSync(outDir)).toBe(false);
    expect(String(await running)).toMatch(/whisper-cli was stopped by SIGKILL/);
    await until(() => !alive(Number(pid)));
    expect(alive(Number(pid))).toBe(false);
  });

  it('forgets the child once it has exited', async () => {
    const dir = await tempDir('ot-fakewhisper-');
    vi.stubEnv('TMPDIR', dir);
    const fake = join(dir, 'whisper-cli');
    await writeFile(fake, '#!/bin/sh\necho "no model" >&2\nexit 1\n');
    await chmod(fake, 0o755);
    const p = new WhisperCppProvider('whisper-cpp:base', { bin: fake, modelPath: join(dir, 'ggml-base.bin'), modelName: 'base', tdrz: false, extraArgs: [] });
    await expect(p.transcribe({ path: join(dir, 'audio.wav'), index: 0, start: 0, end: 1 }, {})).rejects.toThrow(/exited with code 1/);
    // no folder is left behind, and a stop now has nothing of this run to clean up
    expect(readdirSync(dir).filter((n) => n.startsWith('overtone-whisper-'))).toEqual([]);
    expect(() => stopForSignal('SIGTERM', () => {})).not.toThrow();
  });
});

describe.skipIf(!hasFfmpeg)('a stop signal while OpenAI timing uploads pieces', () => {
  it('removes the folder with the WAV pieces of the audio', async () => {
    const root = await tempDir('ot-openai-pieces-');
    vi.stubEnv('TMPDIR', root);
    const wav = join(root, 'audio.wav');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', ...WAV_ARGS, wav]);
    let uploading!: () => void;
    const started = new Promise<void>((resolve) => { uploading = resolve; });
    const client: OpenAILike = {
      // the upload never finishes: the command is stopped while it waits
      audio: { transcriptions: { create: () => { uploading(); return new Promise(() => {}); } } },
      chat: { completions: { create: async () => { throw new Error('no chat'); } } },
    };
    const p = new OpenAITimingProvider('openai:whisper-1', client, { words: 'whisper-1', maxSeconds: 4.3 });
    void p.align({ path: wav, duration: 8 }, {});
    await started;
    const pieces = readdirSync(root).filter((n) => n.startsWith('overtone-openai-timing-')).map((n) => join(root, n));
    expect(pieces).toHaveLength(1);
    expect(readdirSync(pieces[0]!)).toContain('piece-0.wav');

    stopForSignal('SIGTERM', () => {});
    expect(existsSync(pieces[0]!)).toBe(false);
  });
});
