import { DEFAULTS, parseModelSpec, type ModelSpec } from '../config.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { DEFAULT_RETRIES, httpStatus, isTimeout, TIMEOUT_RETRIES } from '../util/retry.js';
import { anthropicProvider } from './anthropic.js';
import { azureMaiProvider } from './azure-mai.js';
import { azureSpeechProvider } from './azure-speech.js';
import { elevenlabsProvider } from './elevenlabs.js';
import { recordingFetch } from './http-record.js';
import {
  hasWordTimings,
  implementsRole,
  redact,
  endpointVars,
  explainNetworkError,
  redactError,
  secretValues,
  credentialedEndpointVars,
  withRedaction,
  type AnyProvider,
  type CreateDeps,
  type ProviderDeps,
  type ProviderDescriptor,
  type Role,
  type UsageReport,
} from './kit.js';
import { ollamaProvider } from './ollama.js';
import { azureOpenaiProvider, openaiProvider } from './openai.js';
import { recordedProvider } from './recorded.js';
import { withSchemaValidation } from './structured.js';
import type { LlmProvider, TextProvider, TimingProvider } from './types.js';
import { whisperCppProvider } from './whisper-cpp.js';

export type { ProviderDeps, Role } from './kit.js';

/** In `overtone providers` order. To add one, copy `_template.ts` and list it here (docs/contributing/providers.md). */
export const BUILTIN_PROVIDERS: readonly ProviderDescriptor[] = [
  openaiProvider,
  azureOpenaiProvider,
  anthropicProvider,
  azureSpeechProvider,
  azureMaiProvider,
  elevenlabsProvider,
  whisperCppProvider,
  ollamaProvider,
  recordedProvider,
];

const REGISTRY = new Map<string, ProviderDescriptor>(BUILTIN_PROVIDERS.map((d) => [d.id, d]));

export function providers(): ProviderDescriptor[] {
  return [...REGISTRY.values()];
}

/** Undefined for unknown ids (including names like "constructor"). */
export function getProvider(id: string): ProviderDescriptor | undefined {
  return REGISTRY.get(id);
}

/** Registers a provider at runtime (tests, conformance kit, embedders). Returns an unregister function. */
export function registerProvider(d: ProviderDescriptor): () => void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(d.id)) throw new Error(`provider id "${d.id}" must be lowercase letters, digits and '-'`);
  if (d.id === 'same') throw new Error('"same" is reserved for --timing same');
  const before = REGISTRY.get(d.id);
  REGISTRY.set(d.id, d);
  return () => {
    if (before) REGISTRY.set(d.id, before);
    else REGISTRY.delete(d.id);
  };
}

const known = () => [...REGISTRY.keys()].join(', ');

/** Checks provider and role and fills in the default model: `openai` → `openai:gpt-transcribe` for text. */
export function resolveSelection(spec: ModelSpec, role: Role): ModelSpec {
  if (spec.provider === 'same') {
    if (role !== 'timing') throw new UserError(`--${role} same: "same" is only valid for --timing (the text provider then also gives the timings).`);
    throw new UserError('--timing same is resolved together with --text (use resolveSelections).');
  }
  const info = getProvider(spec.provider);
  if (!info) throw new UserError(`Unknown provider "${spec.provider}" for --${role}; known: ${known()}.`);
  if (!info.roles.includes(role)) {
    throw new UserError(`Provider "${spec.provider}" cannot be used for --${role} (it supports: ${info.roles.join(', ')}).`);
  }
  const raw = spec.model ?? info.defaults[role];
  if (!raw) throw new UserError(`--${role} ${spec.provider} needs a model part: ${info.modelHint ?? 'provider:model'}.`);
  const model = info.normalizeModel ? info.normalizeModel(raw, role) : raw;
  return { provider: spec.provider, model, id: `${spec.provider}:${model}` };
}

export interface Selections { text: ModelSpec; timing: ModelSpec; llm: ModelSpec }

/** Providers whose text role returns word times, so they can serve `--timing same`. */
export function wordTimingProviders(): string[] {
  return providers()
    .filter((d) => d.wordTimings && d.roles.includes('text'))
    .flatMap((d) => (d.wordTimings === true ? [d.id] : (d.wordTimings as readonly string[]).map((m) => `${d.id}:${m}`)));
}

/** A role's default provider:model id ("openai:gpt-transcribe"). */
export function defaultSelectionId(role: 'text' | 'timing' | 'llm'): string {
  return resolveSelection(parseModelSpec(DEFAULTS[role]), role).id;
}

/**
 * Resolves all three roles. `--timing same` reuses the text selection (`same: true`): its word times are used, with
 * no second call. Needs a provider with `wordTimings`.
 */
