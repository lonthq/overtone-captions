/** Rounds seconds to whole milliseconds (the format stores at most 3 decimals). */
export function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** `hh:mm:ss.mmm` (separator '.', WebVTT) or `hh:mm:ss,mmm` (separator ',', SRT). */
export function formatTimestamp(seconds: number, separator: '.' | ','): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}
