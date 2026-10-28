// Records the landing page's hero clip (Tears of Steel in the player) as an animated WebP, a still and an MP4.
//   node site/scripts/build.mjs --record      in the Pages build: into site/dist/media, with MP4
//   node site/scripts/record-clip.mjs         after a build: updates site/assets/hero.webp and hero-still.webp
//                                              (no MP4: no video files in the repository)
//   node site/scripts/record-clip.mjs --out DIR [--mp4]
//
// Serves site/dist with record-stage.html at _record/, plays it in headless Chrome and captures it with
// Page.startScreencast in real time, so transitions look as a viewer sees them. Each frame is placed at the clip
// time the stage sampled, so network stalls drop out; ffmpeg then makes a constant frame rate and encodes.
// Needs Chrome or Chromium, ffmpeg (or img2webp/cwebp without libwebp) and internet. KEEP_CLIP_WORK=1 keeps the
// temporary frames.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, normalizeBase, startPreview } from './preview.mjs';

const SITE = fileURLToPath(new URL('../', import.meta.url));
const VIEWPORT = { width: 1120, height: 565 };
const OUTPUT_WIDTH = 1008; // close to the landing page's widest hero slot (1064 px)
const WEBP_QUALITY = '35'; // film footage needs a low value (about 1.8 MB)
const FPS = 12;
const LENGTH = 12; // seconds, must match LENGTH in record-stage.html
const STILL_AT = 4.6; // clip time of the still: "You broke my heart." with the key-word marker

const has = (command, args = ['-version']) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => (candidate.includes('/') ? existsSync(candidate) : has(candidate, ['--version'])));
  if (!found) throw new Error('no Chrome or Chromium found (set CHROME_PATH)');
  return found;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.split('\n').slice(-6).join('\n')}`);
}

/** Starts headless Chrome; resolves to { chrome, wsUrl } of the browser's DevTools endpoint. */
function launchChrome(profileDir) {
  const chrome = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((done, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error(`Chrome did not start: ${log.slice(-500)}`)), 20000);
    chrome.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        done({ chrome, wsUrl: match[1] });
      }
    });
    chrome.once('exit', (code) => fail(new Error(`Chrome exited (${code}): ${log.slice(-500)}`)));
  });
}

/** Minimal DevTools protocol client on one WebSocket (flattened sessions). */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not connect to Chrome'));
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${message.error.message} (${message.error.code})`));
      else done(message.result);
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    }
  };
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      return new Promise((done, fail) => pending.set(id, { done, fail }));
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close: () => socket.close(),
  };
}

async function evaluate(cdp, session, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

/** Records the stage; returns the frames ({ data: Buffer, time }) that fall inside the clip. */
async function captureFrames(stageUrl, workDir) {
  const { chrome, wsUrl } = await launchChrome(join(workDir, 'profile'));
  const cdp = await connect(wsUrl);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => console.warn(`  page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' || type === 'warning') console.warn(`  page ${type}: ${args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, session);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, session);
    const loaded = new Promise((done) => cdp.on('Page.loadEventFired', done));
    await cdp.send('Page.navigate', { url: stageUrl }, session);
    await loaded;
    const buffered = await evaluate(cdp, session, 'window.prepare()');
    if (!buffered) console.warn('  ! the video was not fully buffered after 30 s; the clip may stutter');

    const frames = [];
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId: frameId }, from) => {
      if (from !== session) return;
      frames.push({ data: Buffer.from(data, 'base64'), time: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId: frameId }, session).catch(() => {});
    });
    // Full size: ffmpeg's lanczos scaling keeps text crisper than Chrome's.
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }, session);
    const { samples } = await evaluate(cdp, session, 'window.run()');
    await cdp.send('Page.stopScreencast', {}, session);
    const wall = samples.at(-1)[0] - samples.find(([, t]) => t > 0)[0];
    if (wall > LENGTH + 0.5) console.warn(`  ! playback took ${wall.toFixed(1)} s for ${LENGTH} s of video (stalls are dropped)`);
    // Clip time from the page's (wall clock, clip time) samples. Frames during a stall are dropped; frames
    // before 0 collapse onto 0.
    const clipTime = (time) => {
      let i = samples.findIndex(([at]) => at >= time);
      if (i < 0) return samples.at(-1)[1];
      if (i === 0) return samples[0][1];
      const [a, ta] = samples[i - 1];
      const [b, tb] = samples[i];
      return ta + ((tb - ta) * (time - a)) / (b - a || 1);
    };
    const clip = [];
    for (const frame of frames) {
      const time = Math.max(0, clipTime(frame.time));
      if (time >= LENGTH) break;
      if (clip.length && time <= clip.at(-1).time + 0.001) {
        if (time === 0) clip[clip.length - 1] = { data: frame.data, time }; // keep the latest frame before the start
        continue;
      }
      clip.push({ data: frame.data, time });
    }
    if (clip.length < LENGTH * 5) throw new Error(`only ${clip.length} frames captured`);
    return clip;
  } finally {
    cdp.close();
    chrome.kill();
  }
}

