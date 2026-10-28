import { dirname, join, resolve } from 'node:path';
import { parseFormats, requireList, splitList } from '../config.js';
import { assertDocument } from '../document.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { baseName, samePath, writeOutputs } from '../output.js';
import { readJson } from './validate.js';

export interface ExportFlags { export?: string; profiles?: string; out?: string; markUncertain?: boolean }

/** mp4 burns captions into a video and needs the media file: only `transcribe` and `burn` write it. */
export function rejectMp4(value: string | readonly string[] | undefined): void {
  if (splitList(value)?.includes('mp4')) throw new UserError('mp4 needs the media file; use "overtone burn <media> <document>".');
}

/** `overtone export <file>`: re-export a document to VTT/SRT/TXT/JSON. Returns the exit code. */
export async function runExport(path: string, flags: ExportFlags, log: Logger, cwd = process.cwd()): Promise<number> {
  rejectMp4(flags.export);
  const input = resolve(cwd, path);
  const read = await readJson(input, path);
  if ('error' in read) throw new UserError(read.error);
  const doc = assertDocument(read.value, path);
  let formats = parseFormats(flags.export, ['vtt', 'srt', 'txt'], undefined, ['json', 'player', 'vtt', 'vtt-words', 'srt', 'txt']);
  // keep duplicates, so writeOutputs can reject a profile listed twice ("1:1,1x1")
  const profiles = requireList(flags.profiles, 'profiles', undefined, false);
  const base = baseName(path);
  const outDir = flags.out ? resolve(cwd, flags.out) : dirname(input);
  if (formats.includes('json') && samePath(join(outDir, `${base}.overtone.json`), input)) {
    log.warn(`Not overwriting the input file ${input}; skipping the json output (use --out to write it elsewhere).`);
    formats = formats.filter((f) => f !== 'json');
  }
  const protect = [{ path: input, what: 'the input file' }];
  const written = await writeOutputs(doc, { base, outDir, formats, profiles, ...(flags.markUncertain ? { markUncertain: true } : {}), protect });
  for (const p of written) log.out(p);
  return 0;
}
