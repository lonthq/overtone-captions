import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../errors.js';
import { onInterrupt } from '../util/interrupt.js';

/** Usual Chrome, Chromium and Edge install paths, most preferred first. */
export function chromePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
}

/** Time for Chrome to start and accept a DevTools connection. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Time for Chrome to quit after SIGTERM before SIGKILL. */
const EXIT_TIMEOUT_MS = 5_000;

/** CHROME_PATH, else the first `chromePaths` entry that exists. */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  isFolder: (path: string) => boolean = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
): string {
  if (env.CHROME_PATH && !exists(env.CHROME_PATH)) throw new UserError(`CHROME_PATH is set to ${env.CHROME_PATH}, which does not exist.`);
  if (env.CHROME_PATH && isFolder(env.CHROME_PATH)) {
    // common on macOS: the .app bundle instead of the binary inside it
    const app = /([^/\\]+)\.app\/?$/.exec(env.CHROME_PATH);
    const hint = app ? ` such as ${join(env.CHROME_PATH, 'Contents/MacOS', app[1]!)}` : '';
    throw new UserError(`CHROME_PATH is set to ${env.CHROME_PATH}, which is a folder; set it to the Chrome binary${hint}.`);
  }
  const found = [env.CHROME_PATH, ...chromePaths(env)].find((path) => path && exists(path));
  if (!found) throw new UserError('Google Chrome or Chromium not found; install one or set CHROME_PATH to its binary.');
  return found;
}

/** One page in a headless Chrome. */
export interface ChromeTab {
  /** The Chrome browser process id. */
  readonly pid: number | undefined;
  /** The temporary user-data folder; removed by `close`. */
  readonly profileDir: string;
  /** Sends a DevTools command to the page. Rejects on a Chrome error, exit or closed connection. */
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  /** Stops Chrome and removes the profile folder. Idempotent. */
  close(): Promise<void>;
}

interface Waiter { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }

/** Headless, any free DevTools port, a temporary profile, and nothing that varies the picture. */
function chromeArgs(profileDir: string): string[] {
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
  ];
  if (process.getuid?.() === 0) args.push('--no-sandbox'); // Chrome refuses to run as root otherwise (containers, CI)
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage'); // a small /dev/shm (Docker) crashes tabs
  return args;
}

/** The DevTools WebSocket URL from Chrome's stderr; rejects with the last stderr lines if Chrome exits first. */
function devToolsUrl(chrome: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let found = false;
    chrome.stderr!.on('data', (chunk) => {
      if (found) return; // keep draining stderr, but stop collecting
      output = (output + chunk).slice(-4000);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        found = true;
        resolve(match[1]!);
      }
    });
    chrome.once('error', (err) => reject(new Error(`could not run Chrome: ${err.message}`)));
    chrome.once('exit', (code, signal) => {
      const tail = output.trim().split('\n').slice(-5).join(' | ');
      reject(new Error(`Chrome exited (${code ?? signal}) before DevTools was ready${tail ? `: ${tail}` : ''}`));
    });
  });
}

/**
 * DevTools over one WebSocket, answers matched to requests by id. `fail` rejects every pending and later request
 * with the same error.
 */
function devToolsClient() {
  let socket: WebSocket | undefined;
  let failure: Error | undefined;
  let id = 0;
  const pending = new Map<number, Waiter>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  return {
    fail,
    async connect(url: string): Promise<void> {
      const ws = new WebSocket(url);
      socket = ws;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('could not connect to Chrome'));
      });
      ws.onerror = () => fail(new Error('connection to Chrome failed'));
      ws.onclose = () => fail(new Error('connection to Chrome closed'));
      ws.onmessage = ({ data }) => {
        const message = JSON.parse(String(data));
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
      };
    },
    send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
      return new Promise<any>((resolve, reject) => {
        if (failure) return reject(failure);
        pending.set(++id, { resolve, reject, method });
        socket!.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close(): void {
      try {
        socket?.close();
      } catch {
        // already closed
      }
    },
  };
}

/** SIGTERM, then SIGKILL after EXIT_TIMEOUT_MS; releases stderr so Node can exit. */
async function stopChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    const killer = setTimeout(() => chrome.kill('SIGKILL'), EXIT_TIMEOUT_MS);
    await exited;
    clearTimeout(killer);
  }
  // Chrome's crashpad handler can outlive it and hold the stderr pipe open, which keeps Node running
  chrome.stderr?.destroy();
  chrome.unref();
}

/** Starts headless Chrome with a temporary profile and attaches to a blank page. */
export async function launchChrome(env: NodeJS.ProcessEnv = process.env): Promise<ChromeTab> {
  const binary = findChrome(env);
  const profileDir = await mkdtemp(join(tmpdir(), 'overtone-chrome-'));
  const chrome = spawn(binary, [...chromeArgs(profileDir), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const forget = onInterrupt(() => {
    chrome.kill('SIGKILL');
    rmSync(profileDir, { recursive: true, force: true });
  });
  const devTools = devToolsClient();
  // if Chrome dies or fails to start, reject waiting requests instead of hanging
  chrome.on('error', (err) => devTools.fail(new Error(`could not run Chrome: ${err.message}`)));
  chrome.on('exit', (code, signal) => devTools.fail(new Error(`Chrome exited (${code ?? signal})`)));

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      devTools.fail(new Error('Chrome was closed'));
      devTools.close();
      await stopChrome(chrome);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
      forget();
    })();
    return closing;
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const startup = (async (): Promise<ChromeTab> => {
      await devTools.connect(await devToolsUrl(chrome));
      const { targetId } = await devTools.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await devTools.send('Target.attachToTarget', { targetId, flatten: true });
      return { pid: chrome.pid, profileDir, send: (method, params) => devTools.send(method, params, sessionId), close };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Chrome did not start within ${LAUNCH_TIMEOUT_MS / 1000} s`)), LAUNCH_TIMEOUT_MS);
    });
    startup.catch(() => {}); // a failure after the timeout is handled by close()
    return await Promise.race([startup, timeout]);
  } catch (err) {
    await close();
    throw new UserError(`Could not start Chrome (${binary}): ${(err as Error).message}. Set CHROME_PATH to a working Chrome or Chromium binary.`);
  } finally {
    clearTimeout(timer);
  }
}
