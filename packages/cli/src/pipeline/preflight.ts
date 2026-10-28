// Preflight: every check that needs no API call, run before anything is extracted or sent, and the plan it settles
// (languages, providers, the video stream, the profiles).
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fontCss, loadStyle } from '../burn/assets.js';
import { findChrome } from '../burn/chrome.js';
import { checkFfmpegVersion, ffmpegVersion } from '../burn/encode.js';
import { LOCAL_PRESET, languageDefaultsFor, parseModelSpec, type ModelSpec, type ResolvedLanguageDefaults, type ResolvedProfile } from '../config.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { assertNoInputOverwrite, baseName, plannedOutputs, type InputFile } from '../output.js';
import { missingBinaries, probeMedia } from '../media/extract.js';
import { probeVideo, type VideoInfo } from '../media/video.js';
import { readTranscriptFile, textFileId, type TextFile } from '../providers/file.js';
import { missingEnv, missingEnvError, preflight as providerPreflight, resolveSelection, resolveSelections, secondOpinionSelection, type Selections } from '../providers/registry.js';
import { mediaProfile } from '../segment/aspect.js';
import { LATEST_RULESET } from '../segment/rulesets/index.js';
import { canonicalLanguage } from '../text/detect.js';
import { MAX_DURATION_SECONDS, tooLong } from './duration.js';
import type { PipelineConfig, PipelineDeps } from './types.js';

export interface Plan {
  /** --language as a canonical code. */
  forced?: string;
  /** --language en,es: candidates, the first is the main one (document language, language pack). */
  candidates?: string[];
  /** The forced language's per-language defaults. */
  upfront?: ResolvedLanguageDefaults;
  /** --text-file: the file's text instead of a text provider. */
  textFile?: TextFile;
  sel: Selections;
  /** The whole-file second hearing (--timing-second-opinion): times and text votes. */
  secondSel?: ModelSpec;
  video?: VideoInfo;
  wantsMp4: boolean;
  /** The configured profiles, plus one for the media's own shape when none has its rules. */
  profiles: ResolvedProfile[];
}

/** The provider of LOCAL_PRESET's editor. */
const LOCAL_LLM = parseModelSpec(LOCAL_PRESET.llm).provider;

/**
 * The warning for a local editor: the editor and the vote's chooser are trusted to judge the words, and small local
 * models are not good at that. Undefined for any other editor.
 */
export function localEditorWarning(llm: { provider: string; id: string }): string | undefined {
  if (llm.provider !== LOCAL_LLM) return undefined;
  return `the editor is a local model (${llm.id}). Overtone applies the editor's corrections and the vote's choices without second-guessing them, and small models propose many wrong ones. For captions you publish, use a cloud editor (--llm azure-openai, openai or anthropic) and check the review list.`;
}

/** The checks in order: the media file, languages, providers, ffmpeg, keys and local tools, duration, video. */
export async function preflight(media: string, cfg: PipelineConfig, deps: PipelineDeps, env: NodeJS.ProcessEnv): Promise<Plan> {
  const { log } = deps;
  await checkMediaFile(media);
  const { forced, candidates } = forcedLanguages(cfg);
  // per-language defaults: the text provider only for a language given up front; the LLM and effort once it is known
  const upfront = languageDefaultsFor(cfg, forced);
  const { textFile, sel, secondSel } = await selectProviders(cfg, upfront, deps, env);
  if (cfg.twoPass && (cfg.context || !cfg.inferContext)) log.warn('--two-pass has no effect with a given context or without context inference');
  else if (cfg.twoPass) log.warn('--two-pass: every chunk is transcribed twice, which doubles the transcription cost');
  const editor = localEditorWarning(sel.llm);
  if (editor) log.warn(editor);
  await checkTools(sel, secondSel, textFile !== undefined, deps, env);
  const video = await probeInput(media, cfg, deps, env);
  const profiles = withMediaProfile(cfg, video, log);
  checkOutputs(media, cfg, profiles);
  return { forced, candidates, upfront, textFile, sel, secondSel, video, wantsMp4: cfg.exports.includes('mp4'), profiles };
}

