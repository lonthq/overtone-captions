// Once the language is known: its editor (LLM) and effort, and the media's context (the user's, else inferred). Both
// are part of the timing stage for --from-stage.
import { cachedLlm } from '../cache.js';
import { languageDefaultsFor, type EffortConfig, type ModelSpec } from '../config.js';
import { createProvider, missingEnv, missingEnvError, preflight, resolveSelection, type CreateOptions } from '../providers/registry.js';
import { withSchemaValidation } from '../providers/structured.js';
import type { LlmProvider } from '../providers/types.js';
import { inferContext, type InferredContext } from '../refine/context.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import type { TranscribeData } from './types.js';

export interface Editor {
  llm: LlmProvider;
  /** The LLM's selection (`meta.models.llm`). */
  llmSel: ModelSpec;
  effort: EffortConfig;
}

/** The language's editor (`languages.<code>.llm`) unless --llm was given, and its effort. */
export async function chooseEditor(run: Run, plan: Pick<Plan, 'forced' | 'upfront' | 'sel'>, llm: LlmProvider, known: string | undefined, createOpts: CreateOptions): Promise<Editor> {
  const { cfg, deps, env, log } = run;
  const { forced, upfront, sel } = plan;
  const byLanguage = forced ? upfront : languageDefaultsFor(cfg, known);
  let llmSel = sel.llm;
  if (!forced && byLanguage?.llm && !cfg.explicit.llm) {
    const want = resolveSelection(byLanguage.llm, 'llm');
    if (want.id !== sel.llm.id) {
      if (deps.createLlm) llm = deps.createLlm(want);
      else {
        const missing = missingEnv([want], env);
        if (missing.length > 0) throw missingEnvError(missing, `the ${known} editor (languages.${known}.llm)`);
        await preflight({ ...sel, llm: want, timing: { ...sel.timing, same: true }, text: { ...sel.text, same: true } }, env, createOpts);
        llm = withSchemaValidation(createProvider('llm', want, env, createOpts) as LlmProvider, log);
      }
      llmSel = want;
      log.info(`  editor for ${known}: ${want.id} (languages.${known}.llm)`);
    }
  }
  return { llm, llmSel, effort: { ...cfg.effort, ...byLanguage?.effort } };
}

export interface MediaContext {
  /** The user's context, else the inferred topic. */
  context?: string;
  inferred?: InferredContext;
  /** The inferred names and terms, without duplicates. */
  inferredTerms: string[];
}

/** The context: the user's, else inferred from the transcript (one short LLM call). */
export async function contextStep(run: Run, llm: LlmProvider, covered: TranscribeData, known: string | undefined): Promise<MediaContext> {
  const { cfg, log, requests } = run;
  const transcript = covered.chunks.map((c) => c.text).join(' ').trim();
  let context = cfg.context;
  let inferred: InferredContext | undefined;
  if (!context && cfg.inferContext && transcript) {
    const before = { ...requests.counts };
    inferred = await run.step('timing', 'context', () => inferContext(cachedLlm(llm, requests, 'timing'), transcript, { language: known, log, refused: { onRefusal: run.refused, duration: covered.chunks.at(-1)?.end ?? 0 } }));
    const cached = requests.counts.cached > before.cached && requests.counts.sent === before.sent;
    if (inferred) {
      context = inferred.topic;
      log.info(`  context (inferred${cached ? ', cached' : ''}): ${inferred.topic}`);
      const hints = [...inferred.names, ...inferred.terms];
      if (hints.length > 0) log.info(`  names and terms (inferred): ${hints.join(', ')}`);
    }
  }
  const inferredTerms = inferred ? [...new Set([...inferred.names, ...inferred.terms])] : [];
  return { context, inferred, inferredTerms };
}
