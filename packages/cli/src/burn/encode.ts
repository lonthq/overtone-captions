import { basename, extname } from 'node:path';
import { UserError } from '../errors.js';
import { run } from '../media/extract.js';
import { partialPath, writeViaTemp } from '../util/temp-file.js';
import type { FrameEntry } from './frames.js';

/** Output containers by extension: .mp4, .mov (QuickTime), .m4v (ffmpeg's ipod muxer). */
export type Container = 'mp4' | 'mov' | 'm4v';

/**
 * Audio codecs copied with `-c:a copy` per container; others are re-encoded to AAC. MP4 and M4V copy only AAC: ffmpeg
 * also muxes MP3, Opus, FLAC and AC-3 into them, but QuickTime, Safari and many upload sites then play no sound. mov
 * keeps what QuickTime plays and ffmpeg muxes (checked against ffmpeg 8.1; mov refuses Opus and FLAC).
 */
const COPY_AUDIO: Readonly<Record<Container, readonly string[]>> = {
  mp4: ['aac'],
  mov: ['aac', 'mp3', 'alac', 'ac3', 'eac3'],
  m4v: ['aac'],
};

/** The container for an output path's extension (any case); MP4 by default. */
export function containerOf(output: string): Container {
  const ext = extname(output).slice(1).toLowerCase();
  return ext === 'mov' || ext === 'm4v' ? ext : 'mp4';
}

/**
 * Without it, each PNG's image2 demuxer runs at 25 fps and concat rounds every start to a 1/25 s grid (wrong at 30 or
 * 60 fps). At 1,000,000 fps timestamps are exact to the microsecond.
 */
const PTS_OPTION = 'option framerate 1000000';

/**
 * An ffmpeg concat list for `entries`, written in their folder. Each image lasts until the next; the last until
 * `duration` (at least one frame). The last file is listed twice, or concat ignores its duration.
 */
export function concatList(entries: readonly FrameEntry[], duration: number, fps: number): string {
  const lines = ['ffconcat version 1.0'];
  entries.forEach((entry, i) => {
    const end = entries[i + 1]?.start ?? Math.max(duration, entry.start + 1 / fps);
    lines.push(`file '${basename(entry.file)}'`, PTS_OPTION, `duration ${(end - entry.start).toFixed(6)}`);
  });
  if (entries.length > 0) lines.push(`file '${basename(entries.at(-1)!.file)}'`, PTS_OPTION);
  return `${lines.join('\n')}\n`;
}

/** The concat demuxer reads `option` lines from ffmpeg 5.0 on; 4.4 fails with "unknown keyword 'option'". */
export const MIN_FFMPEG = { major: 5, minor: 0 } as const;

const upgradeMessage = `Burning needs ffmpeg ${MIN_FFMPEG.major}.${MIN_FFMPEG.minor} or later (the installed ffmpeg cannot read the caption list); upgrade ffmpeg.`;

/** [major, minor] from `ffmpeg -version` ("8.1.1", "n6.1", "4.4.2-0ubuntu…"); undefined for git builds ("N-112345-g…"). */
export function parseFfmpegVersion(output: string): [number, number] | undefined {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/i.exec(output.trimStart());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export async function ffmpegVersion(): Promise<string> {
  return (await run('ffmpeg', ['-version'])).stdout;
}

/** Throws a UserError for an ffmpeg older than MIN_FFMPEG; an unknown version passes. */
export function checkFfmpegVersion(output: string): void {
  const v = parseFfmpegVersion(output);
  if (v && (v[0] < MIN_FFMPEG.major || (v[0] === MIN_FFMPEG.major && v[1] < MIN_FFMPEG.minor))) {
    throw new UserError(upgradeMessage);
  }
}

/** Copy the audio when `container` can hold `codec`, else re-encode to AAC; none without audio. */
export function audioArgs(codec: string | undefined, container: Container = 'mp4'): string[] {
  if (!codec) return [];
  return COPY_AUDIO[container].includes(codec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
}

/**
 * Paths must be absolute: a relative one starting with "-" would be read as an option. `videoStream` is the `0:v:N`
 * index to burn on (VideoInfo.videoStream); default 0.
 */
export interface EncodeOptions {
  media: string; list: string; output: string; audioCodec?: string; videoStream?: number;
  /** Default: by the extension of `output`. */
  container?: Container;
}

/**
 * Caption images over the probed video stream (not cover art), the first (transcribed) audio stream, H.264 CRF 18,
 * audio copied when possible. Odd sizes get one black pixel of padding: libx264 with yuv420p needs even sizes.
 */
export function burnArgs(o: EncodeOptions): string[] {
  return [
    '-y', '-v', 'error', '-i', o.media, '-f', 'concat', '-safe', '0', '-i', o.list,
    '-filter_complex', `[0:v:${o.videoStream ?? 0}][1:v]overlay=0:0:eof_action=pass,pad=ceil(iw/2)*2:ceil(ih/2)*2[v]`, '-map', '[v]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...audioArgs(o.audioCodec, o.container ?? containerOf(o.output)),
    '-movflags', '+faststart', o.output,
  ];
}

/** Encodes to a temporary file and renames it into place, so no half-written MP4 is left behind. */
export async function encode(o: EncodeOptions, runner: typeof run = run): Promise<void> {
  await writeViaTemp(o.output, async (tmp) => {
    try {
      // the container follows the final name, not the temporary one
      await runner('ffmpeg', burnArgs({ ...o, output: tmp, container: o.container ?? containerOf(o.output) }));
    } catch (err) {
      // an ffmpeg older than MIN_FFMPEG
      if (err instanceof Error && /unknown keyword 'option'/.test(err.message)) throw new UserError(upgradeMessage);
      // ffmpeg's message says what to fix (unwritable output, full disk); a stack trace would not
      if (err instanceof Error && !(err instanceof UserError)) throw new UserError(`${err.message} (while writing ${o.output})`);
      throw err;
    }
  }, partialPath(o.output, extname(o.output) || '.mp4'));
}
