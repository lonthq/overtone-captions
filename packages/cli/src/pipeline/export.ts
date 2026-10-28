// Stage 6 (never cached): the Overtone document, the caption files and, for `--export mp4`, the burned-in video.
import { dirname, join } from 'node:path';
import { assertValid, FORMAT_NAME, FORMAT_VERSION, roundTime, type OvertoneDocument } from 'overtone-format';
import { burn } from '../burn/index.js';
import { STAGES } from '../config.js';
import { UserError } from '../errors.js';
import { baseName, writeOutputs } from '../output.js';
import { runInputs } from './preflight.js';
import { LATEST_RULESET, layoutMeta } from '../segment/rulesets/index.js';
import { voteReview, type ReviewItem } from '../review.js';
import { formatSummary } from '../summary.js';
import type { Editor, MediaContext } from './editor.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import type { Hearings } from './timing.js';
import type { AlignData, CoverageData, ExtractData, RefineData } from './types.js';

export interface ExportInput {
  plan: Pick<Plan, 'sel' | 'wantsMp4' | 'profiles'>;
  audio: ExtractData;
  hearings: Hearings;
  covered: CoverageData;
  aligned: AlignData;
  refined: RefineData;
  editor: Editor;
  context: MediaContext;
}

export async function exportStage(run: Run, input: ExportInput): Promise<{ doc: OvertoneDocument; written: string[]; summary: string; review: ReviewItem[] }> {
  const { cfg, deps, log, media } = run;
  const { plan, refined, aligned } = input;
  log.info(`[${STAGES.length}/${STAGES.length}] export …`);
  const review = [...refined.review, ...voteReview(aligned.textVotes ?? [])].sort((a, b) => a.start - b.start);
  const doc = buildDocument(run, input, review);
  const outDir = cfg.outDir ?? dirname(media);
  const written = await writeOutputs(doc, {
    base: baseName(media),
    outDir,
    formats: cfg.exports,
    profiles: plan.profiles.map((p) => p.id),
    ...(cfg.markUncertain ? { markUncertain: true } : {}),
    protect: runInputs(media, cfg),
  });
  if (plan.wantsMp4) {
    const burned = await (deps.burn ?? burn)(media, doc, { cwd: deps.cwd, ...cfg.burn, output: join(outDir, `${baseName(media)}.captioned.mp4`) }, log).catch((err: unknown) => {
      // the other files are already written; say where, since the final list is not printed
      if (err instanceof UserError && written.length > 0) throw new UserError(`${err.message}\nWritten before the MP4 failed: ${written.join(', ')}`);
      throw err;
    });
    written.push(burned);
  }
  const summary = formatSummary({
    words: doc.turns.flatMap((t) => t.words),
    edits: refined.edits.length,
    rejected: refined.rejected,
    review: review.length,
    speakers: doc.speakers.length,
    profiles: doc.profiles,
  });
  return { doc, written, summary, review };
}

/** The document, checked against the format (`meta` keys in a fixed order). */
function buildDocument(run: Run, { plan: { sel }, audio, hearings: { languagesHeard, engines }, covered, aligned, refined, editor, context: { context } }: ExportInput, review: readonly ReviewItem[]): OvertoneDocument {
  const { cfg, deps } = run;
  const fallbacks = covered.fallbacks;
  const lastEnd = refined.turns.at(-1)?.end ?? 0;
  return assertValid({
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    language: aligned.language,
    duration: roundTime(Math.max(audio.duration, lastEnd)),
    speakers: refined.speakers,
    turns: refined.turns,
    profiles: refined.profiles,
    edits: refined.edits,
    meta: {
      ...(context ? { context, contextSource: cfg.context ? 'user' : 'inferred' } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
      ...(covered.retries && covered.retries.length > 0 ? { textRetries: covered.retries } : {}),
      ...(aligned.timingRetries && aligned.timingRetries.length > 0 ? { timingRetries: aligned.timingRetries } : {}),
      ...(aligned.textVotes && aligned.textVotes.some((v) => v.result !== 'kept') ? { textVotes: aligned.textVotes.filter((v) => v.result !== 'kept') } : {}),
      ...(review.length > 0 ? { review } : {}),
      ...(run.refusals.length > 0 ? { refusals: run.refusals.map((r) => ({ ...r, start: roundTime(r.start), end: roundTime(r.end) })) } : {}),
      ...(languagesHeard ? { languagesHeard } : {}),
      style: cfg.style,
      linebreaks: cfg.llmLinebreaks === true ? 'llm' : 'rules',
      ...layoutMeta(cfg.ruleset ?? LATEST_RULESET, aligned.language),
      models: { text: sel.text.id, timing: sel.timing.id, llm: editor.llmSel.id, ...(engines[1] ? { second: engines[1].id } : {}) },
      generator: run.generator,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
  } satisfies OvertoneDocument);
}
