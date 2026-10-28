// `overtone transcribe --dry-run`: what a run would do, settled the way preflight settles it, without any provider
// request, audio extraction, cache folder or output file. Local tools (whisper.cpp, Ollama) are not checked.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { languageDefaultsFor, type ModelSpec, type ResolvedProfile } from '../config.js';
import { UserError } from '../errors.js';
import { missingBinaries, probeMedia } from '../media/extract.js';
import { probeVideo, type VideoInfo } from '../media/video.js';
import { assertNoInputOverwrite, baseName, plannedOutputs, type PlannedOutput } from '../output.js';
import { AUTO_SECOND_OPINION, defaultSelectionId, getProvider, missingEnv, missingEnvError, resolveSelection } from '../providers/registry.js';
import { mediaProfile } from '../segment/aspect.js';
import { LATEST_RULESET } from '../segment/rulesets/index.js';
import { clock, MAX_DURATION_SECONDS, tooLong } from './duration.js';
import { forcedLanguages, runInputs, selectProviders } from './preflight.js';
import type { PipelineConfig, PipelineDeps } from './types.js';

/**
 * Where a provider sends what it gets, named without any environment value. `when` is set for a destination used only
 * for some detected languages ("the language is nl"): a per-language editor (`languages.<code>.llm`).
 */
export interface Destination { name: string; cloud: boolean; when?: string }

export interface RunPlan {
  media: string;
  /** Seconds; undefined when ffprobe is missing or reports no duration. */
  duration?: number;
  /** Why there is no duration ("ffprobe not found on PATH"). */
  durationNote?: string;
  video?: VideoInfo;
  configFile?: string;
  envFile?: string;
  text: string;
  timing: string;
  second: string;
  llm: string;
  language: string;
  languageOverrides: string[];
  context: string;
  audioTo: Destination[];
  transcriptTo: Destination[];
  missing: string[];
  /** Local tools a real run checks first (whisper.cpp binary and model, Ollama server); the dry run does not. */
  unchecked: string[];
  outputs: PlannedOutput[];
  profiles: ResolvedProfile[];
  /** The profile added for the media's own shape, if any. */
  mediaProfileId?: string;
  cacheDir: string;
  useCache: boolean;
  cost: string;
  /** What stops the real run (missing keys, ffmpeg, too long); empty when it can run. */
  problems: string[];
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLocalUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
};

/** The service a provider sends its input to. Only variable names are printed, never their values. */
export function destination(provider: string, env: NodeJS.ProcessEnv): Destination {
  const set = (name: string) => env[name]?.trim() || undefined;
  const custom = (name: string, fallback: Destination): Destination => {
    const url = set(name);
    return url ? { name: `the server in ${name}`, cloud: !isLocalUrl(url) } : fallback;
  };
  switch (provider) {
    case 'openai': return custom('OPENAI_BASE_URL', { name: 'OpenAI (api.openai.com)', cloud: true });
    case 'azure-openai': return { name: 'your Azure OpenAI resource (AZURE_OPENAI_ENDPOINT)', cloud: true };
    case 'anthropic': return custom('ANTHROPIC_BASE_URL', { name: 'Anthropic (api.anthropic.com)', cloud: true });
    case 'azure-speech': return set('AZURE_SPEECH_ENDPOINT')
      ? { name: 'Azure AI Speech (AZURE_SPEECH_ENDPOINT)', cloud: true }
      : { name: 'Azure AI Speech (the region in AZURE_SPEECH_REGION)', cloud: true };
    case 'elevenlabs': return custom('ELEVENLABS_BASE_URL', { name: 'ElevenLabs (api.elevenlabs.io)', cloud: true });
    case 'ollama': return custom('OLLAMA_BASE_URL', { name: 'Ollama on this machine (localhost:11434)', cloud: false });
    case 'whisper-cpp': return { name: 'whisper.cpp on this machine', cloud: false };
    case 'recorded': return { name: 'recorded responses (no network)', cloud: false };
    default: return { name: `${provider} (${getProvider(provider)?.description ?? 'unknown provider'})`, cloud: true };
  }
}

const LOCAL_TOOLS: Record<string, string> = { 'whisper-cpp': 'whisper.cpp binary and model file', ollama: 'Ollama server and model' };

/** Measured list-price ranges per audio minute (bench/RESULTS.md; bench/PRICES.md). */
export const MEASURED_COST = { default: [0.020, 0.026], withElevenLabs: [0.025, 0.039] } as const;

