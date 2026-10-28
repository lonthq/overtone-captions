import { resolve } from 'node:path';
import { run } from './extract.js';

/**
 * A video as `overtone burn` and the media profile see it. Sizes are display sizes (after rotation). `videoStream`
 * is the measured stream's `0:v:N` index (cover art counts), set only when not 0. `audioCodec` is the first audio
 * stream's.
 */
export interface VideoInfo { width: number; height: number; fps: number; duration?: number; audioCodec?: string; videoStream?: number }

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number | string }>;
}

/** A rate such as "30000/1001" if plausible (1 to 120 fps). */
function frameRate(rate: string | undefined): number | undefined {
  const [num, den] = (rate ?? '').split('/').map(Number);
  const fps = num / den;
  return Number.isFinite(fps) && fps >= 1 && fps <= 120 ? fps : undefined;
}

/** Reads the first real video stream (not cover art) and the first audio stream from ffprobe JSON; undefined without video. */
export function parseVideoProbe(json: { streams?: ProbeStream[]; format?: { duration?: string } }): VideoInfo | undefined {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  if (!video) return undefined;
  const videoStream = streams.filter((s) => s.codec_type === 'video').indexOf(video);
  const rotation = Math.abs(Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const duration = [json.format?.duration, video.duration].map(Number).find((d) => Number.isFinite(d) && d > 0);
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    width: rotation === 90 ? video.height! : video.width!,
    height: rotation === 90 ? video.width! : video.height!,
    // a stream that states no frame rate: 25 fps (the burn only uses it for its frame grid and the last frame's length)
    fps: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate) ?? 25,
    ...(duration !== undefined ? { duration } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    ...(videoStream > 0 ? { videoStream } : {}),
  };
}

/** Display size, frame rate, duration and audio codec; undefined for audio-only media. */
export async function probeVideo(media: string): Promise<VideoInfo | undefined> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration:stream_disposition=attached_pic:stream_side_data=rotation:format=duration',
    '-of', 'json',
    resolve(media),
  ]);
  return parseVideoProbe(JSON.parse(stdout));
}
