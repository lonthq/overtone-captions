import { Command } from 'commander';
import { DEFAULTS, LOCAL_PRESET, parseModelSpec, type CliFlags } from './config.js';
import { runBurn, type BurnFlags } from './commands/burn.js';
import { runExport, type ExportFlags } from './commands/export.js';
import { runInit, type InitFlags } from './commands/init.js';
import { runLanguages } from './commands/languages.js';
import { runProviders } from './commands/providers.js';
import { runRecut, type RecutFlags } from './commands/recut.js';
import { runTranscribe } from './commands/transcribe.js';
import { runValidate } from './commands/validate.js';
import { UserError } from './errors.js';
import { consoleLogger, type Logger } from './log.js';
import { explainNetworkError } from './providers/kit.js';
import { defaultSelectionId, resolveSelection } from './providers/registry.js';
import { isTimeout, networkFailure } from './util/retry.js';
import { VERSION } from './version.js';

/** "caused by: …" lines for the `cause` chain (stack traces leave it out), at most four deep. */
function causeLines(err: unknown): string {
  const lines: string[] = [];
  for (let cur = (err as { cause?: unknown } | null)?.cause, depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    lines.push(`caused by: ${cur instanceof Error ? `${cur.name}: ${cur.message}` : String(cur)}`);
    cur = (cur as { cause?: unknown }).cause;
  }
  return lines.map((l) => `\n${l}`).join('');
}

/**
 * Run a command body: UserErrors print as "error: …" with exit code 1; a failed connection prints its cause and host
 * without a stack; other errors keep their stack and `cause` chain.
 */
export async function guarded(log: Logger, body: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await body();
  } catch (err) {
    if (err instanceof UserError) log.error(err.message);
    else if (networkFailure(err) && !isTimeout(err)) {
      const message = (explainNetworkError(err) as Error).message;
      log.error(`${message}\nCheck the provider's endpoint or region variable and the network; "overtone providers" lists the variables.`);
    } else log.error(`${(err as Error).stack ?? String(err)}${causeLines(err)}`);
    process.exitCode = 1;
  }
}