/** 0.0123 → "0.012", 1.234 → "1.23". */
const money = (n: number) => n.toFixed(n < 0.1 ? 3 : 2);

const NO_ESTIMATE = 'no measured estimate for this combination of providers';

function costEstimate(sel: { text: ModelSpec; timing: ModelSpec; llm: ModelSpec }, second: ModelSpec | undefined, cfg: PipelineConfig, all: Destination[], duration: number | undefined): string {
  // A cloud editor for some detected languages only (languages.<code>.llm): the cost depends on that language.
  const conditional = all.filter((d) => d.when !== undefined && d.cloud);
  const ifCloud = conditional.map((d) => `${d.name} if ${d.when}`).join('; ');
  const always = all.filter((d) => d.when === undefined);
  if (always.every((d) => !d.cloud)) {
    return conditional.length === 0 ? '$0 (local providers only)' : `depends on the detected language: $0 with the local providers, plus the cloud editor ${ifCloud}`;
  }
  const base = measuredEstimate(sel, second, cfg, duration);
  // a measured figure holds for the main editor only; "no measured estimate" needs no addition
  return conditional.length === 0 || base === NO_ESTIMATE ? base : `${base}; depends on the detected language: the editor is ${ifCloud} (not in this estimate)`;
}

function measuredEstimate(sel: { text: ModelSpec; timing: ModelSpec; llm: ModelSpec }, second: ModelSpec | undefined, cfg: PipelineConfig, duration: number | undefined): string {
  // the default models, from OpenAI or from Azure OpenAI deployments named after them (the measurements ran there)
  const deployment = (s: ModelSpec, role: 'text' | 'llm') => s.provider === 'azure-openai' && `openai:${s.model}` === defaultSelectionId(role);
  const textOk = sel.text.id === defaultSelectionId('text') || deployment(sel.text, 'text');
  const llmOk = sel.llm.id === defaultSelectionId('llm') || deployment(sel.llm, 'llm');
  const measured = !cfg.textFile && !cfg.twoPass && textOk && sel.timing.provider === 'azure-speech' && !sel.timing.same
    && llmOk && (!second || second.provider === AUTO_SECOND_OPINION.provider);
  if (!measured) return NO_ESTIMATE;
  const assumed = deployment(sel.text, 'text') || deployment(sel.llm, 'llm') ? ', assuming the Azure deployments run the models they are named after' : '';
  const [lo, hi] = second ? MEASURED_COST.withElevenLabs : MEASURED_COST.default;
  const total = duration !== undefined
    ? `, about $${money((lo * duration) / 60)}–${money((hi * duration) / 60)} for this media`
    : '';
  return `$${lo.toFixed(3)}–${hi.toFixed(3)} per audio minute${total} (estimate at list prices, measured on the default setup${second ? ' with ElevenLabs' : ''}${assumed})`;
}