/** The run's input files, which no output may overwrite: the media, the --text-file, the context and glossary files. */
export function runInputs(media: string, cfg: Pick<PipelineConfig, 'textFile' | 'contextFile' | 'glossaryFile'>): InputFile[] {
  return [
    { path: media, what: 'the media file' },
    ...(cfg.textFile ? [{ path: cfg.textFile, what: 'the --text-file' }] : []),
    ...(cfg.contextFile ? [{ path: cfg.contextFile, what: 'the context file' }] : []),
    ...(cfg.glossaryFile ? [{ path: cfg.glossaryFile, what: 'the glossary file' }] : []),
  ];
}

/** No output may overwrite an input (`--text-file talk.txt --export txt` writes talk.txt); refused before any paid call. */
function checkOutputs(media: string, cfg: PipelineConfig, profiles: readonly ResolvedProfile[]): void {
  const outputs = plannedOutputs({ base: baseName(media), outDir: cfg.outDir ?? dirname(media), formats: cfg.exports, profiles: profiles.map((p) => p.id) });
  assertNoInputOverwrite(outputs, runInputs(media, cfg));
}

async function checkMediaFile(media: string): Promise<void> {
  const info = await stat(media).catch(() => undefined);
  if (!info) throw new UserError(`Media file not found: ${media}`);
  if (info.isDirectory()) throw new UserError(`Media file is a directory: ${media}`);
  if (!info.isFile()) throw new UserError(`Media file is not a regular file: ${media}`);
}

/** --language and its candidates as canonical codes (exported for the dry run). */
export function forcedLanguages(cfg: PipelineConfig): Pick<Plan, 'forced' | 'candidates'> {
  const invalidLanguage = (l: string) => new UserError(`Invalid language "${l}"; expected a code such as en, nl or nl-BE, a name such as dutch, or "auto".`);
  const forced = cfg.language === undefined ? undefined : canonicalLanguage(cfg.language);
  if (cfg.language !== undefined && !forced) throw invalidLanguage(cfg.language);
  const candidates = cfg.languageCandidates
    ? [...new Set(cfg.languageCandidates.map((l) => canonicalLanguage(l) ?? (() => { throw invalidLanguage(l); })()))]
    : undefined;
  return { forced, candidates };
}

/** The run's text, timing and LLM providers and its second hearing (exported for tests). */
export async function selectProviders(cfg: PipelineConfig, upfront: ResolvedLanguageDefaults | undefined, deps: PipelineDeps, env: NodeJS.ProcessEnv): Promise<Pick<Plan, 'textFile' | 'sel' | 'secondSel'>> {
  const llmSpec = !cfg.explicit.llm && upfront?.llm ? upfront.llm : cfg.llm;
  // --text-file: the file's text replaces the text provider; the timing provider times it
  const textFile = cfg.textFile ? await readTranscriptFile(cfg.textFile, cfg.textFile, (m) => deps.log.warn(m)) : undefined;
  let sel: Selections;
  if (textFile) {
    if (cfg.timing.provider === 'same') {
      throw new UserError('--timing same cannot be used with --text-file: the file has no word timings. Choose a timing provider with --timing, such as azure-speech, elevenlabs or whisper-cpp (offline).');
    }
    sel = { text: { provider: 'file', model: basename(textFile.path), id: textFileId(textFile) }, timing: resolveSelection(cfg.timing, 'timing'), llm: resolveSelection(llmSpec, 'llm') };
  } else {
    sel = resolveSelections({ text: !cfg.explicit.text && upfront?.text ? upfront.text : cfg.text, timing: cfg.timing, llm: llmSpec });
  }
  const secondSel = deps.providers
    ? (deps.providers.secondTiming ? { provider: deps.providers.secondTiming.id, id: deps.providers.secondTiming.id } : undefined)
    : secondOpinionSelection(cfg.timingSecondOpinion, sel.timing, env, sel.text);
  return { textFile, sel, secondSel };
}

