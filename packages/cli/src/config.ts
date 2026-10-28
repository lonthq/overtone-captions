import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { ASPECT_PATTERN, CURRENCY_STYLES, NUMBER_STYLES, PROFILE_ID_PATTERN, type ProfileRules, type StyleSettings, type TimeWindow } from 'overtone-format';
import { UserError, fsCode } from './errors.js';
import { consoleLogger } from './log.js';
import { EFFORTS, type Effort } from './providers/types.js';
import { aspectId, reduceAspect, rulesFor, tokenAspect as aspectOf } from './segment/aspect.js';
import { resolveRuleSet, type RuleSet } from './segment/rulesets/index.js';
import { canonicalLanguage } from './text/detect.js';
import { levenshtein } from './text/similarity.js';

export const STAGES = ['extract', 'transcribe', 'timing', 'align', 'refine', 'export'] as const;
export type Stage = (typeof STAGES)[number];

/** `player`: the document without authoring data; `vtt-words`: WebVTT with a timestamp tag per word. */
export const EXPORT_FORMATS = ['json', 'player', 'vtt', 'vtt-words', 'srt', 'txt', 'mp4'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A `provider[:model]` selection, e.g. `openai:gpt-transcribe`, `azure-speech`, `azure-openai:my-deployment`. */
export interface ModelSpec {
  provider: string;
  model?: string;
  id: string;
  /** `--timing same`: the text provider's own word times serve the timing role (no second call). */
  same?: boolean;
}

/** Split on the first ':' only, so model names may contain ':' (Ollama tags). The provider is lowercased; the model keeps its case. */
export function parseModelSpec(value: string): ModelSpec {
  const v = value.trim();
  if (!v) throw new UserError('Empty provider selection; expected "provider" or "provider:model".');
  const at = v.indexOf(':');
  const provider = (at < 0 ? v : v.slice(0, at)).trim().toLowerCase();
  if (!provider) throw new UserError(`Missing provider in "${v}"; expected "provider" or "provider:model".`);
  const model = at < 0 ? undefined : v.slice(at + 1).trim() || undefined;
  return { provider, model, id: model ? `${provider}:${model}` : provider };
}

export const DEFAULTS = {
  text: 'openai',
  timing: 'azure-speech',
  llm: 'openai',
  exports: ['json', 'vtt'] as ExportFormat[],
  profiles: ['horizontal', 'vertical'],
  cacheDir: '.overtone',
  /** OpenAI's upload limit is 25 MB; keep a margin. */
  chunkMb: 24,
  /**
   * Accepted `chunkMb` range. Max: the 25 MB upload limit. Min: keeps the request count sane (the audio is
   * 48 kbit/s, so 1 MB is about 2.5 minutes).
   */
  chunkMbRange: { min: 1, max: 25 },
  edits: { maxSpan: 6 },
  /** "latest" or a pinned id such as "1". */
  rules: 'latest',
  /** --llm-linebreaks. Off: the rule-based layout alone, with balanced lines and the same output on every run. */
  llmLinebreaks: false,
  /** Corrections are quality-critical; styling and line cutting need little reasoning, and code repairs the line cutting. */
  effort: { corrections: 'medium', styling: 'low', linebreaks: 'low' } as EffortConfig,
} as const;

/** Reasoning effort per refine step (LlmRequest.effort). */
export interface EffortConfig { corrections: Effort; styling: Effort; linebreaks: Effort }
const EFFORT_STEPS = ['corrections', 'styling', 'linebreaks'] as const;

/** `languages.<code>` in overtone.config.json: settings used when the media is in that language. */
export interface LanguageDefaults {
  /** Used only when the language is given up front (--language or `language`). */
  text?: string;
  /** Used once the language is known (given, or detected after the transcribe stage). */
  llm?: string;
  effort?: Partial<EffortConfig>;
}
export interface ResolvedLanguageDefaults { text?: ModelSpec; llm?: ModelSpec; effort?: Partial<EffortConfig> }

/**
 * `--local`: no keys, no paid calls. whisper.cpp (large-v3-turbo) hears the words and their times in one call; Ollama
 * (default qwen3:8b) edits. Explicit flags still win; text from elsewhere is timed by whisper.cpp.
 */
export const LOCAL_PRESET = { text: 'whisper-cpp:large-v3-turbo', timing: 'same', llm: 'ollama' } as const;
/** Providers that run on this machine. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([parseModelSpec(LOCAL_PRESET.text).provider, parseModelSpec(LOCAL_PRESET.llm).provider]);


export interface ProfileOverride { description?: string; aspect?: string; rules?: Partial<ProfileRules>; window?: TimeWindow }

/** Shape of `overtone.config.json`. Paths are relative to the config file. */
export interface FileConfig {
  /** Use LOCAL_PRESET for every role that `text`/`timing`/`llm` leave unset. */
  local?: boolean;
  text?: string;
  timing?: string;
  /** The second hearing: "auto" (elevenlabs when ELEVENLABS_API_KEY is set), a provider, or "none" / false. */
  timingSecondOpinion?: string | false;
  llm?: string;
  context?: string;
  contextFile?: string;
  /** Path to a glossary file, or the terms themselves. */
  glossary?: string | string[];
  speakers?: string | Record<string, string>;
  /** A code, "auto", or candidates for mixed-language media ("en,es" or ["en", "es"]; the first is the main language). */
  language?: string | string[];
  /** Infer a context from the transcript when none is given (default true). */
  inferContext?: boolean;
  /** Ask the LLM where captions and lines break (default false). */
  llmLinebreaks?: boolean;
  /** "latest" (default) or a pinned id such as "1". */
  rules?: string;
  effort?: Partial<EffortConfig>;
  /** Keyed by language code ("nl", "nl-BE"). */
  languages?: Record<string, LanguageDefaults>;
  profiles?: string | string[];
  export?: string | string[];
  numbers?: StyleSettings['numbers'];
  currency?: StyleSettings['currency'];
  styleGuide?: string;
  out?: string;
  cacheDir?: string;
  chunkMb?: number;
  profileRules?: Record<string, ProfileOverride>;
  styling?: { maxStyledRatio?: number; maxKeyPerCue?: number };
  edits?: { maxSpan?: number };
  /** Transcribe again with the inferred context in the prompt (default false). */
  twoPass?: boolean;
  /** Mark "(??)" after unresolved words in VTT/SRT/TXT (default false). */
  markUncertain?: boolean;
  /** Loudness-normalize the extracted audio before any provider hears it (default false). */
  normalizeLoudness?: boolean;
}

/** Every FileConfig key, for the unknown-key warning; the type check below keeps it complete. */
const FILE_KEYS = [
  'local', 'text', 'timing', 'timingSecondOpinion', 'llm', 'context', 'contextFile', 'glossary', 'speakers', 'language',
  'inferContext', 'llmLinebreaks', 'rules', 'effort', 'languages', 'profiles', 'export', 'numbers', 'currency',
  'styleGuide', 'out', 'cacheDir', 'chunkMb', 'profileRules', 'styling', 'edits', 'twoPass', 'markUncertain',
  'normalizeLoudness',
] as const satisfies ReadonlyArray<keyof FileConfig>;
const fileKeysComplete: Exclude<keyof FileConfig, (typeof FILE_KEYS)[number]> extends never ? true : never = true;
void fileKeysComplete;

/** `transcribe` options from commander. Unset flags fall back to the config file. */
export interface CliFlags {
  /** --local: LOCAL_PRESET for every role without an explicit flag. */
  local?: boolean;
  text?: string;
  timing?: string;
  /** --timing-second-opinion: auto, none or a provider. */
  timingSecondOpinion?: string;
  llm?: string;
  context?: string;
  contextFile?: string;
  glossary?: string;
  speakers?: string;
  language?: string;
  profiles?: string;
  export?: string;
  numbers?: string;
  currency?: string;
  styleGuide?: string;
  out?: string;
  fromStage?: string;
  cache?: boolean;
  /** --no-infer-context sets false (commander defaults it to true). */
  inferContext?: boolean;
  /** Unset: the config file, else DEFAULTS.llmLinebreaks. */
  llmLinebreaks?: boolean;
  /** --rules <id>: "latest" or an id such as "1". */
  rules?: string;
  /** Unset: the config file, else false. */
  twoPass?: boolean;
  /** Unset: the config file, else false. */
  markUncertain?: boolean;
  /** Unset: the config file, else false. */
  normalizeLoudness?: boolean;
  /** --text-file: a transcript (.srt, .vtt, .txt) used instead of a text provider. */
  textFile?: string;
  /** With --export mp4: a style pack name or a pack's style.css. */
  burnStyle?: string;
  /** With --export mp4: never | change | always. */
  burnSpeakerNames?: string;
  /** With --export mp4: a font file instead of the style's font. */
  burnFont?: string;
  config?: string;
}

export interface ResolvedProfile { id: string; description?: string; aspect: string; rules: ProfileRules; window?: TimeWindow }

export interface ResolvedConfig {
  text: ModelSpec;
  timing: ModelSpec;
  /**
   * The second hearing (hearings.ts): 'auto' (elevenlabs when its key is set and it is not the timing provider), a
   * provider, or false. Local mode turns 'auto' off; `--local` also drops a cloud provider named only in the config file.
   */
  timingSecondOpinion: 'auto' | false | ModelSpec;
  llm: ModelSpec;
  context?: string;
  glossary: string[];
  /** Pinned speaker labels, e.g. { S1: 'Sarah' }. */
  speakers: Record<string, string>;
  /** undefined: auto-detect. With candidates: the main (first) one. */
  language?: string;
  /** Candidates when more than one was given (--language en,es), main language first. */
  languageCandidates?: string[];
  /** Infer a context from the transcript when none is given. */
  inferContext: boolean;
  /** Ask the LLM for line-cutting proposals (false: the rules alone). */
  llmLinebreaks: boolean;
  /** Every layout parameter; `ruleset.id` is recorded as meta.rules. */
  ruleset: RuleSet;
  /** Transcribe again with the inferred context in the prompt. */
  twoPass: boolean;
  /** Mark "(??)" after unresolved words in the rendered files. */
  markUncertain: boolean;
  /** EBU R128, before transcription and timing. */
  normalizeLoudness: boolean;
  /** --text-file, absolute. No text provider is called. */
  textFile?: string;
  /** Absolute paths of the context and glossary files read; no output may overwrite them. */
  contextFile?: string;
  glossaryFile?: string;
  effort: EffortConfig;
  /** Keyed by canonical code ("nl", "nl-BE"). */
  languageDefaults: Record<string, ResolvedLanguageDefaults>;
  /** Roles chosen with a flag (--text, --llm, --local); per-language defaults never override them. */
  explicit: { text: boolean; llm: boolean };
  profiles: ResolvedProfile[];
  /** Profiles were given (flag or config file), so no media profile is added. */
  profilesExplicit: boolean;
  exports: ExportFormat[];
  /** `--export mp4` options; the font is an absolute path. */
  burn: { style?: string; speakerNames?: 'never' | 'change' | 'always'; font?: string };
  style: StyleSettings;
  outDir?: string;
  cacheDir: string;
  chunkBytes: number;
  styling: { maxStyledRatio: number; maxKeyPerCue: number };
  edits: { maxSpan: number };
  fromStage?: Stage;
  useCache: boolean;
}

/** Load `<cwd>/.env` into process.env (existing variables win). */
export function loadEnv(cwd: string): void {
  dotenv.config({ path: resolve(cwd, '.env'), quiet: true });
}

/** Read `--config <path>` (must exist) or `<cwd>/overtone.config.json` (optional). Unknown keys go to `warn`. */
export async function loadConfigFile(path: string | undefined, cwd: string, warn: (msg: string) => void = consoleLogger.warn): Promise<{ config: FileConfig; dir: string }> {
  const file = path ? resolve(cwd, path) : resolve(cwd, 'overtone.config.json');
  if (!existsSync(file)) {
    if (path) throw new UserError(`Config file not found: ${file}`);
    return { config: {}, dir: cwd };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new UserError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  return { config: validateFileConfig(parsed, basename(file), warn), dir: dirname(file) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The known key closest to `key` (case-insensitive, at most a third of its letters different). */
export function closestKey(key: string, known: readonly string[]): string | undefined {
  const k = key.toLowerCase();
  let best: { key: string; d: number } | undefined;
  for (const candidate of known) {
    const d = levenshtein(k, candidate.toLowerCase());
    if (d <= Math.max(1, Math.floor(Math.max(k.length, candidate.length) / 3)) && (!best || d < best.d)) best = { key: candidate, d };
  }
  return best?.key;
}

/**
 * Check the shape of a parsed config file (no coercion); throws a UserError naming the field. Unknown keys are kept
 * and reported through `warn` with the closest known key; keys starting with "$" are never reported.
 */
export function validateFileConfig(raw: unknown, source = 'overtone.config.json', warn: (msg: string) => void = () => {}): FileConfig {
  if (!isObj(raw)) throw new UserError(`${source} must contain a JSON object`);
  const unknownKeys = (obj: Obj, known: readonly string[], at = ''): void => {
    for (const key of Object.keys(obj)) {
      if (key.startsWith('$') || known.includes(key)) continue;
      const near = closestKey(key, known);
      warn(`${source}: unknown key "${at}${key}" is ignored${near ? ` (did you mean "${at}${near}"?)` : ''}.`);
    }
  };
  unknownKeys(raw, FILE_KEYS);
  const bad = (field: string, expected: string): never => {
    throw new UserError(`${source}: "${field}" must be ${expected}.`);
  };
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const check = (obj: Obj, key: string, field: string, test: (v: unknown) => boolean, expected: string): void => {
    if (obj[key] !== undefined && !test(obj[key])) bad(field, expected);
  };
  const posInt = (v: unknown) => isNum(v) && Number.isInteger(v) && v > 0;
  const posNum = (v: unknown) => isNum(v) && v > 0;
  const ratio = (v: unknown) => isNum(v) && v >= 0 && v <= 1;

  for (const key of ['text', 'timing', 'llm', 'context', 'contextFile', 'numbers', 'currency', 'styleGuide', 'out', 'cacheDir', 'rules']) {
    check(raw, key, key, (v) => typeof v === 'string', 'a string');
  }
  for (const key of ['glossary', 'profiles', 'export', 'language']) {
    check(raw, key, key, (v) => typeof v === 'string' || isStrings(v), 'a string or an array of strings');
  }
  check(raw, 'timingSecondOpinion', 'timingSecondOpinion', (v) => typeof v === 'string' || v === false, '"auto", "none", false or a provider such as "elevenlabs"');
  check(raw, 'speakers', 'speakers', (v) => typeof v === 'string' || (isObj(v) && Object.values(v).every((x) => typeof x === 'string')), 'a string like "S1=Sarah,S2=Tom" or an object of strings');
  const { min, max } = DEFAULTS.chunkMbRange;
  check(raw, 'chunkMb', 'chunkMb', (v) => isNum(v) && v >= min && v <= max, `a positive number from ${min} to ${max} (megabytes per uploaded audio chunk; default ${DEFAULTS.chunkMb})`);
  for (const key of ['local', 'twoPass', 'markUncertain', 'normalizeLoudness']) check(raw, key, key, (v) => typeof v === 'boolean', 'true or false');
  check(raw, 'inferContext', 'inferContext', (v) => typeof v === 'boolean', 'true or false');
  check(raw, 'llmLinebreaks', 'llmLinebreaks', (v) => typeof v === 'boolean', 'true or false');
  const checkEffort = (v: unknown, at: string) => {
    if (v === undefined) return;
    if (!isObj(v)) bad(at, 'an object');
    for (const [step, value] of Object.entries(v as Obj)) {
      if (!(EFFORT_STEPS as readonly string[]).includes(step)) bad(`${at}.${step}`, `one of the steps ${EFFORT_STEPS.join(', ')}`);
      if (!(EFFORTS as readonly unknown[]).includes(value)) bad(`${at}.${step}`, `one of ${EFFORTS.join(', ')}`);
    }
  };
  checkEffort(raw.effort, 'effort');
  if (raw.languages !== undefined) {
    if (!isObj(raw.languages)) bad('languages', 'an object keyed by language code');
    for (const [code, o] of Object.entries(raw.languages as Obj)) {
      const at = `languages.${code}`;
      if (!isObj(o)) bad(at, 'an object');
      unknownKeys(o as Obj, ['text', 'llm', 'effort'], `${at}.`);
      for (const key of ['text', 'llm']) check(o as Obj, key, `${at}.${key}`, (v) => typeof v === 'string', 'a string');
      checkEffort((o as Obj).effort, `${at}.effort`);
    }
  }

  if (raw.profileRules !== undefined) {
    if (!isObj(raw.profileRules)) bad('profileRules', 'an object');
    for (const [id, o] of Object.entries(raw.profileRules as Obj)) {
      const at = `profileRules.${id}`;
      if (!isObj(o)) bad(at, 'an object');
      const ov = o as Obj;
      unknownKeys(ov, ['description', 'aspect', 'rules', 'window'], `${at}.`);
      check(ov, 'description', `${at}.description`, (v) => typeof v === 'string', 'a string');
      check(ov, 'aspect', `${at}.aspect`, (v) => typeof v === 'string' && ASPECT_PATTERN.test(v), 'a ratio "W:H" of two positive integers, such as "4:5"');
      if (ov.rules !== undefined) {
        if (!isObj(ov.rules)) bad(`${at}.rules`, 'an object');
        const rules = ov.rules as Obj;
        unknownKeys(rules, ['maxCharsPerLine', 'maxLines', 'maxCps', 'minDuration', 'maxDuration'], `${at}.rules.`);
        for (const key of ['maxCharsPerLine', 'maxLines']) check(rules, key, `${at}.rules.${key}`, posInt, 'a positive integer');
        for (const key of ['maxCps', 'minDuration', 'maxDuration']) check(rules, key, `${at}.rules.${key}`, posNum, 'a positive number');
      }
      if (ov.window !== undefined) {
        const w = ov.window;
        if (!isObj(w) || !isNum(w.start) || !isNum(w.end) || w.start < 0 || w.end <= w.start) {
          bad(`${at}.window`, 'an object { "start": seconds, "end": seconds } with 0 <= start < end');
        }
        unknownKeys(w as Obj, ['start', 'end'], `${at}.window.`);
      }
    }
  }
  if (raw.styling !== undefined) {
    if (!isObj(raw.styling)) bad('styling', 'an object');
    const styling = raw.styling as Obj;
    unknownKeys(styling, ['maxStyledRatio', 'maxKeyPerCue'], 'styling.');
    check(styling, 'maxStyledRatio', 'styling.maxStyledRatio', ratio, 'a number from 0 to 1');
    check(styling, 'maxKeyPerCue', 'styling.maxKeyPerCue', (v) => isNum(v) && Number.isInteger(v) && v >= 0, 'a non-negative integer');
  }
  if (raw.edits !== undefined) {
    if (!isObj(raw.edits)) bad('edits', 'an object');
    const edits = raw.edits as Obj;
    unknownKeys(edits, ['maxSpan', 'minSimilarity'], 'edits.');
    check(edits, 'maxSpan', 'edits.maxSpan', posInt, 'a positive integer');
    if (edits.minSimilarity !== undefined) {
      warn(`${source}: "edits.minSimilarity" is no longer used and is ignored: the LLM editor is trusted to judge the words (docs/cli/pipeline.md, "The editor").`);
      delete edits.minSimilarity;
    }
  }
  return raw as FileConfig;
}

/** Split a comma-separated string or array into trimmed, non-empty items in order. `dedupe: false` for lists where a repeat is an error. */
export function splitList(value: string | readonly string[] | undefined, dedupe = true): string[] | undefined {
  if (value === undefined) return undefined;
  const items = (typeof value === 'string' ? value.split(',') : [...value]).map((s) => s.trim()).filter((s) => s.length > 0);
  return dedupe ? [...new Set(items)] : items;
}

/** Like `splitList`, but an empty result is a user error. */
export function requireList(value: string | readonly string[] | undefined, what: string, source?: string, dedupe = true): string[] | undefined {
  const list = splitList(value, dedupe);
  if (list && list.length === 0) throw new UserError(`No ${what} given${source ? ` in ${source}` : ''}.`);
  return list;
}

/** Parse and check export formats. `source` ("--export", "the config file") is only used in errors. */
export function parseFormats(value: string | readonly string[] | undefined, fallback: readonly ExportFormat[], source?: string, allowed: readonly ExportFormat[] = EXPORT_FORMATS): ExportFormat[] {
  const list = requireList(value, 'export formats', source) ?? [...fallback];
  for (const f of list) {
    if (!(allowed as readonly string[]).includes(f)) {
      throw new UserError(`Invalid export format "${f}"${source ? ` in ${source}` : ''}; expected one of: ${allowed.join(', ')}.`);
    }
  }
  return list as ExportFormat[];
}

/**
 * "S1=Sarah,S2=Tom" or { S1: 'Sarah', S2: 'Tom' } → { S1: 'Sarah', S2: 'Tom' }. An empty id or label, or a repeated
 * id, is a user error.
 */
export function parseSpeakers(value: string | Record<string, string> | undefined, source = '--speakers'): Record<string, string> {
  if (value === undefined) return {};
  const pairs: Array<[string, string, string]> = typeof value === 'string'
    ? (splitList(value, false) ?? []).map((part) => {
      const eq = part.indexOf('=');
      return [part.slice(0, Math.max(eq, 0)).trim(), eq < 0 ? '' : part.slice(eq + 1).trim(), part];
    })
    : Object.entries(value).map(([id, label]) => [id.trim(), String(label).trim(), `"${id}": "${label}"`]);
  // No prototype: "__proto__" or "constructor" is an own key.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, label, entry] of pairs) {
    if (id === '' || label === '') {
      throw new UserError(typeof value === 'string'
        ? `Invalid --speakers entry "${entry}"${source === '--speakers' ? '' : ` in ${source}`}; expected e.g. "S1=Sarah,S2=Tom".`
        : `Invalid speakers entry ${entry} in ${source}; give each speaker an id and a label, e.g. { "S1": "Sarah" }.`);
    }
    if (Object.hasOwn(out, id)) throw new UserError(`Speaker "${id}" is given twice in ${source} ("${out[id]}" and "${label}"); give each speaker id once.`);
    out[id] = label;
  }
  return out;
}

/** Read a text file; every failure becomes a one-line user error. */
async function readTextFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = fsCode(err);
    if (code === 'ENOENT') throw new UserError(`${label} not found: ${path}`);
    if (code === 'EISDIR') throw new UserError(`${label} is a directory: ${path}`);
    if (code === 'EACCES' || code === 'EPERM') throw new UserError(`${label} is not readable (permission denied): ${path}`);
    throw new UserError(`Cannot read ${label.toLowerCase()} ${path} (${code ?? (err as Error).message})`);
  }
}

/** Glossary file: one term per line; blank lines and lines starting with '#' are ignored. */
export async function readGlossary(path: string): Promise<string[]> {
  const raw = await readTextFile(path, 'Glossary file');
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** `what`: the option as written ("--numbers") or the config key; `from`: where a config value came from. */
export function oneOf<T extends string>(what: string, value: string | undefined, allowed: readonly T[], from = ''): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UserError(`Invalid ${what} "${value}"${from}; expected one of: ${allowed.join(', ')}.`);
  return value as T;
}

/**
 * Profiles from names (built-in or in profileRules) or aspects ("1:1" or "1x1", id "1x1"). A name defined in
 * profileRules stays a name even when it looks like "WxH". profileRules values win over the derived rules.
 */
function resolveProfiles(ids: string[], overrides: Record<string, ProfileOverride>, ruleset: RuleSet): ResolvedProfile[] {
  const builtIn = ruleset.profiles;
  const seen = new Map<string, string>();
  return ids.map((token) => {
    // "1:1" and "1x1" are both the profile "1x1". A built-in or profileRules name wins over reading it as an aspect.
    const named = PROFILE_ID_PATTERN.test(token) && (Object.hasOwn(builtIn, token) || Object.hasOwn(overrides, token));
    const written = named ? undefined : aspectOf(token);
    const byAspect = written !== undefined;
    const tokenAspect = written === undefined ? undefined : reduceAspect(written);
    const id = tokenAspect ? aspectId(tokenAspect) : token;
    if (!PROFILE_ID_PATTERN.test(id)) throw new UserError(`Invalid profile "${token}": use a name (letters, digits, '-' and '_') or an aspect such as "1:1".`);
    // "1:1" and "2:2" are both "1x1"; a document has each profile id once.
    const first = seen.get(id);
    if (first !== undefined) throw new UserError(`Profile "${id}" is listed twice ("${first}" and "${token}").`);
    seen.set(id, token);
    // Own properties only: "constructor" is not a profile.
    const base = !byAspect && Object.hasOwn(builtIn, id) ? builtIn[id as keyof typeof builtIn] : undefined;
    const o = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
    if (!base && !byAspect && !o) {
      throw new UserError(`Unknown profile "${id}": use ${Object.keys(builtIn).join(' or ')}, an aspect such as "1:1", or define profileRules.${id} with an "aspect" in overtone.config.json.`);
    }
    // An aspect in the profile list decides; a different one in profileRules is a conflict.
    const ruleAspect = o?.aspect === undefined ? undefined : reduceAspect(o.aspect);
    if (tokenAspect && ruleAspect !== undefined && ruleAspect !== tokenAspect) {
      throw new UserError(`Profile "${id}" is given as "${token}" in the profile list but profileRules.${id}.aspect is "${o?.aspect}"; use one.`);
    }
    const aspect = tokenAspect ?? ruleAspect ?? base?.aspect;
    if (aspect === undefined) {
      throw new UserError(`Profile "${id}" needs an aspect: set profileRules.${id}.aspect, such as "4:5", in overtone.config.json.`);
    }
    const derived = base && aspect === base.aspect ? base.rules : rulesFor(ruleset, aspect);
    const rules: ProfileRules = { ...derived, ...o?.rules };
    if (rules.minDuration !== undefined && rules.maxDuration !== undefined && rules.minDuration > rules.maxDuration) {
      throw new UserError(`Profile "${id}" has minDuration ${rules.minDuration} s, more than its maxDuration ${rules.maxDuration} s; set profileRules.${id}.rules so that minDuration is at most maxDuration in overtone.config.json.`);
    }
    const description = o?.description ?? base?.description ?? tokenAspect;
    return { id, ...(description ? { description } : {}), aspect, rules, ...(o?.window ? { window: o.window } : {}) };
  });
}

/** Merge defaults < config file < CLI flags. Reads the context and glossary files. */
export async function resolveConfig(flags: CliFlags, file: FileConfig, dirs: { cwd: string; configDir: string }, warn: (msg: string) => void = () => {}): Promise<ResolvedConfig> {
  const fromFile = (p: string | undefined) => (p === undefined ? undefined : resolve(dirs.configDir, p));
  const fromCwd = (p: string | undefined) => (p === undefined ? undefined : resolve(dirs.cwd, p));

  const contextFile = fromCwd(flags.contextFile) ?? fromFile(file.contextFile);
  let context = flags.context ?? (flags.contextFile ? undefined : file.context);
  const contextRead = context === undefined ? contextFile : undefined;
  if (contextRead) context = (await readTextFile(contextRead, 'Context file')).trim();

  let glossary: string[] = [];
  const glossaryFile = flags.glossary ? fromCwd(flags.glossary) : typeof file.glossary === 'string' ? fromFile(file.glossary) : undefined;
  if (glossaryFile) glossary = await readGlossary(glossaryFile);
  else if (Array.isArray(file.glossary)) glossary = [...file.glossary];

  const exports = parseFormats(flags.export ?? file.export, DEFAULTS.exports, flags.export !== undefined ? '--export' : 'the config file');

  const { language, candidates: languageCandidates } = parseLanguages(flags.language ?? file.language, flags.language !== undefined ? '--language' : 'the config file');
  const fromStage = oneOf('--from-stage', flags.fromStage, STAGES);
  const speakerNames = oneOf('--burn-speaker-names', flags.burnSpeakerNames, ['never', 'change', 'always'] as const);
  const ruleset = flags.rules !== undefined ? resolveRuleSet(flags.rules, '--rules') : resolveRuleSet(file.rules ?? DEFAULTS.rules, 'the config file ("rules")');
  const numbers = flags.numbers !== undefined
    ? oneOf('--numbers', flags.numbers, NUMBER_STYLES)
    : oneOf('numbers', file.numbers, NUMBER_STYLES, ' in the config file');
  const currency = flags.currency !== undefined
    ? oneOf('--currency', flags.currency, CURRENCY_STYLES)
    : oneOf('currency', file.currency, CURRENCY_STYLES, ' in the config file');
  const guide = flags.styleGuide ?? file.styleGuide;

  const languageDefaults: Record<string, ResolvedLanguageDefaults> = {};
  for (const [key, d] of Object.entries(file.languages ?? {})) {
    const code = canonicalLanguage(key);
    if (!code) throw new UserError(`Invalid language code "${key}" in "languages" of the config file; expected a code such as en, nl or nl-BE.`);
    languageDefaults[code] = {
      ...(d.text ? { text: parseModelSpec(d.text) } : {}),
      ...(d.llm ? { llm: parseModelSpec(d.llm) } : {}),
      ...(d.effort ? { effort: { ...d.effort } } : {}),
    };
  }

  if (flags.textFile !== undefined && flags.text !== undefined) {
    throw new UserError('--text and --text-file cannot be combined: --text-file replaces the text provider.');
  }
  const twoPass = flags.twoPass ?? file.twoPass ?? false;
  if (flags.textFile !== undefined && twoPass) {
    const what = flags.twoPass ? '--two-pass' : '"twoPass": true in the config file';
    const fix = flags.twoPass ? '' : ' Add --no-two-pass to this run.';
    throw new UserError(`${what} cannot be combined with --text-file: the text comes from the file, so there is nothing to transcribe again.${fix}`);
  }

  // explicit flag > --local > config file field > "local": true in the config file > defaults
  const pick = (role: 'text' | 'timing' | 'llm'): string =>
    flags[role] ?? (flags.local ? LOCAL_PRESET[role] : undefined) ?? file[role] ?? (file.local ? LOCAL_PRESET[role] : undefined) ?? DEFAULTS[role];

  // Local mode without a timing choice: whisper.cpp times the words, in the same call when it also writes the text.
  const localTiming = flags.timing === undefined && (flags.local === true || (file.timing === undefined && file.local === true));
  const text = pick('text');
  const textIsLocal = flags.textFile === undefined && parseModelSpec(text).provider === parseModelSpec(LOCAL_PRESET.text).provider;
  const timing = localTiming ? (textIsLocal ? LOCAL_PRESET.timing : LOCAL_PRESET.text) : pick('timing');

  let secondOpinion = parseSecondOpinion(
    flags.timingSecondOpinion ?? file.timingSecondOpinion,
    flags.timingSecondOpinion !== undefined ? '--timing-second-opinion' : 'timingSecondOpinion in the config file',
  );
  // Flags beat the config file: --local drops a cloud second opinion named only there.
  if (flags.local === true && flags.timingSecondOpinion === undefined && typeof secondOpinion === 'object' && !LOCAL_PROVIDERS.has(secondOpinion.provider)) {
    warn(`--local: ignoring "timingSecondOpinion": "${file.timingSecondOpinion}" from the config file (a cloud provider); add --timing-second-opinion ${secondOpinion.provider} to use it.`);
    secondOpinion = false;
  }
  // Local mode: no audio goes to the cloud unless a provider was named, so 'auto' becomes none.
  const offline = flags.local === true || file.local === true;

  return {
    text: parseModelSpec(text),
    timing: parseModelSpec(timing),
    timingSecondOpinion: secondOpinion === 'auto' && offline ? false : secondOpinion,
    llm: parseModelSpec(pick('llm')),
    context: context || undefined,
    glossary,
    speakers: parseSpeakers(flags.speakers ?? file.speakers, flags.speakers !== undefined ? '--speakers' : 'the config file'),
    language,
    ...(languageCandidates ? { languageCandidates } : {}),
    inferContext: flags.inferContext === false ? false : file.inferContext ?? true,
    llmLinebreaks: flags.llmLinebreaks ?? file.llmLinebreaks ?? DEFAULTS.llmLinebreaks,
    ruleset,
    twoPass,
    markUncertain: flags.markUncertain ?? file.markUncertain ?? false,
    normalizeLoudness: flags.normalizeLoudness ?? file.normalizeLoudness ?? false,
    ...(flags.textFile !== undefined ? { textFile: fromCwd(flags.textFile) } : {}),
    ...(contextRead ? { contextFile: contextRead } : {}),
    ...(glossaryFile ? { glossaryFile } : {}),
    effort: { ...DEFAULTS.effort, ...file.effort },
    languageDefaults,
    explicit: { text: flags.text !== undefined || flags.local === true, llm: flags.llm !== undefined || flags.local === true },
    profiles: resolveProfiles(requireList(flags.profiles ?? file.profiles, 'profiles', flags.profiles !== undefined ? '--profiles' : 'the config file', false) ?? [...DEFAULTS.profiles], file.profileRules ?? {}, ruleset),
    profilesExplicit: flags.profiles !== undefined || file.profiles !== undefined,
    exports,
    burn: {
      ...(flags.burnStyle !== undefined ? { style: flags.burnStyle } : {}),
      ...(speakerNames !== undefined ? { speakerNames } : {}),
      ...(flags.burnFont !== undefined ? { font: fromCwd(flags.burnFont) } : {}),
    },
    style: { numbers: numbers ?? 'auto', currency: currency ?? 'auto', ...(guide ? { guide } : {}) },
    outDir: fromCwd(flags.out) ?? fromFile(file.out),
    cacheDir: fromFile(file.cacheDir) ?? resolve(dirs.cwd, DEFAULTS.cacheDir),
    chunkBytes: Math.round((file.chunkMb ?? DEFAULTS.chunkMb) * 1024 * 1024),
    styling: { ...ruleset.styling, ...file.styling },
    edits: { ...DEFAULTS.edits, ...file.edits },
    fromStage,
    useCache: flags.cache !== false,
  };
}

/** "auto" (default), "none" / "off" / false, or a provider. */
export function parseSecondOpinion(value: string | false | undefined, source: string): 'auto' | false | ModelSpec {
  if (value === undefined) return 'auto';
  if (value === false) return false;
  const v = value.trim().toLowerCase();
  if (v === 'auto' || v === '') return 'auto';
  if (v === 'none' || v === 'off' || v === 'false') return false;
  if (v === 'same') throw new UserError(`${source}: "same" is not a timing provider; use auto, none or a provider such as elevenlabs.`);
  return parseModelSpec(value);
}

/** One code, "auto" or nothing (detect), or candidates for mixed-language media ("en,es"; the first is the main one). */
export function parseLanguages(value: string | readonly string[] | undefined, source: string): { language?: string; candidates?: string[] } {
  const list = splitList(value) ?? [];
  if (list.length === 0 || (list.length === 1 && list[0].toLowerCase() === 'auto')) return {};
  if (list.length === 1) return { language: list[0] };
  if (list.some((l) => l.toLowerCase() === 'auto')) throw new UserError(`"auto" cannot be combined with other languages in ${source}.`);
  return { language: list[0], candidates: list };
}

/** The defaults for `language` ("nl-BE": the "nl-BE" entry, else "nl"). */
export function languageDefaultsFor(cfg: Pick<ResolvedConfig, 'languageDefaults'>, language: string | undefined): ResolvedLanguageDefaults | undefined {
  if (!language) return undefined;
  const code = canonicalLanguage(language);
  if (!code) return undefined;
  const primary = code.split('-')[0];
  return cfg.languageDefaults[code] ?? cfg.languageDefaults[primary];
}
