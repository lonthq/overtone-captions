// Stage 5: corrections, speaker names, styling and line cutting (refine/llm-steps.ts). Each LLM request is cached by
// prompt, schema, effort and model; the checks run again on every run.
import { editReview } from '../review.js';
import { cachedLlm } from '../cache.js';
import type { EffortConfig, ResolvedProfile } from '../config.js';
import type { LlmProvider } from '../providers/types.js';
import { refine } from '../refine/llm-steps.js';
import { LATEST_RULESET } from '../segment/rulesets/index.js';
import { flattenTurns, groupTurns } from '../turns.js';
import type { MediaContext } from './editor.js';
import type { Run } from './run.js';
import type { AlignData, ExtractData, RefineData } from './types.js';

export interface RefineInput {
  aligned: AlignData;
  audio: ExtractData;
  llm: LlmProvider;
  effort: EffortConfig;
  context: MediaContext;
  profiles: ResolvedProfile[];
}

export async function refineStage(run: Run, { aligned, audio, llm, effort, context: { context, inferred, inferredTerms }, profiles }: RefineInput): Promise<RefineData> {
  const { cfg, log } = run;
  return run.stage<RefineData>('refine', async () => {
    const res = await refine(cachedLlm(llm, run.requests, 'refine'), flattenTurns(aligned.turns), {
      // an inferred topic is shown to the editor, but only the user's own context vouches for speaker labels
      ...(inferred ? { inferredContext: context } : { context }),
      glossary: cfg.glossary,
      ...(inferredTerms.length > 0 ? { inferredTerms } : {}),
      effort,
      llmLinebreaks: cfg.llmLinebreaks === true,
      style: cfg.style,
      language: aligned.language,
      pinnedSpeakers: cfg.speakers,
      edits: cfg.edits,
      styling: cfg.styling,
      profiles,
      ruleset: cfg.ruleset ?? LATEST_RULESET,
      duration: audio.duration,
      heard: aligned.heard,
      onRefusal: run.refused,
    }, log);
    for (const c of res.cutting) {
      log.info(c.rules
        ? `  ${c.profile}: lines cut by rules only (LLM line cutting off), ${c.blocks} speaker blocks`
        : `  ${c.profile}: ${c.fromProposal}/${c.blocks} speaker blocks cut as proposed by the LLM`);
    }
    return { speakers: res.speakers, turns: groupTurns(res.words), profiles: res.profiles, edits: res.edits, rejected: res.rejected.length, review: editReview(res.unsure) };
  });
}
