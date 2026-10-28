import { constants, realpathSync, statSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import nodePath, { basename, join, resolve, type PlatformPath } from 'node:path';
import { toPlayerDocument, toSRT, toTranscript, toWebVTT, type OvertoneDocument } from 'overtone-format';
import type { ExportFormat } from './config.js';
import { UserError, fsCode } from './errors.js';
import { findProfileId } from './segment/aspect.js';
import { writeFileViaTemp } from './util/temp-file.js';

/** "talk.overtone.json" → "talk", "clip.mp4" → "clip", "a.b.mov" → "a.b" */
export function baseName(path: string): string {
  const name = basename(path);
  if (name.endsWith('.overtone.json')) return name.slice(0, -'.overtone.json'.length);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * True when both paths name the same file, also through a symlink, a hard link or letter case on a case-insensitive
 * filesystem. A path that does not exist yet is a new file unless it resolves to the other.
 */
export function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    // network shares may report no file number; compare resolved paths there
    if (sa.ino === 0n || sb.ino === 0n) return realpathSync(a) === realpathSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * True when `target` is strictly inside `root`. Uses a relative path, since a "root + separator" prefix breaks for a
 * filesystem root such as "/" or "C:\\".
 */
export function isInsideFolder(root: string, target: string, path: Pick<PlatformPath, 'relative' | 'resolve' | 'isAbsolute' | 'sep'> = nodePath): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return true;
}

/** Options for the rendered files (VTT, SRT, TXT); the JSON document is written as is. */
export interface ExportOptions {
  /** Append "(??)" to unresolved words (`markUncertain`). */
  markUncertain?: boolean;
}

export interface WriteOptions extends ExportOptions {
  base: string;
  outDir: string;
  formats: readonly ExportFormat[];
  /** Profiles for VTT/SRT. Default: every profile in the document. */
  profiles?: readonly string[];
  /** Inputs no output may overwrite (media, --text-file, the re-exported document); nothing is written if one would be. */
  protect?: readonly InputFile[];
}

/** A run's input file and how the user knows it ("the --text-file"). */
export interface InputFile { path: string; what: string }

/** A file an export writes, and the format that writes it. */
export interface PlannedOutput { path: string; format: ExportFormat }

/**
 * The files `writeOutputs` writes, in its order: `<base>.overtone.json`, `<base>.player.overtone.json`,
 * `<base>.<profile>.vtt`, `<base>.<profile>.words.vtt`, `<base>.<profile>.srt`, `<base>.txt`, and with mp4
 * `<base>.captioned.mp4` (written by the burn step).
 */
export function plannedOutputs(opts: { base: string; outDir: string; formats: readonly ExportFormat[]; profiles: readonly string[] }): PlannedOutput[] {
  const out: PlannedOutput[] = [];
  const at = (name: string, format: ExportFormat) => out.push({ path: join(opts.outDir, name), format });
  if (opts.formats.includes('json')) at(`${opts.base}.overtone.json`, 'json');
  if (opts.formats.includes('player')) at(`${opts.base}.player.overtone.json`, 'player');
  for (const id of opts.profiles) {
    if (opts.formats.includes('vtt')) at(`${opts.base}.${id}.vtt`, 'vtt');
    if (opts.formats.includes('vtt-words')) at(`${opts.base}.${id}.words.vtt`, 'vtt-words');
    if (opts.formats.includes('srt')) at(`${opts.base}.${id}.srt`, 'srt');
  }
  if (opts.formats.includes('txt')) at(`${opts.base}.txt`, 'txt');
  if (opts.formats.includes('mp4')) at(`${opts.base}.captioned.mp4`, 'mp4');
  return out;
}

/** Throws a UserError when an output would overwrite an input, naming both and the fix. */
export function assertNoInputOverwrite(outputs: readonly PlannedOutput[], inputs: readonly InputFile[]): void {
  for (const input of inputs) {
    const clash = outputs.find((o) => samePath(o.path, input.path));
    if (clash) {
      throw new UserError(
        `Refusing to overwrite ${input.what} ${input.path}: the ${clash.format} export writes to the same path. `
        + `Write the outputs to another folder with --out, or rename ${input.what}.`,
      );
    }
  }
}

/** Below this confidence (similarity of the two sides' words) a word is unresolved. */
export const UNCERTAIN_BELOW = 0.5;
export const UNCERTAIN_MARK = '(??)';

/**
 * Unresolved words (flat index): the timing side heard something clearly different (match "fuzzy", confidence below
 * UNCERTAIN_BELOW) and no edit changed the words. A punctuation edit leaves the words, so they still count unless
 * their confidence is 0 (unknown time). Words with an unknown time and accepted word changes do not count.
 */
export function uncertainWords(doc: OvertoneDocument): boolean[] {
  const punctuated = new Set<number>();
  for (const e of doc.edits ?? []) if (e.reason === 'punctuation') for (let i = e.words[0]; i <= e.words[1]; i++) punctuated.add(i);
  return doc.turns.flatMap((t) => t.words).map((w, i) => {
    if (w.confidence === undefined || w.confidence >= UNCERTAIN_BELOW) return false;
    return w.match === 'fuzzy' || (w.match === 'edited' && punctuated.has(i) && w.confidence > 0);
  });
}

/**
 * A copy for rendering with UNCERTAIN_MARK after each run of unresolved words, before closing punctuation ("Sacks
 * (??)", "table (??)."). A run ends at a turn change and, for a profile, at a line end, so every line shows its own
 * mark. Only word texts change; cue line texts stay.
 */
export function markUncertain(doc: OvertoneDocument, profileId?: string): OvertoneDocument {
  const uncertain = uncertainWords(doc);
  const lineEnds = new Set<number>();
  for (const cue of doc.profiles.find((p) => p.id === profileId)?.cues ?? []) for (const line of cue.lines) lineEnds.add(line.words[1]);
  let i = 0;
  const turns = doc.turns.map((t) => ({
    ...t,
    words: t.words.map((w, k) => {
      const at = i++;
      const runEnds = k === t.words.length - 1 || lineEnds.has(at) || !uncertain[at + 1];
      if (!uncertain[at] || !runEnds) return w;
      return { ...w, text: w.text.replace(/^(.*?)([.,;:!?…"'”’»)\]]*)$/su, (_m, core: string, closing: string) => `${core} ${UNCERTAIN_MARK}${closing}`) };
    }),
  }));
  return { ...doc, turns };
}

/** Write the requested files and return their paths in plannedOutputs order. Each write is atomic (writeFileViaTemp). */
export async function writeOutputs(doc: OvertoneDocument, opts: WriteOptions): Promise<string[]> {
  const available = doc.profiles.map((p) => p.id);
  // a profile is named by its id or, for an aspect, as W:H or WxH
  const seen = new Map<string, string>();
  const profiles = (opts.profiles ?? available).map((token) => {
    const id = findProfileId(available, token);
    if (id === undefined) throw new UserError(`Profile "${token}" is not in the document (has: ${available.join(', ') || 'none'}).`);
    const first = seen.get(id);
    if (first !== undefined) throw new UserError(`Profile "${id}" is listed twice ("${first}" and "${token}"); list each profile once.`);
    seen.set(id, token);
    return id;
  });
  // plan every file first, so nothing is written when one path is unsafe
  const planned: Array<{ path: string; format: ExportFormat; content: string }> = [];
  const plan = (name: string, format: ExportFormat, content: string): void => {
    const path = join(opts.outDir, name);
    if (!isInsideFolder(opts.outDir, path)) throw new UserError(`Refusing to write outside the output folder: ${name}`);
    planned.push({ path, format, content });
  };
  if (opts.formats.includes('json')) plan(`${opts.base}.overtone.json`, 'json', `${JSON.stringify(doc, null, 2)}\n`);
  // compact: this one is for the web
  if (opts.formats.includes('player')) plan(`${opts.base}.player.overtone.json`, 'player', `${JSON.stringify(toPlayerDocument(doc, { profiles }))}\n`);
  const shown = (profileId?: string) => (opts.markUncertain ? markUncertain(doc, profileId) : doc);
  for (const id of profiles) {
    if (opts.formats.includes('vtt')) plan(`${opts.base}.${id}.vtt`, 'vtt', toWebVTT(shown(id), id));
    if (opts.formats.includes('vtt-words')) plan(`${opts.base}.${id}.words.vtt`, 'vtt-words', toWebVTT(shown(id), id, { wordTimings: true }));
    if (opts.formats.includes('srt')) plan(`${opts.base}.${id}.srt`, 'srt', toSRT(shown(id), id));
  }
  if (opts.formats.includes('txt')) plan(`${opts.base}.txt`, 'txt', toTranscript(shown()));
  assertNoInputOverwrite(planned, opts.protect ?? []);

  try {
    await mkdir(opts.outDir, { recursive: true });
  } catch (err) {
    throw fsFailure('Cannot create output folder', opts.outDir, err);
  }
  // A rename would replace a read-only file (it needs only folder permission), so refuse those up front, as a direct
  // write would.
  for (const { path } of planned) {
    try {
      await access(path, constants.W_OK);
    } catch (err) {
      if (fsCode(err) !== 'ENOENT') throw fsFailure('Cannot write', path, err);
    }
  }
  // Temp file plus rename: a stop (Ctrl-C) or a full disk never leaves a truncated file under the final name.
  for (const { path, content } of planned) {
    try {
      await writeFileViaTemp(path, content);
    } catch (err) {
      throw fsFailure('Cannot write', path, err);
    }
  }
  return planned.map((p) => p.path);
}

/** A one-line user error for a failed fs call: "<action> <path> (<code>)". */
function fsFailure(action: string, path: string, err: unknown): UserError {
  return new UserError(`${action} ${path} (${fsCode(err) ?? (err as Error).message})`);
}
