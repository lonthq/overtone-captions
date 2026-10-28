import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { UserError } from '../errors.js';
import { onInterrupt } from '../util/interrupt.js';
import { partialPath, writeViaTemp } from '../util/temp-file.js';
import type { AudioChunk } from '../providers/types.js';
import { CHUNK_SAFETY, parseSilences, planChunks, type Silence } from './chunks.js';

const exec = promisify(execFile);

/**
 * For every uploaded or cache-hashed audio file: no input metadata and no ffmpeg version stamp, so an ffmpeg upgrade
 * writes the same bytes and cached answers still match.
 */
export const BITEXACT_ARGS = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'] as const;
/** Audio for the text provider: MP3, mono, 24 kHz, 48 kbit/s (≈ 21.6 MB per hour, accepted everywhere). */
export const COMPRESSED = { ext: 'mp3', args: ['-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k', ...BITEXACT_ARGS] } as const;
/** Audio for the timing provider: 16 kHz mono 16-bit PCM WAV. */
export const WAV_ARGS = ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', ...BITEXACT_ARGS] as const;
/**
 * Single-pass EBU R128 loudness normalization. Used with `--normalize-loudness`, and on the retry of a chunk the text
 * model heard too little of: quiet recordings (−40 dB mean) can come back empty.
 */
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';
/** gpt-4o-transcribe-family models reject audio over 1500 s; stay below that per chunk. */
export const DEFAULT_MAX_CHUNK_SECONDS = 1400;

export async function run(cmd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const running = exec(cmd, [...args], { maxBuffer: 64 * 1024 * 1024 });
  // SIGTERM reaches only this process; without this, ffmpeg keeps running and writing
  const forget = onInterrupt(() => running.child.kill('SIGKILL'));
  try {
    return await running;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new UserError(`${cmd} not found on PATH; install ffmpeg (https://ffmpeg.org/download.html).`);
    throw new Error(`${cmd} failed: ${errorReason(e.stderr || e.message)}`);
  } finally {
    forget();
  }
}

/**
 * The useful part of ffmpeg's error output, without "[webm @ 0x…]" tags: the first lines (the cause; later lines are
 * mostly consequences) and the last one.
 */
export function errorReason(output: string): string {
  const lines = output.split('\n').map((l) => l.replace(/^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i, '').trim()).filter(Boolean);
  return lines.length <= 4 ? lines.join(' ') : [...lines.slice(0, 3), '…', lines.at(-1)].join(' ');
}

/** Which of ffmpeg and ffprobe do not run. */
export async function missingBinaries(): Promise<string[]> {
  const missing: string[] = [];
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await exec(bin, ['-version']);
    } catch {
      missing.push(bin);
    }
  }
  return missing;
}

/**
 * Silences (below −35 dB for ≥ 0.4 s) where chunks are cut. The threshold is fixed: very noisy or very quiet
 * recordings may have none, and chunks are then cut at the limit.
 */
export async function detectSilences(path: string, duration: number): Promise<Silence[]> {
  const { stderr } = await run('ffmpeg', ['-v', 'info', '-i', path, '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-']);
  return parseSilences(stderr, duration);
}

/**
 * Transcribe the first audio track, the one `overtone burn` keeps and probeVideo reports. ffmpeg's own pick (default
 * track, else most channels) can be another language on a multi-language film.
 */
export const FIRST_AUDIO_ARGS = ['-map', '0:a:0'] as const;

/** ffprobe arguments that print only the container's duration in seconds. */
const DURATION_ARGS = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1'] as const;

/** Strips the leading path: "in.mp4: Invalid data …" → "Invalid data …". */
export function afterPath(message: string, path: string): string {
  const at = message.lastIndexOf(`${path}: `);
  return at >= 0 ? message.slice(at + path.length + 2) : message;
}

