import { basename } from 'node:path';
import { FileTextProvider } from '../providers/file.js';
import { createProvider, createProviders, type CreateOptions, type Providers } from '../providers/registry.js';
import type { TimingProvider } from '../providers/types.js';
import { tokenizeDisplay } from '../text/normalize.js';
import { UsageMeter } from '../usage.js';
import type { Plan } from './preflight.js';
import type { PipelineDeps } from './types.js';

export interface ProviderSetup {
  providers: Providers;
  /** The second hearing's provider, when there is one. */
  secondTiming?: TimingProvider;
  /** Sums what the providers report (the `usage:` line). */
  meter: UsageMeter;
  /** How providers built later in the run (a per-language editor) are created. */
  createOpts: CreateOptions;
}

/** The role providers of the plan (or the ones the tests pass), wired to the usage meter. */
export function buildProviders(plan: Plan, deps: PipelineDeps, env: NodeJS.ProcessEnv): ProviderSetup {
  const { log } = deps;
  const { textFile, sel, secondSel } = plan;
  const meter = new UsageMeter();
  const createOpts: CreateOptions = {
    cwd: deps.cwd,
    log,
    deps: deps.providerDeps,
    onUsage: (r) => {
      meter.add(r);
      log.debug(`usage ${r.role} ${r.id}: ${JSON.stringify({ audioSeconds: r.audioSeconds, inputTokens: r.inputTokens, cachedInputTokens: r.cachedInputTokens, outputTokens: r.outputTokens, reasoningTokens: r.reasoningTokens })}`);
    },
  };
  const fileText = textFile ? new FileTextProvider(textFile) : undefined;
  const built = deps.providers ?? createProviders(sel, env, createOpts, { text: fileText });
  const providers: Providers = fileText ? { ...built, text: fileText } : built;
  const secondTiming: TimingProvider | undefined = deps.providers
    ? deps.providers.secondTiming
    : secondSel ? (createProvider('timing', secondSel, env, createOpts) as TimingProvider) : undefined;
  if (textFile) log.info(`  text: ${basename(textFile.path)} (${textFile.cues !== undefined ? `${textFile.cues} cues, ` : ''}${tokenizeDisplay(textFile.text).length} words; no text provider is called)`);
  return { providers, secondTiming, meter, createOpts };
}