/** Writes the frames and an ffmpeg concat list with each frame's duration; returns the list path. */
function writeConcatList(frames, dir) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  frames.forEach((frame, index) => {
    const file = join(dir, `${String(index).padStart(5, '0')}.jpg`);
    writeFileSync(file, frame.data);
    const next = frames[index + 1]?.time ?? LENGTH;
    lines.push(`file '${file}'`, `duration ${Math.max(0.001, next - frame.time).toFixed(4)}`);
  });
  // The concat demuxer ignores the last duration unless the last file is listed again.
  lines.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  const list = join(dir, 'frames.txt');
  writeFileSync(list, `${lines.join('\n')}\n`);
  return list;
}

const ffmpegEncoders = () => spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';

function encode(list, workDir, out, { mp4 }) {
  if (!has('ffmpeg')) throw new Error('ffmpeg not found');
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  // tpad gives the fps filter frames up to exactly LENGTH.
  const filter = `tpad=stop_mode=clone:stop_duration=0.5,fps=${FPS},scale=${OUTPUT_WIDTH}:-2:flags=lanczos`;
  const encoders = ffmpegEncoders();
  mkdirSync(out, { recursive: true });
  const webp = join(out, 'hero.webp');
  if (/\blibwebp_anim\b/.test(encoders)) {
    run('ffmpeg', [...input, '-vf', filter, '-t', String(LENGTH), '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', WEBP_QUALITY, '-compression_level', '6', '-loop', '0', '-an', webp]);
  } else if (has('img2webp', ['-version'])) {
    const pngDir = join(workDir, 'png');
    mkdirSync(pngDir, { recursive: true });
    run('ffmpeg', [...input, '-vf', filter, '-t', String(LENGTH), join(pngDir, '%04d.png')]);
    const count = Math.round(LENGTH * FPS);
    const pngs = Array.from({ length: count }, (_, i) => join(pngDir, `${String(i + 1).padStart(4, '0')}.png`)).filter(existsSync);
    run('img2webp', ['-loop', '0', '-lossy', '-q', WEBP_QUALITY, '-m', '6', '-d', String(Math.round(1000 / FPS)), ...pngs, '-o', webp]);
  } else {
    throw new Error('no WebP encoder: ffmpeg has no libwebp_anim and img2webp is not installed');
  }
  const still = join(out, 'hero-still.webp');
  const stillPng = join(workDir, 'still.png');
  run('ffmpeg', [...input, '-vf', `fps=${FPS},scale=${OUTPUT_WIDTH}:-2:flags=lanczos`, '-ss', String(STILL_AT), '-frames:v', '1', stillPng]);
  if (has('cwebp', ['-version'])) run('cwebp', ['-quiet', '-q', '78', '-m', '6', stillPng, '-o', still]);
  else run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', stillPng, '-c:v', 'libwebp', '-q:v', '78', still]);
  const written = [webp, still];
  if (mp4) {
    const video = join(out, 'hero.mp4');
    run('ffmpeg', [...input, '-vf', filter, '-t', String(LENGTH), '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', video]);
    written.push(video);
  }
  return written;
}

/** Records the clip into `out` (needs a built site/dist). Returns the written file paths. */
export async function recordClip({ out = join(DIST, 'media'), mp4 = true, base = process.env.SITE_BASE } = {}) {
  if (!existsSync(join(DIST, 'lib/videojs-overtone/index.global.js'))) throw new Error('site/dist is not built: run npm run site:build');
  const normalized = normalizeBase(base);
  const workDir = mkdtempSync(join(tmpdir(), 'overtone-clip-'));
  const stageDir = join(DIST, '_record');
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'index.html'), readFileSync(join(SITE, 'scripts/record-stage.html'), 'utf8').replaceAll('%%BASE%%', normalized));
  const { server, url } = await startPreview({ base: normalized, port: 0 });
  const started = Date.now();
  try {
    console.log('  recording the hero clip (headless Chrome)…');
    const frames = await captureFrames(`${url}_record/`, workDir);
    const written = encode(writeConcatList(frames, join(workDir, 'frames')), workDir, out, { mp4 });
    const sizes = written.map((file) => `${file.split('/').pop()} ${(statSync(file).size / 1024).toFixed(0)} KB`).join(', ');
    console.log(`  clip: ${frames.length} frames captured, ${LENGTH} s at ${FPS} fps, ${(Date.now() - started) / 1000} s: ${sizes}`);
    return written;
  } finally {
    server.close();
    rmSync(stageDir, { recursive: true, force: true });
    if (!process.env.KEEP_CLIP_WORK) rmSync(workDir, { recursive: true, force: true });
    else console.log(`  kept ${workDir}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(SITE, 'assets');
  const mp4 = args.includes('--mp4') && outIndex >= 0;
  try {
    await recordClip({ out, mp4 });
    if (outIndex < 0) console.log('Updated site/assets/hero.webp and hero-still.webp (rebuild the site to use them).');
  } catch (error) {
    console.error(`Recording failed: ${error.message}`);
    process.exit(1);
  }
}

