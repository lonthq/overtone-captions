import { resolve } from 'node:path';
import { burn, type SpeakerNames } from '../burn/index.js';
import { oneOf } from '../config.js';
import { assertDocument } from '../document.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { readJson } from './validate.js';

export interface BurnFlags { style?: string; profile?: string; mode?: string; speakerNames?: string; font?: string; out?: string }

const MODES = ['styled', 'plain'] as const;
const SPEAKER_NAMES = ['never', 'change', 'always'] as const;

/** `overtone burn <media> <doc>`: an MP4 with the captions burned in. Returns the exit code. */
export async function runBurn(media: string, path: string, flags: BurnFlags, log: Logger, cwd = process.cwd()): Promise<number> {
  const read = await readJson(resolve(cwd, path), path);
  if ('error' in read) throw new UserError(read.error);
  const doc = assertDocument(read.value, path);
  const mode = oneOf('--mode', flags.mode, MODES);
  const speakerNames = oneOf<SpeakerNames>('--speaker-names', flags.speakerNames, SPEAKER_NAMES);
  const output = await burn(media, doc, {
    cwd,
    documentPath: path,
    ...(flags.style !== undefined ? { style: flags.style } : {}),
    ...(flags.profile !== undefined ? { profile: flags.profile } : {}),
    ...(mode ? { mode } : {}),
    ...(speakerNames ? { speakerNames } : {}),
    ...(flags.font !== undefined ? { font: flags.font } : {}),
    ...(flags.out !== undefined ? { output: flags.out } : {}),
  }, log);
  log.out(output);
  return 0;
}
