import { UserError } from '../errors.js';

/** Azure diarization runs per file, and speakers are not matched across chunks. */
export const MAX_DURATION_SECONDS = 2 * 60 * 60;

/** 7300 → "2:01:40" */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const tooLong = (seconds: number) => new UserError(`Media is ${clock(seconds)} long; v1 supports up to ${clock(MAX_DURATION_SECONDS)}.`);

/** A chunk's or a stretch's span in log lines: "0:00:00–0:23:20". */
export const span = (c: { start: number; end: number }) => `${clock(c.start)}–${clock(c.end)}`;