/** What `runPipeline` would do with this media and configuration. Throws the UserErrors preflight throws for bad input. */
export async function planRun(
  media: string,
  cfg: PipelineConfig,
  deps: Pick<PipelineDeps, 'log' | 'cwd' | 'checkBinaries' | 'probeDuration' | 'probeVideo'>,
  env: NodeJS.ProcessEnv,
  files: { configFile?: string; envFile?: string } = {},
): Promise<RunPlan> {
  const info = await stat(media).catch(() => undefined);
  if (!info) throw new UserError(`Media file not found: ${media}`);
  if (!info.isFile()) throw new UserError(`Media file is not a regular file: ${media}`);
  const problems: string[] = [];

  // languages, as preflight settles them
  const { forced, candidates } = forcedLanguages(cfg);
  const upfront = languageDefaultsFor(cfg, forced);

  // the providers: the same selection as the run (per-language text and LLM, --text-file, the second hearing)
  const { textFile, sel, secondSel } = await selectProviders(cfg, upfront, deps as PipelineDeps, env);
  const describe = (s: ModelSpec, role: 'text' | 'timing' | 'llm') => {
    const d = destination(s.provider, env);
    return `${s.id} (${d.cloud ? 'cloud' : 'local'}: ${d.name})${role === 'llm' && !cfg.explicit.llm && upfront?.llm ? ` (languages.${forced}.llm)` : ''}${role === 'text' && !cfg.explicit.text && upfront?.text && !textFile ? ` (languages.${forced}.text)` : ''}`;
  };
  const text = textFile ? `${cfg.textFile} (--text-file; no text provider is called)` : describe(sel.text, 'text');
  const timing = sel.timing.same ? `same as text (${sel.text.id} gives the word timings)` : describe(sel.timing, 'timing');
  let second: string;
  if (secondSel) second = `${describe(secondSel, 'timing')}${cfg.timingSecondOpinion === 'auto' ? ` (auto: ${AUTO_SECOND_OPINION.key} is set)` : ''}`;
  else if (cfg.timingSecondOpinion === false) second = 'none';
  else if (cfg.timingSecondOpinion === 'auto') {
    second = !env[AUTO_SECOND_OPINION.key]?.trim()
      ? `none (auto: ${AUTO_SECOND_OPINION.key} is not set)`
      : `none (auto: ${AUTO_SECOND_OPINION.provider} already gives the ${sel.text.provider === AUTO_SECOND_OPINION.provider ? 'text' : 'timings'})`;
  } else second = 'none';

  const language = candidates ? `${candidates.join(', ')} (given; main language ${candidates[0]})` : forced ? `${forced} (given)` : 'detected during the run';
  const languageOverrides: string[] = [];
  // Editors for some detected languages only: `languages.<code>.llm` applies after detection when no language is
  // given (`languages.<code>.text` does not: the text model runs before detection, editor.ts).
  const byLanguage = new Map<string, { dest: Destination; codes: string[] }>();
  if (!forced) {
    for (const [code, d] of Object.entries(cfg.languageDefaults)) {
      if (!d.llm || cfg.explicit.llm) continue;
      const want = resolveSelection(d.llm, 'llm');
      if (want.id === sel.llm.id) continue;
      const miss = missingEnv([want], env);
      const dest = destination(want.provider, env);
      byLanguage.set(dest.name, { dest, codes: [...(byLanguage.get(dest.name)?.codes ?? []), code] });
      languageOverrides.push(`languages.${code}.llm: ${want.id} (${destination(want.provider, env).name}), if the detected language is ${code}${miss.length > 0 ? `; missing ${miss.join(', ')}` : ''}`);
    }
  }
  const context = cfg.context ? 'given' : cfg.inferContext ? 'inferred from the transcript (one LLM request)' : 'none (--no-infer-context)';

  // where the audio and the transcript go
  const uniq = (list: Destination[]) => [...new Map(list.map((d) => [d.name, d])).values()];
  const audioTo = uniq([
    ...(textFile ? [] : [destination(sel.text.provider, env)]),
    ...(sel.timing.same ? [] : [destination(sel.timing.provider, env)]),
    ...(secondSel ? [destination(secondSel.provider, env)] : []),
  ]);
  const mainEditor = destination(sel.llm.provider, env);
  const transcriptTo = uniq([
    mainEditor,
    ...[...byLanguage.values()].filter(({ dest }) => dest.name !== mainEditor.name)
      .map(({ dest, codes }) => ({ ...dest, when: `the language is ${codes.join(' or ')}` })),
  ]);

  // keys, exactly as preflight checks them; local tools are not checked (no server request, no binary run)
  const missing = missingEnv([...(textFile ? [sel.timing, sel.llm] : [sel.text, sel.timing, sel.llm]), ...(secondSel ? [secondSel] : [])], env);
  const used = [...(textFile ? [] : [sel.text]), ...(sel.timing.same ? [] : [sel.timing]), sel.llm, ...(secondSel ? [secondSel] : [])];
  const unchecked = [...new Set(used.map((s) => LOCAL_TOOLS[s.provider]).filter((t): t is string => t !== undefined))];

  // ffmpeg and the media: duration (the 2-hour limit) and the video's shape (the media profile)
  const bins = await (deps.checkBinaries ?? missingBinaries)();
  if (bins.length > 0) problems.push(`${bins.join(' and ')} not found on PATH; install ffmpeg (https://ffmpeg.org/download.html).`);
  let duration: number | undefined;
  let durationNote: string | undefined;
  let video: VideoInfo | undefined;
  // 'none': the probe ran and found no video stream; 'unknown': no probe (no ffprobe) or the probe failed
  let videoState: 'found' | 'none' | 'unknown' = 'unknown';
  if (bins.includes('ffprobe') && !deps.probeDuration) durationNote = 'unknown (ffprobe not found on PATH)';
  else {
    duration = await (deps.probeDuration ?? probeMedia)(media);
    if (duration === undefined) durationNote = 'unknown (ffprobe reports none; checked after extraction)';
    else if (duration > MAX_DURATION_SECONDS) problems.push(tooLong(duration).message);
    let failed = false;
    video = await (deps.probeVideo ?? probeVideo)(media).catch(() => {
      failed = true;
      return undefined;
    });
    videoState = video ? 'found' : failed ? 'unknown' : 'none';
  }

  let profiles = cfg.profiles;
  let mediaProfileId: string | undefined;
  if (video && !cfg.profilesExplicit) {
    const extra = mediaProfile(profiles, video, cfg.ruleset ?? LATEST_RULESET);
    if (extra) {
      profiles = [...profiles, extra];
      mediaProfileId = extra.id;
    }
  }
  const outputs = plannedOutputs({ base: baseName(media), outDir: cfg.outDir ?? dirname(media), formats: cfg.exports, profiles: profiles.map((p) => p.id) });
  assertNoInputOverwrite(outputs, runInputs(media, cfg));
  if (cfg.exports.includes('mp4')) {
    // as preflight refuses it (probeInput); a failed or skipped probe leaves the video stream unchecked
    if (videoState === 'none') problems.push(`${media} has no video stream; --export mp4 needs a video.`);
    else if (videoState === 'unknown') unchecked.push('the video stream for --export mp4');
    unchecked.push('Chrome and ffmpeg 5.0+ for --export mp4');
  }

  if (missing.length > 0) problems.unshift(missingEnvError(missing).message);
  const cost = costEstimate(sel, secondSel, cfg, [...audioTo, ...transcriptTo], duration);
  return {
    media, duration, durationNote, video, ...files, text, timing, second, llm: describe(sel.llm, 'llm'), language, languageOverrides, context,
    audioTo, transcriptTo, missing, unchecked, outputs, profiles, mediaProfileId, cacheDir: cfg.cacheDir, useCache: cfg.useCache, cost, problems,
  };
}

