export interface Silence { start: number; end: number }
export interface ChunkSpan { start: number; end: number }

/** Parses ffmpeg `silencedetect` output. A silence still open at the end ends at `duration`. */
export function parseSilences(stderr: string, duration: number): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

export interface ChunkPlanOptions {
  /** Compressed-audio bytes per second of media. */
  bytesPerSecond: number;
  /** Upload limit per chunk. */
  maxBytes: number;
  /** Duration limit per chunk (s). */
  maxSeconds: number;
  silences: readonly Silence[];
}

/** Share of the provider's size and length limits a chunk may use (5 % margin for container and rounding). */
export const CHUNK_SAFETY = 0.95;

/**
 * Cuts [0, duration] into chunks within both limits, each cut in the middle of the latest silence in the last
 * quarter chunk before the limit, else at the limit. A very short last chunk is avoided by moving the previous cut
 * back, preferably to a silence.
 */
export function planChunks(duration: number, o: ChunkPlanOptions): ChunkSpan[] {
  const maxLen = Math.min(o.maxBytes / o.bytesPerSecond, o.maxSeconds) * CHUNK_SAFETY;
  // a limit ≤ 0 would loop forever; config.ts validates chunkMb, this is the backstop
  if (!(maxLen > 0)) {
    throw new RangeError(`Cannot plan audio chunks: the chunk limit is ${maxLen} s (maxBytes ${o.maxBytes}, ${o.bytesPerSecond} bytes/s, maxSeconds ${o.maxSeconds}).`);
  }
  if (duration <= maxLen) return [{ start: 0, end: duration }];
  const chunks: ChunkSpan[] = [];
  let cursor = 0;
  while (duration - cursor > maxLen) {
    const target = cursor + maxLen;
    const from = target - maxLen / 4;
    const mids = o.silences.map((s) => (s.start + s.end) / 2).filter((m) => m > from && m <= target && m > cursor);
    const cut = mids.length > 0 ? Math.max(...mids) : target;
    // floating point: a limit tiny next to the cursor leaves cursor + maxLen === cursor
    if (!(cut > cursor)) throw new RangeError(`Cannot plan audio chunks: no progress at ${cursor} s (chunk limit ${maxLen} s).`);
    chunks.push({ start: cursor, end: cut });
    cursor = cut;
  }
  // Providers reject or hallucinate on near-empty audio: move the previous cut back to the latest silence that keeps
  // both chunks within the limit, else to a fixed point.
  const minTail = Math.min(5, maxLen / 2);
  const last = chunks.at(-1)!;
  if (duration - cursor < minTail) {
    const lo = Math.max(duration - maxLen, last.start);
    const hi = duration - minTail;
    const mids = o.silences.map((s) => (s.start + s.end) / 2).filter((m) => m >= lo && m <= hi && m > last.start);
    cursor = mids.length > 0 ? Math.max(...mids) : hi;
    last.end = cursor;
  }
  chunks.push({ start: cursor, end: duration });
  return chunks;
}
