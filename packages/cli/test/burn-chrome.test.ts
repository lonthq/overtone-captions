import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chromePaths, findChrome, launchChrome } from '../src/burn/chrome.js';
import { UserError } from '../src/errors.js';
import { tempDir } from './tmp.js';

const hasChrome = (() => {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
})();

describe('chromePaths', () => {
  it('adds per-user locations from the home folder and LOCALAPPDATA, and Edge last', () => {
    const paths = chromePaths({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, '/home/me');
    expect(paths).toContain('/home/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(paths).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    expect(paths).toContain('/snap/bin/chromium');
    expect(paths.at(-1)).toContain('msedge.exe');
  });

  it('leaves out the LOCALAPPDATA location when the variable is not set', () => {
    expect(chromePaths({}, '/home/me').some((p) => p.includes('undefined'))).toBe(false);
  });
});

describe('findChrome', () => {
  it('prefers CHROME_PATH when it exists', () => {
    expect(findChrome({ CHROME_PATH: '/opt/chrome' }, (p) => p === '/opt/chrome' || p === chromePaths({})[0])).toBe('/opt/chrome');
  });

  it('falls back to the standard paths', () => {
    expect(findChrome({}, (p) => p === chromePaths({})[1])).toBe(chromePaths({})[1]);
  });

  it('is a UserError when CHROME_PATH is set but does not exist', () => {
    const find = () => findChrome({ CHROME_PATH: '/opt/nope' }, (p) => p !== '/opt/nope');
    expect(find).toThrow(UserError);
    expect(find).toThrow('CHROME_PATH is set to /opt/nope, which does not exist.');
  });

  it('is a UserError that names the binary when CHROME_PATH is a folder (the macOS app bundle)', () => {
    const app = '/Applications/Google Chrome.app';
    const find = () => findChrome({ CHROME_PATH: app }, () => true, (p) => p === app);
    expect(find).toThrow(UserError);
    expect(find).toThrow('CHROME_PATH is set to /Applications/Google Chrome.app, which is a folder; set it to the Chrome binary such as /Applications/Google Chrome.app/Contents/MacOS/Google Chrome.');
  });

  it('is a UserError when nothing is found', () => {
    expect(() => findChrome({}, () => false)).toThrow(UserError);
    expect(() => findChrome({}, () => false)).toThrow('Google Chrome or Chromium not found; install one or set CHROME_PATH to its binary.');
  });
});

describe.skipIf(process.platform === 'win32')('launchChrome with a Chrome that dies', () => {
  it('puts the last stderr lines in the error', async () => {
    const dir = await tempDir('ot-fakechrome-');
    const fake = join(dir, 'chrome');
    await writeFile(fake, '#!/bin/sh\necho "first line" >&2\necho "No usable sandbox!" >&2\nexit 1\n');
    await chmod(fake, 0o755);
    await expect(launchChrome({ CHROME_PATH: fake })).rejects.toThrow('Chrome exited (1) before DevTools was ready: first line | No usable sandbox!');
  });

  it('is a UserError that says to check CHROME_PATH, so no stack trace is printed', async () => {
    const dir = await tempDir('ot-fakechrome-');
    const fake = join(dir, 'chrome');
    await writeFile(fake, '#!/bin/sh\nexit 1\n');
    await chmod(fake, 0o755);
    const err = await launchChrome({ CHROME_PATH: fake }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe(`Could not start Chrome (${fake}): Chrome exited (1) before DevTools was ready. Set CHROME_PATH to a working Chrome or Chromium binary.`);
  });

  it('is a UserError, not a hang, when the binary cannot be started at all (not executable)', async () => {
    const dir = await tempDir('ot-fakechrome-');
    const fake = join(dir, 'chrome');
    await writeFile(fake, '#!/bin/sh\nexit 0\n');
    await chmod(fake, 0o644);
    const err = await launchChrome({ CHROME_PATH: fake }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/^Could not start Chrome \(.*\): could not run Chrome: .*EACCES.*Set CHROME_PATH/);
  }, 10_000);
});

describe.skipIf(!hasChrome)('launchChrome', () => {
  it('evaluates in a page and closes cleanly', async () => {
    const tab = await launchChrome();
    try {
      const { result } = await tab.send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true });
      expect(result.value).toBe(42);
    } finally {
      await tab.close();
    }
  });

  it('removes the profile folder on close, and closing twice is fine', async () => {
    const tab = await launchChrome();
    expect(existsSync(tab.profileDir)).toBe(true);
    await tab.close();
    expect(existsSync(tab.profileDir)).toBe(false);
    await expect(tab.close()).resolves.toBeUndefined();
  });

  it('rejects requests sent after close', async () => {
    const tab = await launchChrome();
    await tab.close();
    await expect(tab.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a waiting request when Chrome is killed mid-run', async () => {
    const tab = await launchChrome();
    try {
      const waiting = tab.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true });
      setTimeout(() => process.kill(tab.pid!, 'SIGKILL'), 200);
      await expect(waiting).rejects.toThrow(/Chrome|connection/);
      await expect(tab.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow();
    } finally {
      await tab.close();
    }
    expect(existsSync(tab.profileDir)).toBe(false);
  });
});

describe.skipIf(!hasChrome || process.platform === 'win32')('a process left holding Chrome\'s stderr', () => {
  it('does not keep Node running after close()', async () => {
    const dir = await tempDir('ot-chrome-exit-');
    // Chrome's crashpad handler can outlive it and keep its stderr pipe open; a background `sleep` does the same.
    const wrapper = join(dir, 'chrome.sh');
    await writeFile(wrapper, '#!/bin/sh\nsleep 8 &\nexec "$REAL_CHROME" "$@"\n');
    await chmod(wrapper, 0o755);
    // A small program on the real launchChrome, bundled so plain node can run it.
    const { build } = await import('esbuild');
    await build({ entryPoints: [fileURLToPath(new URL('../src/burn/chrome.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'chrome.mjs'), logLevel: 'silent' });
    await writeFile(join(dir, 'run.mjs'), [
      "import { launchChrome } from './chrome.mjs';",
      'const tab = await launchChrome();',
      "await tab.send('Runtime.evaluate', { expression: '1' });",
      'await new Promise((resolve) => setTimeout(resolve, 1000));',
      'await tab.close();',
      "console.log('closed');",
    ].join('\n'));
    const child = spawn(process.execPath, [join(dir, 'run.mjs')], { env: { ...process.env, CHROME_PATH: wrapper, REAL_CHROME: findChrome() }, stdio: ['ignore', 'pipe', 'inherit'] });
    let closedAt = 0;
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('closed')) closedAt = Date.now();
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(closedAt).toBeGreaterThan(0);
    expect(Date.now() - closedAt).toBeLessThan(3000);
  }, 30_000);
});