/** Duration in seconds. Exact for WAV; unreliable for streamed WebM and ADTS. */
export async function probeDuration(media: string): Promise<number> {
  media = resolve(media); // never read as an option ("-x.wav") or a protocol ("a:b.m4a")
  const { stdout } = await run('ffprobe', [...DURATION_ARGS, media]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new UserError(`Cannot read the duration of ${media}; is it an audio/video file?`);
  return d;
}

/**
 * Preflight: the input's duration in seconds, or undefined when it has none (streamed WebM). An unreadable file is a
 * UserError with ffprobe's last message line.
 */
export async function probeMedia(media: string): Promise<number | undefined> {
  const path = resolve(media);
  let stdout: string;
  try {
    ({ stdout } = await exec('ffprobe', [...DURATION_ARGS, path]));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new UserError('ffprobe not found on PATH; install ffmpeg (https://ffmpeg.org/download.html).');
    const last = (e.stderr ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? e.message.trim();
    throw new UserError(`Cannot read ${path}: not an audio/video file (${afterPath(last, path)})`);
  }
  const d = Number(stdout.trim().split('\n')[0]);
  return Number.isFinite(d) && d > 0 ? d : undefined;
}

/** `duration` is the extracted WAV's length, which every chunk and time refers to. */
export interface ExtractResult { duration: number; wav: string; chunks: AudioChunk[] }
export interface ExtractOptions {
  chunkBytes: number;
  maxChunkSeconds?: number;
  /** Loudness-normalize the WAV and the compressed audio (LOUDNORM_FILTER). */
  normalizeLoudness?: boolean;
}

/**
 * Stage 1: WAV for timing, compressed audio for text, split at silences when over the limits. Files are renamed into
 * place only once all are complete, so an interrupted run leaves no truncated file under a final name.
 */
export async function extractAudio(media: string, dir: string, opts: ExtractOptions): Promise<ExtractResult> {
  dir = resolve(dir);
  await mkdir(dir, { recursive: true });
  media = resolve(media);
  const { stdout: audioStreams } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', media]);
  if (audioStreams.trim() === '') throw new UserError(`${media} has no audio track.`);
  const pending: Array<{ tmp: string; final: string }> = [];
  const wav = join(dir, 'audio.wav');
  const compressed = join(dir, `audio.${COMPRESSED.ext}`);
  const wavTmp = partialPath(wav);
  const compressedTmp = partialPath(compressed);
  pending.push({ tmp: wavTmp, final: wav }, { tmp: compressedTmp, final: compressed });
  const forget = onInterrupt(() => { for (const { tmp } of pending) rmSync(tmp, { force: true }); });
  const filter = opts.normalizeLoudness ? ['-af', LOUDNORM_FILTER] : [];
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', media, ...FIRST_AUDIO_ARGS, '-vn', ...filter, ...WAV_ARGS, wavTmp]);
    // measure the WAV, not the input: streamed WebM has no duration, ADTS only an estimate, and video can outlast audio
    const duration = await probeDuration(wavTmp);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', media, ...FIRST_AUDIO_ARGS, '-vn', ...filter, ...COMPRESSED.args, compressedTmp]);
    const size = (await stat(compressedTmp)).size;
    const maxSeconds = opts.maxChunkSeconds ?? DEFAULT_MAX_CHUNK_SECONDS;
    let chunks: AudioChunk[];
    if (size <= opts.chunkBytes && duration <= maxSeconds * CHUNK_SAFETY) {
      chunks = [{ path: compressed, index: 0, start: 0, end: duration }];
    } else {
      const spans = planChunks(duration, { bytesPerSecond: size / duration, maxBytes: opts.chunkBytes, maxSeconds, silences: await detectSilences(wavTmp, duration) });
      chunks = [];
      for (const [index, span] of spans.entries()) {
        const path = join(dir, `chunk-${index}.${COMPRESSED.ext}`);
        const tmp = partialPath(path);
        pending.push({ tmp, final: path });
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', span.start.toFixed(3), '-to', span.end.toFixed(3), '-i', compressedTmp, '-c', 'copy', ...BITEXACT_ARGS, tmp]);
        chunks.push({ path, index, start: span.start, end: span.end });
      }
    }
    for (const { tmp, final } of pending) await rename(tmp, final);
    return { duration, wav, chunks };
  } finally {
    await Promise.all(pending.map(({ tmp }) => rm(tmp, { force: true })));
    forget();
  }
}

/** Writes a loudness-normalized copy next to `input`, same format: `chunk-0.mp3` → `chunk-0.loudnorm.mp3`. */
export async function normalizeLoudness(input: string): Promise<string> {
  input = resolve(input);
  const ext = extname(input);
  const output = `${input.slice(0, input.length - ext.length)}.loudnorm${ext}`;
  const args = ext.toLowerCase() === '.wav' ? WAV_ARGS : COMPRESSED.args;
  await writeViaTemp(output, (tmp) => run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-af', LOUDNORM_FILTER, ...args, tmp]));
  return output;
}

/**
 * Writes [start, end] (s within `input`) next to it, re-encoded in the same format:
 * `chunk-0.mp3` → `chunk-0.region-15080-26900.mp3`. For re-listening, or retrying an empty chunk's speech.
 */
export async function cutAudio(input: string, start: number, end: number): Promise<string> {
  input = resolve(input);
  const ext = extname(input);
  const stem = input.slice(0, input.length - ext.length);
  const span = `${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
  const output = `${stem}.region-${span}${ext}`;
  const args = ext.toLowerCase() === '.wav' ? WAV_ARGS : COMPRESSED.args;
  await writeViaTemp(output, (tmp) => run('ffmpeg', ['-y', '-v', 'error', '-ss', Math.max(0, start).toFixed(3), '-to', end.toFixed(3), '-i', input, ...args, tmp]));
  return output;
}