/** ffmpeg, the providers' keys, and local binaries, model files and servers (whisper.cpp, Ollama). */
async function checkTools(sel: Selections, secondSel: ModelSpec | undefined, textFile: boolean, deps: PipelineDeps, env: NodeJS.ProcessEnv): Promise<void> {
  const { log } = deps;
  // the file's text needs no keys or checks; the other roles as usual
  const called = textFile ? { ...sel, text: { ...sel.text, same: true } } : sel;
  const bins = await (deps.checkBinaries ?? missingBinaries)();
  if (bins.length > 0) throw new UserError(`${bins.join(' and ')} not found on PATH; install ffmpeg (https://ffmpeg.org/download.html).`);
  if (deps.providers) return;
  const missing = missingEnv([...(textFile ? [sel.timing, sel.llm] : [sel.text, sel.timing, sel.llm]), ...(secondSel ? [secondSel] : [])], env);
  if (missing.length > 0) throw missingEnvError(missing);
  // local binaries, model files and servers: fail before extracting anything
  await providerPreflight(called, env, { cwd: deps.cwd, log, deps: deps.providerDeps });
  if (secondSel) await providerPreflight({ text: { ...sel.text, same: true }, timing: secondSel, llm: { ...sel.llm, same: true } }, env, { cwd: deps.cwd, log, deps: deps.providerDeps });
}

/** The duration limit, the video stream, and for `--export mp4` Chrome, the ffmpeg version, the style and the font. */
async function probeInput(media: string, cfg: PipelineConfig, deps: PipelineDeps, env: NodeJS.ProcessEnv): Promise<VideoInfo | undefined> {
  // The 2-hour limit, checked before extracting (a 10 h file would first become a ~1 GB WAV). Containers without a
  // reliable duration (streamed WebM) are checked after extraction; an unreadable file fails here, before the cache
  // folder exists.
  const probed = await (deps.probeDuration ?? probeMedia)(media);
  if (probed !== undefined && probed > MAX_DURATION_SECONDS) throw tooLong(probed);

  // Unreadable files were rejected above, so a failing video probe only means no media profile. The error is kept so
  // `--export mp4` rethrows it instead of reporting "no video stream".
  let videoError: unknown;
  const video = await (deps.probeVideo ?? probeVideo)(media).catch((err: unknown) => {
    videoError = err;
    deps.log.debug(`video probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  if (cfg.exports.includes('mp4')) {
    if (videoError !== undefined) {
      throw new UserError(`Cannot read ${media} as a video for --export mp4 (${videoError instanceof Error ? videoError.message : String(videoError)}).`);
    }
    if (!video) throw new UserError(`${media} has no video stream; --export mp4 needs a video.`);
    if (!deps.burn) findChrome(env);
    // an ffmpeg that cannot read the caption list, a bad style or font: fail before any paid call
    checkFfmpegVersion(await (deps.ffmpegVersion ?? ffmpegVersion)());
    if (cfg.burn.style !== undefined) await loadStyle(cfg.burn.style, deps.cwd);
    if (cfg.burn.font !== undefined) await fontCss(cfg.burn.font, deps.cwd);
  }
  return video;
}

/** Adds a profile for the media's own shape (a 1:1 video: "1x1") when none has its rules, unless profiles were chosen explicitly. */
function withMediaProfile(cfg: PipelineConfig, video: VideoInfo | undefined, log: Logger): ResolvedProfile[] {
  let profiles = cfg.profiles;
  if (video && !cfg.profilesExplicit) {
    const extra = mediaProfile(profiles, video, cfg.ruleset ?? LATEST_RULESET);
    if (extra) {
      profiles = [...profiles, extra];
      log.info(`  media is ${extra.aspect}: adding profile ${extra.id} (${extra.rules.maxCharsPerLine} characters per line)`);
    }
  }
  return profiles;
}
