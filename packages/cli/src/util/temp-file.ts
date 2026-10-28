// Atomic writes: write to a temporary name next to the target, then rename. No reader ever sees a half-written file
// under the final name, and a stop by signal removes the temporary file.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { onInterrupt } from './interrupt.js';

const unique = (separator: string) => `${process.pid}${separator}${randomBytes(4).toString('hex')}`;

/** "<file>.<pid>.<random>.tmp", so a reader listing "*.json" never sees it. */
export function tmpPath(file: string): string {
  return `${file}.${unique('.')}.tmp`;
}

/**
 * A temporary name for ffmpeg output that keeps the extension last, since ffmpeg picks the format from it:
 * "chunk-0.mp3" → "chunk-0.partial-<pid>-<random>.mp3". `ext` defaults to the file's own.
 */
export function partialPath(file: string, ext = extname(file)): string {
  return `${file.slice(0, file.length - extname(file).length)}.partial-${unique('-')}${ext}`;
}

/** `write` creates `tmp`, which is then renamed to `file`. `tmp` is always removed, also on a stop. */
export async function writeViaTemp(file: string, write: (tmp: string) => Promise<unknown>, tmp = partialPath(file)): Promise<void> {
  const forget = onInterrupt(() => rmSync(tmp, { force: true }));
  try {
    await write(tmp);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
    forget();
  }
}

/** Writes `data` to `file` through a temporary file (`tmpPath`). */
export async function writeFileViaTemp(file: string, data: string | Uint8Array): Promise<void> {
  await writeViaTemp(file, (tmp) => writeFile(tmp, data), tmpPath(file));
}

/** A temporary folder from `makeTempDir`. */
export interface TempDir {
  path: string;
  /** Removes the folder and everything in it, and forgets the cleanup on a stop. */
  remove(): Promise<void>;
}

/**
 * A new "<prefix><random>" folder in the OS temp folder, removed by `remove()` (call it in a `finally`) or on
 * SIGINT/SIGTERM.
 */
export async function makeTempDir(prefix: string): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const forget = onInterrupt(() => rmSync(path, { recursive: true, force: true }));
  return {
    path,
    async remove() {
      try {
        await rm(path, { recursive: true, force: true });
      } finally {
        forget();
      }
    },
  };
}
