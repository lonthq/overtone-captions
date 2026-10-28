import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchChrome } from '../src/burn/chrome.js';
import { onInterrupt, stopForSignal } from '../src/util/interrupt.js';
import { writeViaTemp } from '../src/util/temp-file.js';
import { alive } from './helpers.js';
import { tempDir } from './tmp.js';

describe('onInterrupt', () => {
  it('runs the cleanups newest first on a stop signal, then exits with the shell code', () => {
    const order: string[] = [];
    onInterrupt(() => order.push('folder'));
    const forget = onInterrupt(() => order.push('forgotten'));
    onInterrupt(() => { order.push('child'); throw new Error('already gone'); });
    forget();
    const codes: number[] = [];
    stopForSignal('SIGTERM', (code) => codes.push(code));
    expect(order).toEqual(['child', 'folder']);
    expect(codes).toEqual([143]);
    // a cleanup runs once
    stopForSignal('SIGINT', (code) => codes.push(code));
    expect(order).toEqual(['child', 'folder']);
    expect(codes).toEqual([143, 130]);
  });
});

describe.skipIf(process.platform === 'win32')('a stop signal while Chrome starts', () => {
  it('kills Chrome and removes its profile folder', async () => {
    const dir = await tempDir('ot-fakechrome-');
    const fake = join(dir, 'chrome');
    const seen = join(dir, 'seen');
    // a "Chrome" that never opens DevTools: it writes its pid and arguments, then waits
    await writeFile(fake, `#!/bin/sh\necho "$$ $*" > '${seen}'\nexec sleep 30\n`);
    await chmod(fake, 0o755);
    const launching = launchChrome({ CHROME_PATH: fake }).catch((e: unknown) => e);
    while (!existsSync(seen) || !(await readFile(seen, 'utf8')).includes('\n')) await new Promise((r) => setTimeout(r, 20));
    const [pid, ...args] = (await readFile(seen, 'utf8')).trim().split(' ');
    const profileDir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
    expect(existsSync(profileDir)).toBe(true);

    const codes: number[] = [];
    stopForSignal('SIGINT', (code) => codes.push(code));
    expect(codes).toEqual([130]);
    expect(existsSync(profileDir)).toBe(false);
    await launching; // rejects: Chrome exited
    for (let i = 0; i < 50 && alive(Number(pid)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(Number(pid))).toBe(false);
  });
});

describe('a stop signal during a write through a temporary file', () => {
  it('removes the temporary file, so no half-written file is left in the cache or output folder', async () => {
    const dir = await tempDir('ot-tempwrite-');
    let tmpFile = '';
    let release!: () => void;
    let written!: () => void;
    const halfWritten = new Promise<void>((resolve) => { written = resolve; });
    const writing = writeViaTemp(join(dir, 'audio.mp3'), async (tmp) => {
      tmpFile = tmp;
      await writeFile(tmp, 'half');
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      written();
      await waiting;
    });
    await halfWritten; // the temporary file is written, and the write waits to be released
    expect(existsSync(tmpFile)).toBe(true);
    stopForSignal('SIGTERM', () => {});
    expect(existsSync(tmpFile)).toBe(false);
    release();
    await writing.catch(() => undefined); // the rename fails: the file is gone
    expect(existsSync(join(dir, 'audio.mp3'))).toBe(false);
  });
});
