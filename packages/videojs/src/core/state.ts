import type { CaptionMode } from '../types.js';

/** Cycle order of the captions button and the `c` key. */
export const MODES: readonly CaptionMode[] = ['off', 'styled', 'plain'];

export function nextMode(mode: CaptionMode): CaptionMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function modeLabel(mode: CaptionMode): string {
  return `Captions: ${mode}`;
}

export function isCaptionMode(value: unknown): value is CaptionMode {
  return (MODES as readonly unknown[]).includes(value);
}

/** The stored mode, or `fallback` when storage is empty, invalid or unavailable. */
export function readStoredMode(key: string, fallback: CaptionMode): CaptionMode {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return isCaptionMode(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the mode; silently does nothing when storage is unavailable (private mode, sandboxed iframes). */
export function storeMode(key: string, mode: CaptionMode): void {
  try {
    globalThis.localStorage?.setItem(key, mode);
  } catch {
    // Storage blocked or full: not remembered.
  }
}