/** The plan as plain "key: value" lines (stdout), stable for agents to read. */
export function formatPlan(p: RunPlan): string[] {
  const where = (list: Destination[]) => list.map((d) => `${d.name} [${d.cloud ? 'cloud' : 'local'}]${d.when ? ` (if ${d.when})` : ''}`).join(', ') || 'nowhere';
  const lines = [
    'dry run: nothing was extracted, sent, cached or written',
    `media: ${p.media}`,
    `duration: ${p.duration !== undefined ? `${clock(p.duration)} (${p.duration.toFixed(1)} s)` : p.durationNote}`,
    ...(p.video ? [`video: ${p.video.width}x${p.video.height}`] : p.duration !== undefined ? ['video: none (audio only)'] : []),
    `config file: ${p.configFile ?? 'none'}`,
    `.env: ${p.envFile ? `found (${p.envFile})` : 'not found'}`,
    `text: ${p.text}`,
    `timing: ${p.timing}`,
    `second hearing: ${p.second}`,
    `llm: ${p.llm}`,
    ...p.languageOverrides.map((o) => `per-language: ${o}`),
    `language: ${p.language}`,
    `context: ${p.context}`,
    `audio goes to: ${where(p.audioTo)}`,
    `transcript goes to: ${where(p.transcriptTo)}`,
    `missing environment variables: ${p.missing.length > 0 ? p.missing.join(', ') : 'none'}`,
    ...(p.unchecked.length > 0 ? [`not checked: ${p.unchecked.join(', ')} (the run checks them before extracting)`] : []),
    `profiles: ${p.profiles.map((x) => x.id).join(', ')}${p.mediaProfileId ? ` (${p.mediaProfileId} added for the media's shape)` : ''}`,
    'outputs:',
    ...p.outputs.map((o) => `  ${o.path}`),
    `cache: ${p.cacheDir}${p.useCache ? '' : ' (--no-cache: cached answers are not reused)'}`,
    `estimated cost: ${p.cost}`,
    `runnable: ${p.problems.length === 0 ? 'yes' : 'no'}`,
  ];
  return lines;
}

/** `<cwd>/.env` when it exists (its values are never read here). */
export function envFilePath(cwd: string): string | undefined {
  const path = resolve(cwd, '.env');
  return existsSync(path) ? path : undefined;
}

/** The config file `loadConfigFile` reads: `--config <path>` or `<cwd>/overtone.config.json`, when it exists. */
export function configFilePath(path: string | undefined, cwd: string): string | undefined {
  const file = resolve(cwd, path ?? 'overtone.config.json');
  return existsSync(file) ? file : undefined;
}
