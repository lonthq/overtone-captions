import { dirname, join, resolve } from 'node:path';
import { flattenWords } from 'overtone-format';
import { loadConfigFile, resolveConfig, type CliFlags, type ExportFormat } from '../config.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { baseName, samePath, writeOutputs } from '../output.js';
import { readRecutSource, recutDocument } from '../recut.js';
import { canonicalLanguage, detectLanguage } from '../text/detect.js';
import { subtitleText } from '../text/subtitles.js';
import { GENERATOR } from '../version.js';
import { rejectMp4 } from './export.js';

export type RecutFlags = Pick<CliFlags, 'profiles' | 'export' | 'out' | 'language' | 'speakers' | 'glossary' | 'rules' | 'config'>;

/** recut writes the document and every rendered format unless --export or the config file says otherwise. */
export const RECUT_EXPORTS: readonly ExportFormat[] = ['json', 'vtt', 'srt', 'txt'];

export interface RecutDeps { now?: () => Date; generator?: string }

/** `overtone recut <file>`: re-cut subtitles (SRT, WebVTT) or an .overtone.json document by the rules. Offline: no providers, keys or ffmpeg. */
export async function runRecut(path: string, flags: RecutFlags, log: Logger, cwd = process.cwd(), deps: RecutDeps = {}): Promise<number> {
  const file = await loadConfigFile(flags.config, cwd, (m) => log.warn(m));
  // recut uses no context, so a context file the config names need not exist
  const cfg = await resolveConfig(flags, { ...file.config, context: undefined, contextFile: undefined }, { cwd, configDir: file.dir });
  let exports = flags.export === undefined && file.config.export === undefined ? [...RECUT_EXPORTS] : cfg.exports;
  if (exports.includes('mp4')) {
    if (flags.export !== undefined) rejectMp4(exports);
    // mp4 in the config file's "export" is meant for transcribe, which has the media
    log.info('recut: ignoring "mp4" from the config file\'s "export" (it needs the media; use overtone burn)');
    exports = exports.filter((f) => f !== 'mp4');
    if (exports.length === 0) exports = [...RECUT_EXPORTS];
  }
  const input = resolve(cwd, path);
  const source = await readRecutSource(input, path, (m) => log.warn(m));

  // language: --language (or the config file) > the document's > detected from the text > und
  let language: { code: string; from: string };
  if (cfg.language !== undefined) {
    const code = canonicalLanguage(cfg.language);
    if (!code) throw new UserError(`Invalid language "${cfg.language}"; expected a code such as en, nl or nl-BE, a name such as dutch, or "auto".`);
    language = { code, from: flags.language !== undefined ? '--language' : 'the config file' };
  } else if (source.kind === 'overtone') {
    language = { code: source.doc.language, from: 'the document' };
  } else {
    const detected = detectLanguage(subtitleText(source.parsed));
    language = detected ? { code: detected, from: 'detected from the text' } : { code: 'und', from: 'not detected; generic line-break rules' };
  }

  const doc = recutDocument(source, {
    language: language.code,
    profiles: cfg.profiles,
    glossary: cfg.glossary,
    pinnedSpeakers: cfg.speakers,
    maxKeyPerCue: cfg.styling.maxKeyPerCue,
    ruleset: cfg.ruleset,
    generator: deps.generator ?? GENERATOR,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  });

  if (source.kind === 'overtone') {
    log.info(`recut: ${flattenWords(doc).length} words with their word times, ${doc.speakers.length} speaker${doc.speakers.length === 1 ? '' : 's'}`);
  } else {
    const { parsed } = source;
    log.info(`recut: ${parsed.cues.length} ${parsed.format === 'srt' ? 'SubRip' : 'WebVTT'} cues, ${flattenWords(doc).length} words; word times estimated from the cue times`);
    log.info(`  speakers: ${doc.speakers.length}${parsed.speakerSource === 'none' ? '' : ` (from ${parsed.speakerSource})`}`);
    if (parsed.skipped > 0) log.warn(`${path}: skipped ${parsed.skipped} block${parsed.skipped === 1 ? '' : 's'} without a readable timing line or text`);
  }
  log.info(`  language: ${language.code} (${language.from})`);
  for (const p of doc.profiles) log.info(`  ${p.id}: ${p.cues.length} cues (lines cut by rule set ${cfg.ruleset.id})`);

  let formats = exports;
  const outDir = cfg.outDir ?? dirname(input);
  const base = baseName(input);
  if (formats.includes('json') && samePath(join(outDir, `${base}.overtone.json`), input)) {
    log.warn(`Not overwriting the input file ${input}; skipping the json output (use --out to write it elsewhere).`);
    formats = formats.filter((f) => f !== 'json');
  }
  const written = await writeOutputs(doc, { base, outDir, formats, profiles: cfg.profiles.map((p) => p.id), protect: [{ path: input, what: 'the input file' }] });
  for (const p of written) log.out(p);
  return 0;
}
