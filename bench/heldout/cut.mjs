// Cuts one excerpt for the held-out study (see PROTOCOL.md, "Clips"): a window around the nominal start and end
// is fetched from the source, both ends move to the middle of the nearest silence of 0.5 s or more
// (ffmpeg silencedetect), and only the excerpt is kept in bench/heldout/data/clips/ (git-ignored).
//
//   node bench/heldout/cut.mjs <id> <source URL or file> <start s> <duration s> [--video] [--audio=<URL or file>]
//
// --audio takes the sound from a separate source with the same timeline (an HLS audio rendition, such as the
// European Parliament's original-language track) instead of the first audio stream of the source.
//
// Prints one JSON line for clips.json: the file, where the excerpt starts in the source, its duration, the
// silence threshold that was used and the SHA-256 of the file.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('data/', import.meta.url));
const MARGIN = 30;                       // seconds fetched before the start and after the end
const MIN_SILENCE = 0.5;                 // seconds, as in the protocol
const THRESHOLDS = [-35, -30, -25, -20]; // dB, tried in order until a silence is found near both ends

const [id, source, startArg, durationArg, ...flags] = process.argv.slice(2);
if (!id || !source || startArg === undefined || durationArg === undefined) {
  console.error('usage: node bench/heldout/cut.mjs <id> <source> <start s> <duration s> [--video] [--audio=<source>]');
  process.exit(1);
}
const video = flags.includes('--video');
const audioSource = flags.find((flag) => flag.startsWith('--audio='))?.slice('--audio='.length);
// HLS sources may name their segments .m4v or .m4a, which ffmpeg's HLS reader refuses by default.
const inputOf = (src) => (/\.m3u8/.test(src) ? ['-extension_picky', '0', '-i', src] : ['-i', src]);
const input = inputOf(source);
const start = Number(startArg);
const duration = Number(durationArg);
const windowStart = Math.max(0, start - MARGIN);

const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

mkdirSync(join(DATA, 'raw'), { recursive: true });
mkdirSync(join(DATA, 'clips'), { recursive: true });
const windowFile = join(DATA, 'raw', `${id}.window.${video ? 'mkv' : 'wav'}`);
const windowLength = start - windowStart + duration + MARGIN;

/** The absolute index of the tallest video stream, for sources with several resolutions (HLS). */
function tallestVideo() {
  const streams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index,height',
    '-of', 'csv=p=0', ...input]).toString().split('\n').filter((line) => line.includes(',')).map((line) => line.split(',').map(Number));
  return streams.sort((a, b) => b[1] - a[1])[0][0];
}

// The window: video and audio streams copied (cut points are set precisely below), or audio as WAV.
const audioInput = audioSource ? ['-ss', String(windowStart), ...inputOf(audioSource)] : [];
const audioMap = audioSource ? '1:a:0' : '0:a:0';
ffmpeg(['-ss', String(windowStart), ...input, ...audioInput, '-t', String(windowLength),
  ...(video ? ['-map', `0:${tallestVideo()}`, '-map', audioMap, '-c', 'copy'] : ['-map', audioMap, '-vn', '-ac', '1', '-ar', '48000']), windowFile]);

/** Silences in the window at a threshold, as [start, end] pairs in window time (ffmpeg logs them on stderr). */
function detect(threshold) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', windowFile, '-vn',
    '-af', `silencedetect=n=${threshold}dB:d=${MIN_SILENCE}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const pairs = [];
  let open = null;
  for (const line of out.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open !== null) { pairs.push([open, Number(e[1])]); open = null; }
  }
  return pairs;
}

const nominalStart = start - windowStart;
const nominalEnd = nominalStart + duration;
let chosen = null;
for (const threshold of THRESHOLDS) {
  const found = detect(threshold);
  const nearest = (t) => found
    .map(([a, b]) => ({ mid: (a + b) / 2, distance: Math.abs((a + b) / 2 - t) }))
    .filter(({ distance }) => distance <= MARGIN)
    .sort((x, y) => x.distance - y.distance)[0];
  const a = nearest(nominalStart);
  const b = nearest(nominalEnd);
  if (a && b && b.mid > a.mid) { chosen = { threshold, from: a.mid, to: b.mid }; break; }
}
if (!chosen) {
  rmSync(windowFile, { force: true });
  console.error(`${id}: no silence of ${MIN_SILENCE} s within ${MARGIN} s of both ends at ${THRESHOLDS.join(', ')} dB`);
  process.exit(1);
}

const clipFile = join(DATA, 'clips', `${id}.${video ? 'mp4' : 'flac'}`);
ffmpeg(['-ss', chosen.from.toFixed(3), '-i', windowFile, '-t', (chosen.to - chosen.from).toFixed(3),
  ...(video ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] : ['-c:a', 'flac']),
  clipFile]);
rmSync(windowFile, { force: true });

const sha256 = createHash('sha256').update(readFileSync(clipFile)).digest('hex');
console.log(JSON.stringify({
  id,
  file: `data/clips/${id}.${video ? 'mp4' : 'flac'}`,
  sourceStart: Number((windowStart + chosen.from).toFixed(3)),
  duration: Number((chosen.to - chosen.from).toFixed(3)),
  silenceThresholdDb: chosen.threshold,
  sha256,
}));