export function resolveSelections(specs: Selections): Selections {
  const text = resolveSelection(specs.text, 'text');
  const llm = resolveSelection(specs.llm, 'llm');
  if (specs.timing.provider !== 'same') return { text, timing: resolveSelection(specs.timing, 'timing'), llm };
  if (specs.timing.model) throw new UserError(`--timing same takes no model part (got "${specs.timing.id}"); the text selection is used.`);
  if (!hasWordTimings(getProvider(text.provider), text.model)) {
    throw new UserError(`--timing same: the text provider "${text.id}" returns no word timings; use one that does (${wordTimingProviders().join(', ')}) or a timing provider such as azure-speech.`);
  }
  return { text, timing: { ...text, same: true }, llm };
}

/** Required but unset variables, e.g. "OPENAI_API_KEY (openai)". */
export function missingEnv(selections: readonly ModelSpec[], env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of selections) {
    for (const v of getProvider(s.provider)?.env ?? []) {
      if (!v.required) continue;
      if (v.waivedBy && env[v.waivedBy]?.trim()) continue;
      if (!env[v.name]?.trim() && !seen.has(v.name)) {
        seen.add(v.name);
        out.push(`${v.name} (${s.provider})`);
      }
    }
  }
  return out;
}

/** The full list of provider variables, for npm installs. */
export const ENV_EXAMPLE_URL = 'https://github.com/lonthq/overtone-captions/blob/main/.env.example';

/** Names the missing variables (never values), says where to set them and points to keyless `--local`. */
export function missingEnvError(missing: readonly string[], forWhat = 'the selected providers'): UserError {
  return new UserError([
    `Missing environment variables for ${forWhat}:`,
    ...missing.map((m) => `  ${m}`),
    `Set them in .env or your environment; .env.example lists them all (${ENV_EXAMPLE_URL}).`,
    'No keys? Use --local to run free and offline with whisper.cpp and Ollama.',
  ].join('\n'));
}

/** `secondTiming`: the optional second hearing (hearings.ts). */
export interface Providers { text: TextProvider; timing: TimingProvider; llm: LlmProvider; secondTiming?: TimingProvider }

/** What `auto` picks as the second hearing when its key is set. */
export const AUTO_SECOND_OPINION = { provider: 'elevenlabs', key: 'ELEVENLABS_API_KEY' } as const;

/**
 * Resolves `--timing-second-opinion`. 'auto' is elevenlabs when ELEVENLABS_API_KEY is set and neither timing nor text
 * already uses elevenlabs (a second Scribe request would only add cost). A named provider must differ from the timing
 * provider. Undefined: none.
 */
export function secondOpinionSelection(setting: 'auto' | false | ModelSpec, primary: ModelSpec, env: NodeJS.ProcessEnv, text?: ModelSpec): ModelSpec | undefined {
  if (setting === false) return undefined;
  if (setting === 'auto') {
    if (!env[AUTO_SECOND_OPINION.key]?.trim() || primary.provider === AUTO_SECOND_OPINION.provider || text?.provider === AUTO_SECOND_OPINION.provider) return undefined;
    return resolveSelection({ provider: AUTO_SECOND_OPINION.provider, id: AUTO_SECOND_OPINION.provider }, 'timing');
  }
  if (setting.provider === 'same') throw new UserError('--timing-second-opinion same: "same" is not a timing provider; use auto, none or a provider such as elevenlabs.');
  const sel = resolveSelection(setting, 'timing');
  if (sel.id === primary.id) {
    throw new UserError(`--timing-second-opinion ${sel.id} is the timing provider itself; choose another provider, or none.`);
  }
  return sel;
}

export interface CreateOptions {
  cwd: string;
  log?: Logger;
  deps?: ProviderDeps;
  /** Every usage report, tagged with provider id and role. */
  onUsage?: (report: UsageReport) => void;
}

