// EBU R128 / ITU-R BS.1770 loudness of the media's first audio track (meta.loudness). Information for the platform
// (level playback across videos, warn about quiet or clipping audio); Overtone never acts on it.
import { resolve } from 'node:path';
import { FIRST_AUDIO_ARGS, run } from './extract.js';

export const LOUDNESS_STANDARD = 'EBU R128 (ITU-R BS.1770)';
/** ebur128 reports silence as −70 LUFS, its absolute gate: no loudness to report. */
export const SILENCE_LUFS = -70;
/** framelog=verbose: only the summary at the default log level, not one line per 100 ms. */
const FILTER = 'ebur128=peak=true+sample:framelog=verbose';

/** Values that cannot be measured (silence, −inf peaks) are left out. */
export interface Loudness {
  standard: string;
  integratedLufs?: number;
  rangeLu?: number;
  truePeakDbtp?: number;
  samplePeakDbfs?: number;
}

const NUMBER = '(-inf|-?\\d+(?:\\.\\d+)?)';

/** The last `Summary:` block of ffmpeg's ebur128 output. */
export function parseEbur128(stderr: string): Loudness {
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) throw new Error('ffmpeg printed no loudness summary');
  const s = stderr.slice(at);
  const read = (re: RegExp): number | undefined => {
    const m = re.exec(s);
    return m && m[1] !== '-inf' ? Number(m[1]) : undefined;
  };
  const integrated = read(new RegExp(`I:\\s+${NUMBER} LUFS`));
  const range = read(new RegExp(`LRA:\\s+${NUMBER} LU\\b`));
  const sample = read(new RegExp(`Sample peak:\\s+Peak:\\s+${NUMBER} dBFS`));
  // ffmpeg labels the true peak dBFS; measured with 4× oversampling it is dBTP
  const truePeak = read(new RegExp(`True peak:\\s+Peak:\\s+${NUMBER} dBFS`));
  const loud = integrated !== undefined && integrated > SILENCE_LUFS;
  return {
    standard: LOUDNESS_STANDARD,
    ...(loud ? { integratedLufs: integrated } : {}),
    ...(loud && range !== undefined ? { rangeLu: range } : {}),
    ...(truePeak !== undefined ? { truePeakDbtp: truePeak } : {}),
    ...(sample !== undefined ? { samplePeakDbfs: sample } : {}),
  };
}

/** One ffmpeg pass over the first audio track; `signal` stops it. */
export async function measureLoudness(media: string, signal?: AbortSignal): Promise<Loudness> {
  const { stderr } = await run('ffmpeg', ['-nostats', '-hide_banner', '-v', 'info', '-i', resolve(media), ...FIRST_AUDIO_ARGS, '-vn', '-af', FILTER, '-f', 'null', '-'], signal ? { signal } : {});
  return parseEbur128(stderr);
}