/** The `overtone` command line. `opts.cwd` (default process.cwd()) is where .env, config, cache and relative paths resolve. */
export function buildProgram(log: Logger = consoleLogger, opts: { cwd?: string } = {}): Command {
  const program = new Command();
  program.name('overtone').description('Word-timed, context-aware captions in the Overtone format.').version(VERSION);

  program
    .command('transcribe')
    .description('Transcribe audio/video into an .overtone.json file (plus VTT/SRT/TXT)')
    .argument('<media>', 'audio or video file')
    .option('--text <provider:model>', `text provider (default ${defaultSelectionId('text')})`)
    .option('--timing <provider[:mode]>', `timing + diarization provider (default ${DEFAULTS.timing}), or "same" to take the timings from the text provider`)
    .option('--timing-second-opinion <provider>', 'second hearing of the whole file (times and text votes): auto (default: elevenlabs when ELEVENLABS_API_KEY is set), none, or a provider')
    .option('--llm <provider:model>', `LLM editor (default ${defaultSelectionId('llm')})`)
    .option('--local', `local providers only, no keys: --text ${LOCAL_PRESET.text} --timing ${LOCAL_PRESET.timing} --llm ${resolveSelection(parseModelSpec(LOCAL_PRESET.llm), 'llm').id} (explicit flags win; a cloud timingSecondOpinion from the config file is turned off, --timing-second-opinion is still used; English runs download a pronunciation dictionary once)`)
    .option('--context <text>', 'what the media is about')
    .option('--context-file <path>', 'file with the context text')
    .option('--no-infer-context', 'without --context: do not infer a context from the transcript (one short LLM call)')
    .option('--llm-linebreaks', 'also ask the LLM where captions and lines break (proposals checked by the rules); default off: the rules alone')
    .option('--no-llm-linebreaks', 'cut captions and lines by the rules only (the default; overrides "llmLinebreaks": true in the config file)')
    .option('--rules <id>', 'rule set for the caption layout: "latest" (default) or a pinned id such as "1"')
    .option('--text-file <path>', 'use this transcript (.srt, .vtt or .txt) as the text instead of a text provider; the timing provider times it')
    .option('--two-pass', 'transcribe again with the inferred context in the prompt (doubles the transcription cost)')
    .option('--no-two-pass', 'transcribe once (the default; overrides "twoPass": true in the config file)')
    .option('--glossary <path>', 'glossary file, one term per line')
    .option('--speakers <list>', 'pin speaker labels, e.g. "S1=Sarah,S2=Tom"')
    .option('--language <code>', 'spoken language, "auto", or candidate languages for mixed-language media, e.g. "en,es" (the first is the main language)')
    .option('--profiles <ids>', 'profiles to generate: names or aspects such as 1:1 (default horizontal,vertical, plus a profile for the video\'s own shape)')
    .option('--export <formats>', 'files to write: json,player,vtt,vtt-words,srt,txt,mp4 (default json,vtt); player = the JSON without authoring data, vtt-words = WebVTT with word timestamps, mp4 = the video with the captions burned in')
    .option('--burn-style <name|path>', 'with --export mp4: style pack name or a pack\'s style.css (default clean)')
    .option('--burn-speaker-names <when>', 'with --export mp4: never | change | always (default never)')
    .option('--burn-font <file>', 'with --export mp4: font file instead of the style\'s font')
    .option('--numbers <style>', 'digits | words | auto')
    .option('--currency <style>', 'symbol | code | words | auto')
    .option('--style-guide <text>', 'free-text style rules')
    .option('-o, --out <dir>', 'output folder (default: next to the input)')
    .option('--mark-uncertain', 'in VTT/SRT/TXT, mark "(??)" after words the text and timing models disagree on and no edit resolved')
    .option('--no-mark-uncertain', 'no "(??)" marks (the default; overrides "markUncertain": true in the config file)')
    .option('--normalize-loudness', 'loudness-normalize the audio (EBU R128, ffmpeg loudnorm) before any provider hears it')
    .option('--no-normalize-loudness', 'send the audio at its own loudness (the default; overrides "normalizeLoudness": true in the config file)')
    .option('--from-stage <stage>', 'send the provider requests of this stage and later ones again: extract, transcribe, timing, align, refine, export')
    .option('--no-cache', 'send every provider request again (ignore cached answers)')
    .option('--config <path>', 'config file (default ./overtone.config.json)')
    .option('--dry-run', 'print what the run would do (providers, where the audio goes, missing keys, outputs, estimated cost) and stop: no provider request, extraction, cache or output; exit code 1 when it could not run')
    .action(async (media: string, flags: CliFlags) => guarded(log, () => runTranscribe(media, flags, log, { cwd: opts.cwd })));

  program
    .command('recut')
    .description('Re-cut existing subtitles (.srt, .vtt) or an .overtone.json file into the profiles; offline, no API keys')
    .argument('<file>', 'SubRip, WebVTT or .overtone.json file')
    .option('--profiles <ids>', 'profiles to generate: names or aspects such as 1:1 (default horizontal,vertical)')
    .option('--export <formats>', 'files to write: json,player,vtt,vtt-words,srt,txt (default json,vtt,srt,txt)')
    .option('-o, --out <dir>', 'output folder (default: next to the input)')
    .option('--language <code>', 'language of the text, for the line-break rules (default: the document\'s, or detected)')
    .option('--speakers <list>', 'speaker labels, e.g. "S1=Sarah,S2=Tom"')
    .option('--glossary <path>', 'glossary file, one term per line (terms are never split across lines)')
    .option('--rules <id>', 'rule set for the caption layout: "latest" (default) or a pinned id such as "1"')
    .option('--config <path>', 'config file (default ./overtone.config.json)')
    .action(async (file: string, flags: RecutFlags) => guarded(log, () => runRecut(file, flags, log, opts.cwd)));

  program
    .command('validate')
    .description('Check an .overtone.json file against the format rules')
    .argument('<file>', '.overtone.json file')
    .action(async (file: string) => guarded(log, () => runValidate(file, log, opts.cwd)));

  program
    .command('export')
    .description('Write VTT/SRT/TXT/JSON files from an .overtone.json file')
    .argument('<file>', '.overtone.json file')
    .option('--export <formats>', 'comma-separated: json,player,vtt,vtt-words,srt,txt', 'vtt,srt,txt')
    .option('--profiles <ids>', 'profiles for VTT/SRT (default: all in the file)')
    .option('-o, --out <dir>', 'output folder (default: next to the input)')
    .option('--mark-uncertain', 'mark "(??)" after words the text and timing models disagree on and no edit resolved')
    .action(async (file: string, flags: ExportFlags) => guarded(log, () => runExport(file, flags, log, opts.cwd)));

  program
    .command('burn')
    .description('Write an MP4 with the captions burned in, drawn like the video.js player (needs ffmpeg and Chrome)')
    .argument('<media>', 'video file')
    .argument('<document>', '.overtone.json file')
    .option('--style <name|path>', 'built-in style pack (clean, high-contrast, lumora, minimal, social) or a pack\'s style.css (default clean)')
    .option('--profile <id>', 'caption profile (default: the one closest to the video\'s shape)')
    .option('--mode <mode>', 'styled | plain (default styled)')
    .option('--speaker-names <when>', 'never | change | always (default never)')
    .option('--font <file>', 'font file (.woff2, .woff, .ttf, .otf) instead of the style\'s font')
    .option('-o, --out <file|dir>', 'output MP4 file, or a folder for <media name>.captioned.mp4 (default: next to the media)')
    .action(async (media: string, document: string, flags: BurnFlags) => guarded(log, () => runBurn(media, document, flags, log, opts.cwd)));

  program
    .command('init')
    .description('Write overtone.config.json here with today\'s defaults pinned: the rule set, the default models and the built-in profile rules')
    .option('--force', 'overwrite an existing overtone.config.json')
    .action(async (flags: InitFlags) => guarded(log, () => runInit(flags, log, opts.cwd)));

  program
    .command('languages')
    .description('List the language packs and their coverage, or show every field of one pack')
    .argument('[code]', 'language code, e.g. nl')
    .action(async (code: string | undefined) => guarded(log, async () => runLanguages(code, log)));

  program
    .command('providers')
    .description('List the providers, their roles, default models and environment variables')
    .argument('[id]', 'provider id, e.g. whisper-cpp')
    .action(async (id: string | undefined) => guarded(log, async () => runProviders(id, log)));

  return program;
}
