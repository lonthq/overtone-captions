// Screenshots the style gallery with headless Chrome over the DevTools protocol, and reports lines that wrap:
//   - packages/videojs/styles/<name>/preview.png   16:9, 1:1 and 9:16 frames per pack
//   - docs/images/style-packs.png                  every pack (only when all are rendered)
// Needs a build and Chrome or Chromium (CHROME_PATH to override).
//   npm run styles:previews                 every pack and the overview image
//   npm run styles:previews -- my-pack      only this pack's preview.png
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../demo/serve.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const OVERVIEW_IMAGE = join(REPO, 'docs/images/style-packs.png');
const LIMITS = { preview: 100 * 1024, overview: 200 * 1024 };

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('Chrome not found: set CHROME_PATH to a Chrome or Chromium binary');
  return found;
}

/** Starts headless Chrome and resolves to its DevTools WebSocket URL. */
function launchChrome(profileDir) {
  const chrome = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ]);
  const url = new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) resolve(match[1]);
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}) before DevTools was ready`)));
  });
  return { chrome, url };
}

/** Minimal DevTools protocol client: send(method, params, sessionId) → result. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not connect to Chrome'));
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, close: () => socket.close() };
}

async function main() {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profileDir = mkdtempSync(join(tmpdir(), 'overtone-chrome-'));
  const { chrome, url } = launchChrome(profileDir);
  let client;
  try {
    client = await connect(await url);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => client.send(method, params, sessionId);
    const evaluate = async (expression) =>
      (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await page('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    const open = async (path) => {
      await page('Page.navigate', { url: `${origin}${path}` });
      for (let i = 0; i < 200; i++) {
        const state = await evaluate('document.body?.dataset.ready ? "ready" : document.body?.dataset.error ?? ""').catch(() => '');
        if (state === 'ready') return;
        if (state) throw new Error(`${path}: ${state}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`${path} did not finish rendering`);
    };
    const shoot = async (selector, file, limit) => {
      const box = await evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
      );
      const pad = 8;
      const clip = { x: box.x - pad, y: box.y - pad, width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad), scale: 1 };
      const { data } = await page('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      const size = statSync(file).size;
      const note = size > limit ? `  (over the ${Math.round(limit / 1024)} KB limit)` : '';
      console.log(`${file.slice(REPO.length)}  ${clip.width}×${clip.height}  ${Math.round(size / 1024)} KB${note}`);
      if (size > limit) process.exitCode = 1;
    };

    await open('/examples/styles/?view=overview');
    const names = await evaluate('[...document.querySelectorAll(".overview-row[data-pack]")].map((row) => row.dataset.pack)');
    for (const name of names) {
      if (only.length && !only.includes(name)) continue;
      await shoot(`.overview-row[data-pack="${name}"] .frames`, join(REPO, 'packages/videojs/styles', name, 'preview.png'), LIMITS.preview);
    }
    if (!only.length) await shoot('#gallery', OVERVIEW_IMAGE, LIMITS.overview);

    // Line-fit check.
    await open(`/examples/styles/${only.length ? `?pack=${only.join(',')}` : ''}`);
    const fit = await evaluate('[...document.querySelectorAll(".fit")].map((p) => (p.classList.contains("bad") ? "WRAPS " : "") + p.dataset.pack + ": " + p.textContent)');
    for (const line of fit) console.log(line);
    if (fit.some((line) => line.startsWith('WRAPS'))) process.exitCode = 1;
  } finally {
    client?.close();
    chrome.kill();
    server.close();
    if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((resolve) => chrome.once('exit', resolve));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
