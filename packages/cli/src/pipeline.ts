// The pipeline (docs/cli/pipeline.md): preflight, then extract → transcribe → timing → align → refine → export. Each
// stage is a function in pipeline/; this file runs them in order and hands each the results it needs.
import { alignStage } from './pipeline/align.js';
import { chooseEditor, contextStep } from './pipeline/editor.js';
import { exportStage } from './pipeline/export.js';
import { extractStage } from './pipeline/extract.js';
import { preflight } from './pipeline/preflight.js';
import { buildProviders } from './pipeline/providers.js';
import { refineStage } from './pipeline/refine.js';
import { openRun } from './pipeline/run.js';
import { textBaseStep } from './pipeline/text-base.js';
import { sameTimingFrom, secondHearingOnce, timingStage } from './pipeline/timing.js';
import { textCalls, transcribeStage } from './pipeline/transcribe.js';
import { twoPassStep } from './pipeline/two-pass.js';
import type { PipelineConfig, PipelineDeps, PipelineResult } from './pipeline/types.js';
import { formatUsage } from './usage.js';

export { MAX_PROMPT_CHARS, textPrompt } from './pipeline/prompt.js';
export type { PipelineConfig, PipelineDeps, PipelineResult, TextRetry } from './pipeline/types.js';

/** Run every stage. Nothing before the extract stage calls an API. */
export async function runPipeline(media: string, cfg: PipelineConfig, deps: PipelineDeps): Promise<PipelineResult> {
  const env = deps.env ?? process.env;
  const plan = await preflight(media, cfg, deps, env);
  const { providers, secondTiming, meter, createOpts } = buildProviders(plan, deps, env);
  const run = await openRun(media, cfg, deps, env, meter);

  // 1 extract, 2 transcribe, 3 timing: the text and the engines' hearings
  const audio = await extractStage(run);
  const calls = textCalls(run, providers.text, audio, plan);
  // without --language the text waits for the language the second hearing detects
  const second = secondHearingOnce(run, secondTiming, audio, plan);
  const text = await transcribeStage(run, calls, second);
  const hearings = await timingStage(run, { plan, providers, secondTiming, second, audio, text });
  // the rest of the timing stage for --from-stage: the text base, the editor, the context and --two-pass
  const covered = await textBaseStep(run, { plan, calls, text, hearings, audio });
  const editor = await chooseEditor(run, plan, providers.llm, hearings.language, createOpts);
  const context = await contextStep(run, editor.llm, covered, hearings.language);
  const finalText = await twoPassStep(run, { plan, calls, covered, hearings, context });

  // 4 align, 5 refine, 6 export
  // --timing same: the words of the aligned pass are the timing hearing
  const heard = plan.sel.timing.same ? sameTimingFrom(hearings, { chunks: covered.chunks }, finalText) : hearings;
  const aligned = await alignStage(run, { plan, providers, secondTiming, audio, calls, hearings: heard, covered, finalText, llm: editor.llm, context });
  const refined = await refineStage(run, { aligned, audio, llm: editor.llm, effort: editor.effort, context, profiles: plan.profiles });
  const { doc, written, summary, review } = await exportStage(run, { plan, audio, hearings, covered, aligned, refined, editor, context });
  const usage = meter.list();
  return { doc, written, summary, rejected: refined.rejected, review, usage, usageLine: formatUsage(usage), refusals: run.refusals };
}