function createDeps(role: Role, sel: ModelSpec, env: NodeJS.ProcessEnv, opts: CreateOptions): CreateDeps {
  const d = getProvider(sel.provider)!;
  const deps = opts.deps ?? {};
  const secrets = secretValues(d, env);
  const recordDir = env.OVERTONE_RECORD_HTTP?.trim();
  const fetchImpl = recordDir && !deps.fetch
    ? recordingFetch(recordDir, `${sel.provider}-${role}`, secrets)
    : deps.fetch;
  const log = opts.log;
  // a retry can wait a minute (Retry-After): say so rather than look stuck
  const onRetry = (attempt: number, err: unknown, delayMs: number) => {
    deps.retry?.onRetry?.(attempt, err, delayMs);
    const status = httpStatus(err);
    // redact before truncating, so no part of a key leaks
    const message = String((explainNetworkError(err, []) as Error | undefined)?.message ?? err);
    const why = status !== undefined ? `HTTP ${status}` : redact(message, secrets).split('\n')[0]!.slice(0, 160);
    const retries = deps.retry?.retries ?? DEFAULT_RETRIES;
    // timeouts are capped at TIMEOUT_RETRIES whatever `retries` says
    const times = TIMEOUT_RETRIES === 1 ? 'once' : `${TIMEOUT_RETRIES} times`;
    const which = isTimeout(err) && TIMEOUT_RETRIES < retries
      ? `sending it again ${times} (a timed-out request is sent again ${times} at most)`
      : `retry ${attempt} of ${retries}`;
    log?.warn(`${sel.id} (${role}): ${why}; ${which} in ${(delayMs / 1000).toFixed(1)} s`);
  };
  return {
    ...deps,
    retry: { ...deps.retry, onRetry },
    fetch: fetchImpl,
    role,
    id: sel.id,
    cwd: opts.cwd,
    log,
    usage: opts.onUsage ? (u) => opts.onUsage!({ ...u, id: sel.id, role }) : undefined,
  };
}

/** Runs preflight checks (binaries, model files, local servers) once per provider and model. */
export async function preflight(sel: Selections, env: NodeJS.ProcessEnv, opts: CreateOptions): Promise<void> {
  const done = new Set<string>();
  for (const role of ['text', 'timing', 'llm'] as const) {
    const s = sel[role];
    if (s.same || done.has(s.id)) continue;
    done.add(s.id);
    const d = getProvider(s.provider);
    if (d) refuseUrlCredentials(d, env);
    if (!d?.preflight) continue;
    try {
      await d.preflight(env, s.model!, createDeps(role, s, env, opts));
    } catch (err) {
      // same redaction as createProvider
      throw redactError(explainNetworkError(err, endpointVars(d)), secretValues(d, env));
    }
  }
}

/** Node's fetch refuses URLs with credentials: fail early, naming only the variable. */
function refuseUrlCredentials(d: ProviderDescriptor, env: NodeJS.ProcessEnv): void {
  const [name] = credentialedEndpointVars(d, env);
  if (name) throw new UserError(`${name} contains a user name or password ("https://user:password@host"), which cannot be sent in a URL; remove it from ${name}.`);
}

/** Builds one role's provider without the redaction wrapper. */
function createRaw(role: Role, sel: ModelSpec, env: NodeJS.ProcessEnv, opts: CreateOptions): { d: ProviderDescriptor; p: AnyProvider } {
  const d = getProvider(sel.provider);
  if (!d) throw new UserError(`Unknown provider "${sel.provider}"; known: ${known()}.`);
  refuseUrlCredentials(d, env);
  const p = d.create(env, sel.model!, createDeps(role, sel, env, opts));
  if (!implementsRole(p, role)) throw new Error(`provider "${d.id}" returned no ${role} implementation`);
  return { d, p };
}

/** Builds one role's provider; its errors have the provider's secrets redacted. */
export function createProvider(role: Role, sel: ModelSpec, env: NodeJS.ProcessEnv, opts: CreateOptions): AnyProvider {
  const { d, p } = createRaw(role, sel, env, opts);
  return withRedaction(p, role, secretValues(d, env), endpointVars(d));
}

/**
 * Builds the three role providers; call resolveSelections, missingEnv and preflight first. `ready.text` replaces
 * `sel.text` (--text-file).
 */
export function createProviders(sel: Selections, env: NodeJS.ProcessEnv, opts: CreateOptions, ready: { text?: TextProvider } = {}): Providers {
  // shared instances (shareKey) stay unwrapped; each role wraps its own method
  const shared = new Map<string, AnyProvider>();
  const build = (role: Role, s: ModelSpec): AnyProvider => {
    const d = getProvider(s.provider);
    if (!d?.shareKey) return createProvider(role, s, env, opts);
    const key = `${s.provider}\0${d.shareKey(s.model!, createDeps(role, s, env, opts))}`;
    let p = shared.get(key);
    if (!p || !implementsRole(p, role)) {
      p = createRaw(role, s, env, opts).p;
      shared.set(key, p);
    }
    return withRedaction(p, role, secretValues(d, env), endpointVars(d));
  };
  const text = ready.text ?? (build('text', sel.text) as TextProvider);
  const timing: TimingProvider = sel.timing.same
    ? { id: sel.text.id, align: () => Promise.reject(new Error('--timing same: the timings come from the text stage, not from a timing call')) }
    : (build('timing', sel.timing) as TimingProvider);
  const llm = build('llm', sel.llm) as LlmProvider;
  return { text, timing, llm: withSchemaValidation(llm, opts.log) };
}
